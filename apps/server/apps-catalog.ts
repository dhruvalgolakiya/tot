import type { AppCatalogItem, AppConnectPoll, AppConnectStep, AppKeyField, AppRule } from "@tot/shared/types";
import { appMeta, apps, appsChanged, executor, ExecutorError, list, setAppMeta } from "./apps.ts";
import { EXECUTOR_PORT } from "./config.ts";

/**
 * TOT's own app catalog and connect flows, on top of Executor's API: browse the
 * public integrations.sh directory (what Executor's UI uses), add an app to
 * Executor, connect an account (one-click sign-in, the user's own OAuth app for
 * Google and the like, an API key, or nothing), and set per-action approval rules.
 * Executor's token never leaves the server.
 */

export class AppsError extends Error {}

const DIRECTORY = "https://integrations.sh";
/** The client-id document Executor's own UI uses for one-click sign-ins (Linear, Notion…). */
const CIMD_CLIENT_ID = "https://executor.sh/api/oauth/client-id-metadata/local.json";
const OWNER = "org";
const CONNECTION_NAME = "main";
const SIGN_IN_TIMEOUT_MS = 15 * 60_000;
const SEARCH_CACHE_MS = 60_000;

interface Surface {
  kind: "mcp" | "openapi" | "graphql";
  slug: string;
  url: string;
  auth?: { kind?: string };
  icon?: string;
}

interface DirectoryApp {
  appId: string;
  name: string;
  description: string;
  iconUrl: string | null;
  domain: string;
  surface: Surface;
}

interface AuthMethod {
  template: string;
  kind: "oauth" | "apikey" | "none" | string;
  label?: string;
  oauth?: { discoveryUrl?: string; authorizationUrl?: string; tokenUrl?: string; scopes?: string[] };
  placements?: { carrier?: string; name?: string; prefix?: string; variable?: string }[];
}

/** Everything seen in the directory, by appId, so "connect" can add what the user picked. */
const known = new Map<string, DirectoryApp>();
const searches = new Map<string, { at: number; apps: DirectoryApp[] }>();
const flows = new Map<string, { state: AppConnectPoll; abort: AbortController; startedAt: number }>();

const slugOf = (surfaceSlug: string) => surfaceSlug.replace(/[^A-Za-z0-9_]/g, "_").toLowerCase();

/** "canva.com" → "Canva" when the directory only has the domain as a name. */
function displayName(name: string, domain: string): string {
  if (name && name !== domain) return name;
  const label = domain.replace(/^(www|api|mcp)\./, "").split(".")[0] ?? domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** The best way in: a remote MCP server (made for agents), else a REST API, else GraphQL. */
function pickSurface(surfaces: unknown): Surface | null {
  const usable = (Array.isArray(surfaces) ? surfaces : []).filter(
    (s): s is Surface => Boolean(s?.url) && ["mcp", "openapi", "graphql"].includes(s?.kind),
  );
  return usable.find((s) => s.kind === "mcp") ?? usable.find((s) => s.kind === "openapi") ?? usable.find((s) => s.kind === "graphql") ?? null;
}

/** Google's and Microsoft's REST APIs sign in with the user's own OAuth app (one per provider, reused). */
function ownClientProvider(app: DirectoryApp): "google" | "microsoft" | null {
  if (app.surface.kind === "mcp") return null;
  const where = `${app.domain} ${app.surface.slug} ${app.surface.url}`;
  if (/google|gmail|youtube|googleapis/.test(where)) return "google";
  if (/microsoft|outlook|office|live\.com|graph\.microsoft/.test(where)) return "microsoft";
  return null;
}

function hintFor(app: DirectoryApp, clients: Set<string> = new Set()): AppCatalogItem["connect"] {
  const kind = app.surface.auth?.kind;
  const provider = ownClientProvider(app);
  if (provider) return clients.has(provider) ? "sign-in" : "client";
  if (kind === "oauth") return "sign-in";
  if (kind === "api_key" || kind === "apikey" || kind === "bearer") return "key";
  if (kind === "none") return "none";
  return "unknown";
}

async function searchDirectory(query: string): Promise<DirectoryApp[]> {
  const cached = searches.get(query);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_MS) return cached.apps;
  let rows: Record<string, unknown>[];
  try {
    const res = await fetch(`${DIRECTORY}/api/search?q=${encodeURIComponent(query)}&limit=60`, { signal: AbortSignal.timeout(10_000) });
    rows = ((await res.json()) as { results?: Record<string, unknown>[] }).results ?? [];
  } catch {
    throw new AppsError("Couldn't reach the app directory (integrations.sh). Check your connection and try again.");
  }
  const found: DirectoryApp[] = [];
  for (const row of rows) {
    const surface = pickSurface(row.surfaces);
    const domain = String(row.domain ?? "");
    if (!surface || !domain) continue;
    const app: DirectoryApp = {
      appId: slugOf(surface.slug),
      name: displayName(String(row.name ?? ""), domain),
      description: String(row.description ?? "").trim(),
      iconUrl: surface.icon ?? `${DIRECTORY}/logo/${domain}?sz=64`,
      domain,
      surface,
    };
    known.set(app.appId, app);
    found.push(app);
  }
  searches.set(query, { at: Date.now(), apps: found });
  return found;
}

