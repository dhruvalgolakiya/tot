import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AppConnection, AppsStatus } from "@tot/shared/types";
import { appEvents } from "./app-events.ts";
import { EXECUTOR_PORT, EXECUTOR_VERSION, paths } from "./config.ts";
import { db, parseJson, type Row } from "./db.ts";

/**
 * Apps, through Executor (executor.sh): TOT installs a pinned version into its
 * data folder on request, runs it as a child process on 127.0.0.1, and gives
 * every agent its MCP endpoint. Executor holds the app credentials and the
 * per-tool rules; approvals reach the user as cards in the chat.
 */

const run = promisify(execFile);
const BASE = `http://127.0.0.1:${EXECUTOR_PORT}`;
const SCOPE_DIR = join(paths.executorData, "scope");
const START_TIMEOUT_MS = 20_000;
/**
 * Settings and every screen ask for the status often. Connecting or removing an app from TOT drops the cache at once
 * (appsChanged, with the `apps` event); one added in Executor's own page shows up within this long.
 */
const LIST_CACHE_MS = 30_000;

let state: AppsStatus["state"] = "not-installed";
let error: string | null = null;
let child: ChildProcess | null = null;
/** An Executor left running by an earlier TOT that we attached to instead of starting. */
let attachedPid: number | null = null;
let stopping = false;
let lastRestart = 0;
let listCache: { at: number; apps: AppConnection[] } | null = null;
/** The installed Executor's version, read once until setup installs it again. */
let versionCache: { version: string | null } | null = null;
const log: string[] = [];

function enabled(): boolean {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'apps'`).get() as Row | undefined;
  return parseJson<{ enabled?: boolean }>(row?.value, {}).enabled === true;
}

function setEnabled(value: boolean): void {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('apps', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    JSON.stringify({ enabled: value }),
  );
}

/** The platform binary the `executor` package installs (e.g. node_modules/executor-darwin-arm64/bin/executor). */
function binary(): string | null {
  const modules = join(paths.executorRuntime, "node_modules");
  if (!existsSync(modules)) return null;
  for (const name of readdirSync(modules)) {
    const file = join(modules, name, "bin", "executor");
    if (name.startsWith("executor-") && existsSync(file)) return file;
  }
  return null;
}

function installedVersion(): string | null {
  if (versionCache) return versionCache.version;
  let version: string | null = null;
  try {
    version = JSON.parse(readFileSync(join(paths.executorRuntime, "node_modules", "executor", "package.json"), "utf8")).version ?? null;
  } catch {
    // Not installed (yet).
  }
  versionCache = { version };
  return version;
}

function token(): string | null {
  try {
    return JSON.parse(readFileSync(join(paths.executorData, "server-control", "auth.json"), "utf8")).token ?? null;
  } catch {
    return null;
  }
}

/** Only what Executor needs: none of TOT's or the parent session's keys. */
function childEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TMPDIR: process.env.TMPDIR,
    EXECUTOR_DATA_DIR: paths.executorData,
    EXECUTOR_SCOPE_DIR: SCOPE_DIR,
    // Sign-in callbacks use this host and port; Google clients must register exactly this.
    EXECUTOR_WEB_BASE_URL: `http://localhost:${EXECUTOR_PORT}`,
    // Credentials go to a file inside TOT's private data folder instead of the login keychain.
    EXECUTOR_KEYRING_NATIVE_PATH: "/nonexistent",
    DO_NOT_TRACK: "1",
    EXECUTOR_DISABLE_ANALYTICS: "1",
    EXECUTOR_DISABLE_UPDATE_CHECK: "1",
  };
}

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

/** A failed Executor API call, with Executor's error tag (e.g. "IntegrationAlreadyExistsError"). */
export class ExecutorError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly tag: string | null,
  ) {
    super(message);
  }
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Calls Executor's local API with its token (never exposed to the browser). */
export async function executor<T>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  const secret = token();
  if (!secret || state !== "running") throw new ExecutorError("Apps aren't running. Turn them on in Settings → Apps.", 503, null);
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = parseBody(await res.text());
  if (!res.ok) {
    const tag = typeof data === "object" && data && "_tag" in data ? String((data as { _tag: unknown })._tag) : null;
    const detail = typeof data === "object" && data && "message" in data ? String((data as { message: unknown }).message) : tag;
    throw new ExecutorError(detail || `Executor answered ${res.status}.`, res.status, tag);
  }
  return data as T;
}

