import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type {
  GitHubConnection,
  GitHubConnectRequest,
  GitHubDevicePoll,
  GitHubDeviceStart,
  GitHubRepo,
  GitHubStatus,
} from "../shared/types.ts";
import { appEvents } from "./app-events.ts";
import { GITHUB_API_URL, GITHUB_CLIENT_ID, GITHUB_WEB_URL, getSecret, secretValues, setSecret } from "./config.ts";
import { db, parseJson, type Row } from "./db.ts";

/**
 * The app-wide GitHub connection. The token lives with TOT's other secrets
 * (never sent to the browser); the account's public profile and the writes
 * switch are kept in the settings table. Personas' own accounts are in
 * persona-github.ts, which also decides which account each agent uses.
 */

const run = promisify(execFile);

/** A connection problem the user should see (bad token, sign-in not set up…). */
export class GitHubError extends Error {}

interface Stored {
  connection: (GitHubConnection & { id: number }) | null;
  allowWrites: boolean;
}

/** The connected account, as the agent's computers need it for git. */
export interface GitHubIdentity {
  token: string;
  login: string;
  name: string | null;
  id: number;
  allowWrites: boolean;
}

const VALIDATE_EVERY_MS = 10 * 60_000;
const CLI_CHECK_EVERY_MS = 60_000;
const REPOS_CACHE_MS = 2 * 60_000;
// No "workflow": agents can't change CI definitions through this login.
const OAUTH_SCOPES = "repo read:org";

let lastValidated = 0;
let problem: string | null = null;
let cliCache: { at: number; value: { login: string } | null } | null = null;
let reposCache: { at: number; token: string; repos: GitHubRepo[] } | null = null;
interface DeviceFlow {
  deviceCode: string;
  start: GitHubDeviceStart;
  nextPollAt: number;
  result?: GitHubDevicePoll["state"];
}
let device: DeviceFlow | null = null;