/** Added apps (Executor integrations) with their account counts. */
async function added(): Promise<{ apps: Map<string, { name: string; description: string }>; accounts: Map<string, number> }> {
  const [integrations, connections] = await Promise.all([executor<unknown>("GET", "/integrations"), executor<unknown>("GET", "/connections")]);
  const appsById = new Map(
    list(integrations)
      .filter((i) => i.kind !== "built-in" && i.slug !== "executor")
      .map((i) => [String(i.slug), { name: String(i.name ?? i.slug), description: String(i.description ?? "") }]),
  );
  const accounts = new Map<string, number>();
  for (const c of list(connections)) accounts.set(String(c.integration), (accounts.get(String(c.integration)) ?? 0) + 1);
  return { apps: appsById, accounts };
}

/** Executor's own sign-in callback; providers that need the user's OAuth app must list it exactly. */
const redirectUri = () => `http://localhost:${EXECUTOR_PORT}/api/oauth/callback`;

async function integration(appId: string): Promise<{ slug: string; name: string; authMethods: AuthMethod[] } | null> {
  try {
    const found = await executor<Record<string, unknown>>("GET", `/integrations/${encodeURIComponent(appId)}`);
    return { slug: appId, name: String(found.name ?? appId), authMethods: (found.authMethods as AuthMethod[]) ?? [] };
  } catch (err) {
    if (err instanceof ExecutorError && err.status === 404) return null;
    throw err;
  }
}

/** Adds a directory app to Executor. */
async function addToExecutor(app: DirectoryApp): Promise<void> {
  const { surface } = app;
  try {
    if (surface.kind === "mcp") {
      const probe = await executor<{ requiresOAuth?: boolean; requiresAuthentication?: boolean }>("POST", "/mcp/probe", { endpoint: surface.url }, 30_000);
      const authenticationTemplate = probe.requiresOAuth
        ? [{ kind: "oauth2" }]
        : probe.requiresAuthentication
          ? [{ type: "apiKey", label: "API key", headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] } }]
          : [{ kind: "none" }];
      await executor("POST", "/mcp/servers", { transport: "remote", name: app.name, endpoint: surface.url, slug: app.appId, authenticationTemplate }, 30_000);
    } else if (surface.kind === "openapi") {
      await executor("POST", "/openapi/specs", { spec: { kind: "url", url: surface.url }, slug: app.appId, name: app.name, displayDomain: app.domain }, 60_000);
    } else {
      await executor("POST", "/graphql/integrations", { endpoint: surface.url, slug: app.appId, name: app.name }, 30_000);
    }
  } catch (err) {
    if (!(err instanceof ExecutorError && err.status === 409)) throw err;
  }
  setAppMeta(app.appId, { ...appMeta()[app.appId], iconUrl: app.iconUrl, domain: app.domain });
}

/** One input per distinct variable of an API-key method. */
function keyFields(method: AuthMethod): AppKeyField[] {
  const fields = new Map<string, AppKeyField>();
  for (const placement of method.placements ?? []) {
    const name = placement.variable || "token";
    if (fields.has(name)) continue;
    const label = placement.name && placement.name.toLowerCase() !== "authorization" ? placement.name : method.label || "API key";
    fields.set(name, { name, label, ...(placement.prefix ? { prefix: placement.prefix } : {}) });
  }
  return fields.size ? [...fields.values()] : [{ name: "token", label: method.label || "API key" }];
}