const api = <T>(path: string) => executor<T>("GET", path, undefined, 5000);

/** What TOT remembers about apps it added: where their icon comes from. */
export interface AppMeta {
  iconUrl: string | null;
  domain: string | null;
  /** An OAuth client TOT registered just for this app (removed with it). */
  ownClient?: string;
}

export function appMeta(): Record<string, AppMeta> {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'apps-meta'`).get() as Row | undefined;
  return parseJson<Record<string, AppMeta>>(row?.value, {});
}

export function setAppMeta(slug: string, meta: AppMeta | null): void {
  const all = appMeta();
  if (meta) all[slug] = meta;
  else delete all[slug];
  db.prepare(`INSERT INTO settings (key, value) VALUES ('apps-meta', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    JSON.stringify(all),
  );
}

export const list = (value: unknown): Record<string, unknown>[] => {
  const items = Array.isArray(value) ? value : ((value as { items?: unknown })?.items ?? (value as { data?: unknown })?.data);
  return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
};

/** Connected apps for the settings page, from Executor's connections. */
async function connectedApps(): Promise<AppConnection[]> {
  if (listCache && Date.now() - listCache.at < LIST_CACHE_MS) return listCache.apps;
  const [integrations, connections] = await Promise.all([api<unknown>("/integrations"), api<unknown>("/connections")]);
  const names = new Map(list(integrations).map((i) => [String(i.slug ?? i.id), String(i.name ?? i.slug)]));
  const meta = appMeta();
  const apps = list(connections).map((c): AppConnection => {
    const health = c.lastHealth as { status?: string } | null | undefined;
    const missing = Array.isArray(c.missingOAuthScopes) && c.missingOAuthScopes.length > 0;
    const slug = String(c.integration);
    return {
      id: String(c.address ?? `${slug}/${c.name}`),
      appId: slug,
      name: names.get(slug) ?? slug,
      iconUrl: meta[slug]?.iconUrl ?? null,
      account: typeof c.identityLabel === "string" && c.identityLabel ? c.identityLabel : null,
      // Executor reports healthy | degraded | unknown | expired | misconfigured.
      healthy: !missing && health?.status !== "expired" && health?.status !== "misconfigured",
    };
  });
  listCache = { at: Date.now(), apps };
  return apps;
}

function setState(next: AppsStatus["state"], problem: string | null = null): void {
  state = next;
  error = problem;
  appsChanged();
}

/** Connected apps changed (or the state did): refresh everyone's view. */
export function appsChanged(): void {
  listCache = null;
  void apps.status().then((status) => appEvents.publish({ type: "apps", status }));
}

/** Plain-words reason from Executor's last output lines. */
function lastWords(fallback: string): string {
  const line = [...log].reverse().find((l) => /error|fail|denied|in use|already running/i.test(l));
  return line ? `${fallback} ${line.slice(0, 200)}` : fallback;
}

async function install(): Promise<void> {
  mkdirSync(paths.executorRuntime, { recursive: true });
  // A pinned version, without install scripts (the package needs none).
  try {
    await run(
      "npm",
      ["install", "--prefix", paths.executorRuntime, `executor@${EXECUTOR_VERSION}`, "--ignore-scripts", "--no-audit", "--no-fund"],
      { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }, timeout: 10 * 60_000 },
    );
  } finally {
    // Read the version again, whether or not the install got all the way.
    versionCache = null;
  }
  if (!binary()) throw new Error("Executor installed, but its program for this computer wasn't found.");
}

/** An Executor from an earlier TOT run still owns our data folder: use it instead of starting another. */
function leftoverPid(): number | null {
  try {
    const info = JSON.parse(readFileSync(join(paths.executorData, "server-control", "server.json"), "utf8")) as { pid?: number };
    if (!info.pid) return null;
    process.kill(info.pid, 0);
    return info.pid;
  } catch {
    return null;
  }
}