function readStored(): Stored {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'github'`).get() as Row | undefined;
  return { connection: null, allowWrites: false, ...parseJson<Partial<Stored>>(row?.value, {}) };
}

function writeStored(next: Stored): void {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('github', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    JSON.stringify(next),
  );
}

async function api(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${GITHUB_API_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "TOT",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
}

/** The `gh` binary, if installed (the server's PATH may be minimal). */
function ghBinary(): string | null {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
  for (const dir of dirs) {
    const file = dir && join(dir, "gh");
    if (file && existsSync(file)) return file;
  }
  return null;
}

/** Runs gh without inheriting a GH_TOKEN/GITHUB_TOKEN, so it reports its own login. */
async function gh(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const binary = ghBinary();
  if (!binary) throw new GitHubError("The GitHub CLI (gh) isn't installed on this machine.");
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return run(binary, args, { env, timeout: 10_000 });
}

/** Who `gh` is logged in as on github.com (the active account), or null. */
async function cliLogin(): Promise<{ login: string } | null> {
  if (cliCache && Date.now() - cliCache.at < CLI_CHECK_EVERY_MS) return cliCache.value;
  let value: { login: string } | null = null;
  try {
    const { stdout, stderr } = await gh(["auth", "status", "--hostname", "github.com"]);
    // One block per account: "✓ Logged in to github.com account <login> (keyring)" … "- Active account: true".
    const blocks = `${stdout}\n${stderr}`.split(/Logged in to github\.com /).slice(1);
    const active = blocks.find((block) => /Active account: true/.test(block)) ?? blocks[0];
    const login = active && /^(?:account|as) ([A-Za-z0-9-]+)/.exec(active)?.[1];
    if (login) value = { login };
  } catch {
    // Not installed or not logged in.
  }
  cliCache = { at: Date.now(), value };
  return value;
}

/**
 * Checks a token with GitHub and returns the account it belongs to. `listsScopes`: GitHub listed the
 * token's scopes (classic and OAuth tokens); fine-grained tokens have none, so their access can't be checked up front.
 */
export async function lookUpAccount(
  token: string,
): Promise<{ profile: Omit<GitHubConnection, "source" | "connectedAt">; id: number; listsScopes: boolean }> {
  let res: Response;
  try {
    res = await api("/user", token);
  } catch {
    throw new GitHubError("Couldn't reach GitHub. Check your connection and try again.");
  }
  if (res.status === 401) throw new GitHubError("GitHub didn't accept that token. Check it and try again.");
  if (!res.ok) throw new GitHubError(`GitHub answered ${res.status}. Try again in a moment.`);
  const user = (await res.json()) as { login: string; name: string | null; avatar_url: string; id: number };
  const header = res.headers.get("x-oauth-scopes");
  const scopes = (header ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  return { profile: { login: user.login, name: user.name || null, avatarUrl: user.avatar_url, scopes }, id: user.id, listsScopes: header !== null };
}

/** Whether GitHub still accepts a saved token: false once it's revoked or expired, null when GitHub can't be reached. */
export async function tokenAccepted(token: string): Promise<boolean | null> {
  try {
    const res = await api("/user", token, { signal: AbortSignal.timeout(5_000) });
    return res.status === 401 ? false : res.ok ? true : null;
  } catch {
    return null;
  }
}

async function save(token: string, source: GitHubConnection["source"]): Promise<GitHubStatus> {
  const { profile, id } = await lookUpAccount(token);
  const stored = readStored();
  setSecret("githubToken", token);
  // A different account starts read-only, whatever the previous one was allowed.
  const allowWrites = stored.connection?.id === id && stored.allowWrites;
  writeStored({ allowWrites, connection: { ...profile, id, source, connectedAt: Date.now() } });
  problem = null;
  lastValidated = Date.now();
  reposCache = null;
  return changed();
}

async function changed(): Promise<GitHubStatus> {
  const status = await github.status();
  appEvents.publish({ type: "github", status });
  return status;
}

function toRepo(repo: Record<string, unknown>): GitHubRepo {
  return {
    fullName: String(repo.full_name),
    private: Boolean(repo.private),
    description: (repo.description as string | null) || null,
    url: String(repo.html_url),
    pushedAt: repo.pushed_at ? Date.parse(String(repo.pushed_at)) : null,
  };
}

export const github = {
  async status(): Promise<GitHubStatus> {
    const stored = readStored();
    const token = getSecret("githubToken");
    const connection = token ? stored.connection : null;
    // Notice a revoked token, at most every few minutes; being offline isn't a problem.
    if (token && connection && Date.now() - lastValidated > VALIDATE_EVERY_MS) {
      lastValidated = Date.now();
      const accepted = await tokenAccepted(token);
      // Only if that's still the saved token (the user may have reconnected meanwhile); offline keeps whatever we knew.
      if (getSecret("githubToken") === token) {
        if (accepted === false) problem = "GitHub no longer accepts the saved login. Reconnect to keep agents working on GitHub.";
        else if (accepted) problem = null;
      }
    }
    let publicConnection: GitHubConnection | null = null;
    if (connection) {
      const { id: _id, ...rest } = connection;
      publicConnection = rest;
    }
    return {
      connection: publicConnection,
      problem: connection ? problem : null,
      allowWrites: stored.allowWrites,
      cli: await cliLogin(),
      oauthAvailable: Boolean(GITHUB_CLIENT_ID),
    };
  },

  /** The connected account with its token. Agents reach it through githubAccessFor (persona-github.ts). */
  identity(): GitHubIdentity | null {
    const token = getSecret("githubToken");
    const { connection, allowWrites } = readStored();
    if (!token || !connection) return null;
    return { token, login: connection.login, name: connection.name, id: connection.id, allowWrites };
  },

  async connect(request: GitHubConnectRequest): Promise<GitHubStatus> {
    if (request.method === "cli") {
      let token = "";
      try {
        token = (await gh(["auth", "token", "--hostname", "github.com"])).stdout.trim();
      } catch (err) {
        if (err instanceof GitHubError) throw err;
      }
      if (!token) throw new GitHubError("The GitHub CLI isn't logged in. Run `gh auth login` in a terminal, then try again.");
      cliCache = null;
      return save(token, "cli");
    }
    if (request.method === "token") {
      const token = typeof request.token === "string" ? request.token.trim() : "";
      if (!token || /\s/.test(token) || token.length > 255) throw new GitHubError("Paste a GitHub token (it starts with ghp_ or github_pat_).");
      return save(token, "token");
    }
    throw new GitHubError("Unknown way to connect.");
  },

  async startDevice(): Promise<GitHubDeviceStart> {
    if (!GITHUB_CLIENT_ID) throw new GitHubError("Browser sign-in isn't set up. Add TOT_GITHUB_CLIENT_ID to .env, or use a token.");
    let res: Response;
    try {
      res = await fetch(`${GITHUB_WEB_URL}/login/device/code`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "TOT" },
        body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: OAUTH_SCOPES }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GitHubError("Couldn't reach GitHub. Check your connection and try again.");
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.device_code !== "string") {
      throw new GitHubError(`GitHub sign-in didn't start${body.error_description ? `: ${body.error_description}` : "."}`);
    }
    const intervalSeconds = Number(body.interval) || 5;
    const start: GitHubDeviceStart = {
      userCode: String(body.user_code),
      verificationUri: String(body.verification_uri),
      expiresAt: Date.now() + (Number(body.expires_in) || 900) * 1000,
      intervalSeconds,
    };
    device = { deviceCode: body.device_code, start, nextPollAt: Date.now() + intervalSeconds * 1000 };
    return start;
  },

  /** One step of browser sign-in; GitHub is asked at most once per its polling interval. */
  async pollDevice(): Promise<GitHubDevicePoll> {
    // This flow may be cancelled or replaced while GitHub answers; then its result is dropped.
    const flow = device;
    if (!flow) return { state: "none" };
    if (flow.result) return { state: flow.result };
    if (Date.now() > flow.start.expiresAt) {
      flow.result = "expired";
      return { state: "expired" };
    }
    if (Date.now() < flow.nextPollAt) return { state: "pending" };
    flow.nextPollAt = Date.now() + flow.start.intervalSeconds * 1000;
    let body: Record<string, unknown> = {};
    try {
      const res = await fetch(`${GITHUB_WEB_URL}/login/oauth/access_token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "TOT" },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: flow.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal: AbortSignal.timeout(15_000),
      });
      body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      return { state: "pending" };
    }
    if (device !== flow) return { state: "none" };
    if (typeof body.access_token === "string") {
      try {
        const status = await save(body.access_token, "oauth");
        flow.result = "connected";
        return { state: "connected", status };
      } catch (err) {
        flow.result = "expired";
        throw err;
      }
    }
    switch (body.error) {
      case "authorization_pending":
        return { state: "pending" };
      case "slow_down":
        flow.start.intervalSeconds += 5;
        flow.nextPollAt = Date.now() + flow.start.intervalSeconds * 1000;
        return { state: "pending" };
      case "access_denied":
        flow.result = "denied";
        return { state: "denied" };
      default:
        // expired_token, or anything unexpected: start over.
        flow.result = "expired";
        return { state: "expired" };
    }
  },

  async setAllowWrites(allowWrites: boolean): Promise<GitHubStatus> {
    writeStored({ ...readStored(), allowWrites });
    return changed();
  },

  async disconnect(): Promise<GitHubStatus> {
    setSecret("githubToken", "");
    writeStored({ ...readStored(), connection: null });
    problem = null;
    reposCache = null;
    device = null;
    return changed();
  },

  /** The user's repos, most recently pushed first; `query` filters by name or description. */
  async repos(query = ""): Promise<GitHubRepo[]> {
    const who = github.identity();
    if (!who) throw new GitHubError("Connect GitHub first.");
    if (!reposCache || reposCache.token !== who.token || Date.now() - reposCache.at > REPOS_CACHE_MS) {
      let res: Response;
      try {
        res = await api("/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member", who.token);
      } catch {
        throw new GitHubError("Couldn't reach GitHub. Check your connection and try again.");
      }
      if (res.status === 401) throw new GitHubError("GitHub no longer accepts the saved login. Reconnect in Settings.");
      if (!res.ok) throw new GitHubError(`GitHub answered ${res.status}. Try again in a moment.`);
      reposCache = { at: Date.now(), token: who.token, repos: ((await res.json()) as Record<string, unknown>[]).map(toRepo) };
    }
    const q = query.trim().toLowerCase();
    const matches = q
      ? reposCache.repos.filter((repo) => repo.fullName.toLowerCase().includes(q) || repo.description?.toLowerCase().includes(q))
      : reposCache.repos;
    return matches.slice(0, 30);
  },
};

const TOKEN_PATTERN = /\b(?:gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

/** Hides GitHub tokens (the connected one, personas' and any that look like one) in text an agent will see or save. */
export function redactGitHubTokens(text: string): string {
  let out = text;
  for (const token of [getSecret("githubToken"), ...secretValues("personaGitHubToken:")]) {
    if (token && token.length >= 8) out = out.split(token).join("[GitHub token hidden]");
  }
  return out.replace(TOKEN_PATTERN, "[GitHub token hidden]");
}
