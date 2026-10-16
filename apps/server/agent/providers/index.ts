import type { AccountStatus, ModelOption, ProviderId, ProviderStatus } from "@tot/shared/types";
import { accountDir, accounts, dirExists, tildePath } from "../../accounts/accounts.ts";
import { claudeAuthEnv, claudeMcpServers, claudePlugins, claudeSettingsEnv, codexMcpServerNames } from "../../accounts/config.ts";
import { limits } from "../limits.ts";
import { chatgptProvider, makeChatgptProvider, stopCodexAccount } from "./chatgpt.ts";
import { claudeProvider, makeClaudeProvider } from "./claude.ts";
import type { AgentProvider } from "./types.ts";

/** The built-in accounts' providers (tests swap in fakes here). */
export const providers: Record<ProviderId, AgentProvider> = {
  claude: claudeProvider,
  chatgpt: chatgptProvider,
};

// Other accounts' providers, made on first use; tests can put fakes in `accountProviders`.
const made = new Map<string, AgentProvider>();
const fakes = new Map<string, AgentProvider>();

/** The provider that runs turns on an account: the built-in ones from `providers`, others made per account. */
export function providerFor(accountId: string): AgentProvider {
  if (accountId === "claude" || accountId === "chatgpt") return providers[accountId];
  const fake = fakes.get(accountId);
  if (fake) return fake;
  let provider = made.get(accountId);
  if (!provider) {
    const driver = accounts.driverOf(accountId);
    if (!driver) throw new Error("That account doesn't exist any more. Pick another model.");
    provider = driver === "claude" ? makeClaudeProvider(accountId) : makeChatgptProvider(accountId);
    made.set(accountId, provider);
  }
  return provider;
}

export const accountProviders = {
  /** Tests: a fake provider for an account (null removes it). */
  use(accountId: string, provider: AgentProvider | null): void {
    if (provider) fakes.set(accountId, provider);
    else fakes.delete(accountId);
  },
};

// A ChatGPT account whose folder or CLI changed (or that was removed) needs a fresh app-server: the running one
// signed in and read its config from the old folder.
const lastSeen = new Map<string, string>();
const signature = (id: string) => {
  const account = accounts.get(id);
  return account ? JSON.stringify([account.configDir, account.binaryPath]) : "";
};
for (const account of accounts.list()) lastSeen.set(account.id, signature(account.id));
accounts.onChange(() => {
  const ids = new Set([...lastSeen.keys(), ...accounts.list().map((a) => a.id)]);
  for (const id of ids) {
    const now = signature(id);
    if (lastSeen.get(id) !== now && id !== "chatgpt" && accounts.driverOf(id) !== "claude") void stopCodexAccount(id);
    if (!now) made.delete(id);
    lastSeen.set(id, now);
  }
  cached = null;
  accountCache = null;
});

const STATUS_TTL_MS = 30_000;
let cached: { at: number; statuses: Promise<ProviderStatus[]> } | null = null;

function failedStatus(provider: AgentProvider, accountId: string, err: unknown): ProviderStatus {
  return {
    id: provider.id,
    accountId,
    label: provider.label,
    installed: false,
    loggedIn: false,
    detail: `Couldn't check ${provider.label}: ${err instanceof Error ? err.message : String(err)}`,
    models: [],
  };
}

async function loadStatuses(): Promise<ProviderStatus[]> {
  return Promise.all(
    (Object.entries(providers) as [ProviderId, AgentProvider][]).map(([id, provider]) =>
      provider.status().catch((err): ProviderStatus => failedStatus(provider, id, err)),
    ),
  );
}

/** The built-in accounts' statuses, with any running usage-limit cooldown surfaced in `detail`. */
export async function providerStatuses(refresh = false): Promise<ProviderStatus[]> {
  if (refresh || !cached || Date.now() - cached.at > STATUS_TTL_MS) {
    cached = { at: Date.now(), statuses: loadStatuses() };
  }
  return (await cached.statuses).map((status) => {
    const limit = limits.message(status.accountId ?? status.id);
    return limit ? { ...status, detail: `Usage limit reached: ${limit}` } : status;
  });
}