async function start(): Promise<void> {
  if (await healthy()) {
    const pid = leftoverPid();
    if (pid && token()) {
      attachedPid = pid;
      return;
    }
    throw new Error(`Port ${EXECUTOR_PORT} is used by another program. Set TOT_EXECUTOR_PORT in .env to a free port.`);
  }
  const file = binary();
  if (!file) throw new Error("Executor isn't installed.");
  mkdirSync(SCOPE_DIR, { recursive: true });
  log.length = 0;
  const proc = spawn(file, ["daemon", "run", "--foreground", "--hostname", "127.0.0.1", "--port", String(EXECUTOR_PORT)], {
    cwd: SCOPE_DIR,
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = proc;
  const keep = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) log.push(line);
    log.splice(0, Math.max(0, log.length - 40));
  };
  proc.stdout?.on("data", keep);
  proc.stderr?.on("data", keep);
  proc.on("exit", (code) => {
    if (child !== proc) return;
    child = null;
    if (stopping || state === "stopped") return;
    // It went away on its own: say so, and try once more if that hasn't just happened.
    setState("error", lastWords(`Executor stopped unexpectedly (exit ${code}).`));
    if (enabled() && Date.now() - lastRestart > 5 * 60_000) {
      lastRestart = Date.now();
      setTimeout(() => void apps.setup().catch(() => {}), 3000);
    }
  });
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child !== proc) throw new Error(lastWords("Executor didn't start."));
    if ((await healthy()) && token()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  proc.kill("SIGTERM");
  throw new Error(lastWords("Executor took too long to start."));
}

export const apps = {
  async status(): Promise<AppsStatus> {
    let connected: AppConnection[] = [];
    if (state === "running") {
      try {
        connected = await connectedApps();
      } catch {
        // Listing failed; the agents' connection may still work. Show it as running without the list.
      }
    }
    const version = installedVersion();
    const shown = state === "not-installed" && version ? "stopped" : state;
    return { state: shown, version, error, apps: connected };
  },

  /** Installs (once) and starts Executor; returns right away while that happens in the background. */
  async setup(): Promise<AppsStatus> {
    if (state === "installing" || state === "starting" || state === "running") return apps.status();
    setEnabled(true);
    stopping = false;
    void (async () => {
      try {
        if (!binary() || installedVersion() !== EXECUTOR_VERSION) {
          setState("installing");
          await install();
        }
        setState("starting");
        await start();
        setState("running");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setState("error", message.includes("npm") ? `Couldn't install Executor: ${message.split("\n")[0]}` : message);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return apps.status();
  },

  /** Stops Executor. `keepEnabled` (TOT shutting down) means it starts again with TOT. */
  async stop(opts: { keepEnabled?: boolean } = {}): Promise<AppsStatus> {
    if (!opts.keepEnabled) setEnabled(false);
    stopping = true;
    const proc = child;
    child = null;
    if (proc && proc.exitCode === null) {
      const exited = new Promise((resolve) => proc.once("exit", resolve));
      proc.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
    if (attachedPid) {
      try {
        process.kill(attachedPid, "SIGTERM");
      } catch {
        // Already gone.
      }
      attachedPid = null;
    }
    setState(binary() ? "stopped" : "not-installed");
    return apps.status();
  },

  /** On TOT startup: bring apps back if they were on. */
  async resume(): Promise<void> {
    if (binary()) state = "stopped";
    if (enabled() && binary()) await apps.setup();
  },

  /** Executor's MCP endpoint for agents while it runs. Native elicitation: the user approves, never the model. */
  mcpServer(): { url: string; token: string } | null {
    const secret = state === "running" ? token() : null;
    return secret ? { url: `${BASE}/mcp?elicitation_mode=native&artifacts=false`, token: secret } : null;
  },

  /** A signed-in link to Executor's web UI (only reachable on this machine). */
  openUrl(path: string): string | null {
    const secret = state === "running" ? token() : null;
    if (!secret) return null;
    const origin = `http://localhost:${EXECUTOR_PORT}`;
    let page = new URL("/", origin);
    try {
      const wanted = new URL(path, origin);
      // Only pages of Executor itself (no "//other.host" or backslash tricks).
      if (wanted.origin === origin) page = wanted;
    } catch {
      // Not a path: open the home page.
    }
    page.searchParams.set("_token", secret);
    return page.toString();
  },

  get running(): boolean {
    return state === "running";
  },
};