function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
}

/** Waits (server-side) for Executor to report how a sign-in ended. */
function followSignIn(state: string): void {
  const abort = new AbortController();
  const flow = { state: { state: "pending" } as AppConnectPoll, abort, startedAt: Date.now() };
  flows.set(state, flow);
  void (async () => {
    while (!abort.signal.aborted && Date.now() - flow.startedAt < SIGN_IN_TIMEOUT_MS) {
      let result: { ok?: boolean; error?: string; errorDetails?: string } | null = null;
      try {
        result = await executor("GET", `/oauth/await/${encodeURIComponent(state)}`, undefined, 30_000);
      } catch (err) {
        if (abort.signal.aborted) return;
        // The long-poll may time out on our side; anything else is worth a short pause.
        if (!(err instanceof Error && err.name === "TimeoutError")) await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      if (!result) continue;
      flow.state = result.ok
        ? { state: "connected" }
        : { state: "failed", error: [result.error, result.errorDetails].filter(Boolean).join(": ") || "The sign-in didn't finish." };
      if (result.ok) appsChanged();
      return;
    }
    if (flow.state.state === "pending") flow.state = { state: "failed", error: "The sign-in timed out. Try again." };
  })();
  // Forget finished flows after a while.
  setTimeout(() => flows.delete(state), SIGN_IN_TIMEOUT_MS + 10 * 60_000).unref();
}

/** The app's existing account, if any (TOT keeps one per app). */
async function existingAccount(slug: string): Promise<{ owner: string; name: string } | null> {
  const found = list(await executor<unknown>("GET", `/connections?integration=${encodeURIComponent(slug)}`))[0];
  return found ? { owner: String(found.owner), name: String(found.name) } : null;
}

/** Starts a sign-in; for an app that's already connected it renews that account instead of adding another. */
async function startSignIn(slug: string, method: AuthMethod, client: string): Promise<AppConnectStep> {
  const account = await existingAccount(slug);
  const started = await executor<{ status: string; authorizationUrl?: string; state?: string }>("POST", "/oauth/start", {
    client,
    clientOwner: OWNER,
    owner: account?.owner ?? OWNER,
    name: account?.name ?? CONNECTION_NAME,
    integration: slug,
    template: method.template,
    ...(account ? {} : { newConnection: true }),
  });
  if (!started.authorizationUrl || !started.state) throw new AppsError("The sign-in couldn't start. Try again in a moment.");
  followSignIn(started.state);
  return { step: "sign-in", flowId: started.state, url: started.authorizationUrl };
}

async function existingClient(match: (client: Record<string, unknown>) => boolean): Promise<string | null> {
  const clients = list(await executor<unknown>("GET", "/oauth/clients"));
  const found = clients.find(match);
  return found ? String(found.slug ?? found.client ?? found.id) : null;
}

/** Providers whose sign-in needs the user's own OAuth app, and where to make one. */
function providerOf(authorizationUrl: string | undefined, fallback: string): { name: string; consoleUrl: string | null; clientSlug: string } {
  const host = hostOf(authorizationUrl);
  if (host.endsWith("google.com")) return { name: "Google", consoleUrl: "https://console.cloud.google.com/apis/credentials", clientSlug: "google" };
  if (host.endsWith("microsoftonline.com") || host.endsWith("microsoft.com"))
    return { name: "Microsoft", consoleUrl: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade", clientSlug: "microsoft" };
  return { name: fallback, consoleUrl: null, clientSlug: "" };
}

export const appsCatalog = {
  /** Directory apps for a search (popular ones when empty), added apps first; each with its account count. */
  async catalog(query: string): Promise<AppCatalogItem[]> {
    const q = query.trim();
    const [directory, mine, clientList] = await Promise.all([
      searchDirectory(q),
      apps.running ? added() : Promise.resolve(null),
      apps.running ? executor<unknown>("GET", "/oauth/clients").catch(() => []) : Promise.resolve([]),
    ]);
    // Providers whose OAuth app the user already saved: their apps are one click now.
    const clients = new Set(list(clientList).map((c) => String(c.slug)));
    const meta = appMeta();
    const items: AppCatalogItem[] = [];
    const seen = new Set<string>();
    if (mine && !q) {
      for (const [appId, info] of mine.apps) {
        const fromDirectory = known.get(appId);
        items.push({
          appId,
          name: fromDirectory?.name ?? info.name,
          description: fromDirectory?.description ?? info.description,
          iconUrl: meta[appId]?.iconUrl ?? fromDirectory?.iconUrl ?? null,
          connect: fromDirectory ? hintFor(fromDirectory, clients) : "unknown",
          accounts: mine.accounts.get(appId) ?? 0,
        });
        seen.add(appId);
      }
    }
    for (const app of directory) {
      if (seen.has(app.appId)) continue;
      seen.add(app.appId);
      items.push({
        appId: app.appId,
        name: app.name,
        description: app.description,
        iconUrl: app.iconUrl,
        connect: hintFor(app, clients),
        accounts: mine?.accounts.get(app.appId) ?? 0,
      });
    }
    return items;
  },

  /** The next step to connect an app: add it if needed, then sign in, ask for a key, or finish. */
  async connect(appId: string, values?: Record<string, string>): Promise<AppConnectStep> {
    if (!apps.running) throw new AppsError("Turn on Apps first.");
    let found = await integration(appId);
    if (!found) {
      const app = known.get(appId);
      if (!app) throw new AppsError("That app isn't in the list anymore. Search for it again.");
      await addToExecutor(app);
      found = await integration(appId);
      if (!found) throw new AppsError("The app couldn't be added. Try again.");
    }
    const methods = found.authMethods;
    const oauth = methods.find((m) => m.kind === "oauth");
    const apikey = methods.find((m) => m.kind === "apikey");
    const none = methods.find((m) => m.kind === "none");

    if (values) {
      if (!apikey) throw new AppsError(`${found.name} doesn't use an API key.`);
      const fields = keyFields(apikey);
      const missing = fields.find((field) => !values[field.name]?.trim());
      if (missing) throw new AppsError(`Fill in ${missing.label}.`);
      const cleaned = Object.fromEntries(fields.map((field) => [field.name, values[field.name]!.trim()]));
      // A new key replaces the old one.
      const account = await existingAccount(appId);
      if (account) {
        await executor("DELETE", `/connections/${encodeURIComponent(account.owner)}/${encodeURIComponent(appId)}/${encodeURIComponent(account.name)}`);
      }
      await executor("POST", "/connections", { owner: OWNER, name: CONNECTION_NAME, integration: appId, template: apikey.template, values: cleaned });
      appsChanged();
      return { step: "connected", status: await apps.status() };
    }

    if (oauth) {
      const discovery = oauth.oauth?.discoveryUrl;
      if (discovery) {
        const probe = await executor<{
          authorizationUrl?: string;
          tokenUrl?: string;
          resource?: string;
          scopesSupported?: string[];
          registrationEndpoint?: string | null;
          clientIdMetadataDocumentSupported?: boolean;
          issuer?: string;
          tokenEndpointAuthMethodsSupported?: string[];
        }>("POST", "/oauth/probe", { url: discovery }, 30_000);
        let client: string | null = null;
        if (probe.clientIdMetadataDocumentSupported) {
          client =
            (await existingClient((c) => c.clientId === CIMD_CLIENT_ID && c.authorizationUrl === probe.authorizationUrl)) ??
            (
              await executor<{ client: string }>("POST", "/oauth/clients", {
                owner: OWNER,
                slug: `${appId}-signin`,
                authorizationUrl: probe.authorizationUrl,
                tokenUrl: probe.tokenUrl,
                resource: probe.resource,
                grant: "authorization_code",
                clientId: CIMD_CLIENT_ID,
                clientSecret: "",
              })
            ).client;
        } else if (probe.registrationEndpoint) {
          client = (
            await executor<{ client: string }>("POST", "/oauth/clients/register-dynamic", {
              owner: OWNER,
              issuer: probe.issuer,
              registrationEndpoint: probe.registrationEndpoint,
              authorizationUrl: probe.authorizationUrl,
              tokenUrl: probe.tokenUrl,
              resource: probe.resource,
              scopes: probe.scopesSupported,
              tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
              clientName: "TOT",
              originIntegration: appId,
            })
          ).client;
        }
        if (client) {
          setAppMeta(appId, { ...(appMeta()[appId] ?? { iconUrl: null, domain: null }), ownClient: client });
          return startSignIn(appId, oauth, client);
        }
        const provider = providerOf(probe.authorizationUrl, found.name);
        return { step: "client", provider: provider.name, redirectUri: redirectUri(), consoleUrl: provider.consoleUrl };
      }
      // A REST API with OAuth (Google, Microsoft…): reuse the user's OAuth app for that provider when there is one.
      const provider = providerOf(oauth.oauth?.authorizationUrl, found.name);
      const host = hostOf(oauth.oauth?.authorizationUrl);
      const client = await existingClient(
        (c) => (provider.clientSlug && c.slug === provider.clientSlug) || (Boolean(host) && hostOf(String(c.authorizationUrl ?? "")) === host),
      );
      if (client) return startSignIn(appId, oauth, client);
      return { step: "client", provider: provider.name, redirectUri: redirectUri(), consoleUrl: provider.consoleUrl };
    }

    if (apikey) {
      const app = known.get(appId);
      return {
        step: "key",
        fields: keyFields(apikey),
        help: app ? { label: `Find your ${found.name} API key`, url: `${DIRECTORY}/${app.domain}/` } : null,
      };
    }

    if (!(await existingAccount(appId))) {
      await executor("POST", "/connections", {
        owner: OWNER,
        name: CONNECTION_NAME,
        integration: appId,
        template: none?.template ?? "none",
        values: { token: "" },
      });
    }
    appsChanged();
    return { step: "connected", status: await apps.status() };
  },

  poll(flowId: string): AppConnectPoll {
    return flows.get(flowId)?.state ?? { state: "failed", error: "This sign-in isn't running anymore. Try again." };
  },

  async cancel(flowId: string): Promise<void> {
    const flow = flows.get(flowId);
    flow?.abort.abort();
    flows.delete(flowId);
    await executor("POST", "/oauth/cancel", { state: flowId }).catch(() => {});
  },

  /** Saves the user's own OAuth app for this app's provider (e.g. one Google client for Gmail, Calendar, Drive). */
  async saveClient(appId: string, clientId: string, clientSecret: string): Promise<void> {
    if (!clientId.trim() || !clientSecret.trim()) throw new AppsError("Paste both the client ID and the client secret.");
    const found = await integration(appId);
    if (!found) throw new AppsError("Add the app first.");
    const oauth = found.authMethods.find((m) => m.kind === "oauth");
    let authorizationUrl = oauth?.oauth?.authorizationUrl;
    let tokenUrl = oauth?.oauth?.tokenUrl;
    let resource: string | undefined;
    if (!authorizationUrl && oauth?.oauth?.discoveryUrl) {
      const probe = await executor<{ authorizationUrl?: string; tokenUrl?: string; resource?: string }>("POST", "/oauth/probe", {
        url: oauth.oauth.discoveryUrl,
      });
      ({ authorizationUrl, tokenUrl, resource } = probe);
    }
    if (!authorizationUrl || !tokenUrl) throw new AppsError(`${found.name} doesn't sign in with OAuth.`);
    const provider = providerOf(authorizationUrl, found.name);
    const slug = provider.clientSlug || `${appId}-client`;
    await executor("DELETE", `/oauth/clients/${encodeURIComponent(slug)}`, { owner: OWNER }).catch(() => {});
    await executor("POST", "/oauth/clients", {
      owner: OWNER,
      slug,
      authorizationUrl,
      tokenUrl,
      ...(resource ? { resource } : {}),
      grant: "authorization_code",
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      originIntegration: appId,
    });
    if (!provider.clientSlug) setAppMeta(appId, { ...(appMeta()[appId] ?? { iconUrl: null, domain: null }), ownClient: slug });
  },

  /** Removes an app: its accounts, its rules, and a sign-in client made just for it. */
  async remove(appId: string): Promise<void> {
    const connections = list(await executor<unknown>("GET", `/connections?integration=${encodeURIComponent(appId)}`));
    for (const c of connections) {
      await executor("DELETE", `/connections/${encodeURIComponent(String(c.owner))}/${encodeURIComponent(appId)}/${encodeURIComponent(String(c.name))}`);
    }
    await executor("DELETE", `/integrations/${encodeURIComponent(appId)}`);
    for (const policy of list(await executor<unknown>("GET", "/policies"))) {
      if (String(policy.pattern).startsWith(`${appId}.`)) {
        await executor("DELETE", `/policies/${encodeURIComponent(String(policy.id))}`, { owner: policy.owner }).catch(() => {});
      }
    }
    const own = appMeta()[appId]?.ownClient;
    if (own) await executor("DELETE", `/oauth/clients/${encodeURIComponent(own)}`, { owner: OWNER }).catch(() => {});
    setAppMeta(appId, null);
    appsChanged();
  },

  /** The whole app first, then each action, with the rule that applies to it. */
  async rules(appId: string): Promise<AppRule[]> {
    const [tools, policies] = await Promise.all([
      executor<unknown>("GET", `/tools?integration=${encodeURIComponent(appId)}`),
      executor<unknown>("GET", "/policies"),
    ]);
    const ordered = list(policies)
      .map((p) => ({ id: String(p.id), owner: String(p.owner), pattern: String(p.pattern), action: p.action as AppRule["action"], position: String(p.position ?? "") }))
      .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    const whole = ordered.find((p) => p.pattern === `${appId}.*`);
    const rules: AppRule[] = [
      {
        tool: "*",
        description: whole ? "A rule for every action in this app." : "By default, reading runs on its own and actions that change things ask you first.",
        action: whole?.action ?? "require_approval",
        isDefault: !whole,
      },
    ];
    const seen = new Set<string>();
    for (const t of list(tools)) {
      const id = String(t.address ?? "").replace(/^tools\./, "");
      const tool = id.split(".").slice(3).join(".");
      if (!tool || seen.has(tool)) continue;
      seen.add(tool);
      const applied = effective(id, ordered);
      rules.push({
        tool,
        description: String(t.description ?? t.approvalDescription ?? "").split("\n")[0]!.slice(0, 200),
        action: applied ?? (t.requiresApproval ? "require_approval" : "approve"),
        isDefault: applied === null,
      });
    }
    return rules;
  },

  async setRule(appId: string, tool: string, action: AppRule["action"] | "default"): Promise<AppRule[]> {
    if (!/^[\w.*-]+$/.test(tool)) throw new AppsError("Unknown action.");
    const pattern = tool === "*" ? `${appId}.*` : `${appId}.*.*.${tool}`;
    const existing = list(await executor<unknown>("GET", "/policies")).find((p) => p.pattern === pattern && p.owner === OWNER);
    if (action === "default") {
      if (existing) await executor("DELETE", `/policies/${encodeURIComponent(String(existing.id))}`, { owner: OWNER });
    } else if (existing) {
      await executor("PATCH", `/policies/${encodeURIComponent(String(existing.id))}`, { owner: OWNER, action });
    } else {
      await executor("POST", "/policies", { owner: OWNER, pattern, action });
    }
    return appsCatalog.rules(appId);
  },
};

/** Executor's policy matching: "*" everything, a trailing ".*" a prefix, a middle "*" one segment. */
function matches(pattern: string, id: string): boolean {
  if (pattern === "*") return true;
  const parts = pattern.split(".");
  const segments = id.split(".");
  if (parts.at(-1) === "*" && parts.length - 1 <= segments.length) {
    return parts.slice(0, -1).every((part, i) => part === "*" || part === segments[i]);
  }
  return parts.length === segments.length && parts.every((part, i) => part === "*" || part === segments[i]);
}

const STRICTNESS: Record<AppRule["action"], number> = { approve: 0, require_approval: 1, block: 2 };

/** The rule that applies: first match per owner (by position), most restrictive across owners; null = default. */
function effective(id: string, policies: { owner: string; pattern: string; action: AppRule["action"] }[]): AppRule["action"] | null {
  const perOwner = new Map<string, AppRule["action"]>();
  for (const policy of policies) {
    if (!perOwner.has(policy.owner) && matches(policy.pattern, id)) perOwner.set(policy.owner, policy.action);
  }
  let strictest: AppRule["action"] | null = null;
  for (const action of perOwner.values()) if (!strictest || STRICTNESS[action] > STRICTNESS[strictest]) strictest = action;
  return strictest;
}