let accountCache: { at: number; statuses: Promise<AccountStatus[]> } | null = null;

/** One account's status: its sign-in (from its CLI), its folder, and what it brings (env key names, MCP servers). */
async function loadAccountStatus(id: string): Promise<AccountStatus> {
  const account = accounts.require(id);
  const dir = accountDir(account);
  const isDefault = accounts.defaultId(account.driver) === account.id;
  const claude = account.driver === "claude";
  // Only key names leave this function; the values stay in the account's own files.
  const env = claude && !account.builtIn ? claudeSettingsEnv(account) : {};
  const info = {
    ...account,
    dir: tildePath(dir),
    dirExists: dirExists(dir),
    envKeys: Object.keys(env),
    proxy: claudeAuthEnv(env).proxy,
    mcpServers: claude ? claudeMcpServers(account).map((s) => s.name) : codexMcpServerNames(account),
    plugins: claude ? claudePlugins(account).map((p) => p.name.split("@")[0]!) : [],
    isDefault,
    limitedUntil: limits.until(account.id) ?? null,
  };
  if (!account.enabled) {
    return { ...info, installed: true, loggedIn: false, detail: "Turned off: its models aren't offered.", models: [] };
  }
  if (!account.builtIn && !info.dirExists) {
    return { ...info, installed: true, loggedIn: false, detail: `${info.dir} doesn't exist on this Mac.`, models: [] };
  }
  const provider = providerFor(account.id);
  const status = await provider.status().catch((err): ProviderStatus => failedStatus(provider, account.id, err));
  const limit = limits.message(account.id);
  return {
    ...info,
    installed: status.installed,
    loggedIn: status.loggedIn,
    authMethod: status.authMethod,
    email: status.account,
    detail: limit ? `Usage limit reached: ${limit}` : status.detail,
    models: status.models,
  };
}

/** Every account's status, in list order (built-in Claude, other Claude accounts, built-in ChatGPT, others). */
export async function accountStatuses(refresh = false): Promise<AccountStatus[]> {
  if (refresh) {
    cached = null;
    accountCache = null;
  }
  if (!accountCache || Date.now() - accountCache.at > STATUS_TTL_MS) {
    accountCache = { at: Date.now(), statuses: Promise.all(accounts.list().map((account) => loadAccountStatus(account.id))) };
  }
  return accountCache.statuses;
}

/** Account statuses as routing reads them: a turned-off account counts as not connected. */
export async function routingStatuses(): Promise<ProviderStatus[]> {
  return (await accountStatuses()).map((status) => ({
    id: status.driver,
    accountId: status.id,
    label: status.builtIn ? (status.driver === "claude" ? "Claude" : "ChatGPT") : status.name,
    installed: status.installed,
    loggedIn: status.enabled && status.loggedIn,
    authMethod: status.authMethod,
    detail: status.detail,
    models: status.models,
  }));
}

export async function modelOptions(): Promise<ModelOption[]> {
  const statuses = (await accountStatuses()).filter((status) => status.enabled);
  const up = (driver: ProviderId) => statuses.some((s) => s.driver === driver && s.loggedIn);
  const claude = up("claude");
  const chatgpt = up("chatgpt");
  const auto: ModelOption = {
    id: "auto",
    provider: "auto",
    model: "auto",
    label: "TOT Auto",
    description: claude
      ? "Sonnet 5.5 for quick asks, Opus 5.5 for hard ones — ChatGPT when Claude is at its limit"
      : "Routes to ChatGPT until Claude is connected",
    available: Boolean(claude || chatgpt),
    unavailableReason: claude || chatgpt ? undefined : "Connect Claude or ChatGPT first",
  };
  return [auto, ...statuses.flatMap((s) => s.models.map((model) => ({ ...model, accountId: s.id, accountName: s.name })))];
}
