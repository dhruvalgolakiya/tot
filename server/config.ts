import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isLoopbackBind } from "./net.ts";

// Keys and options can live in a .env file next to package.json (see .env.example).
// Real environment variables win over the file.
try {
  process.loadEnvFile(join(process.cwd(), ".env"));
} catch {
  // no .env — that's fine
}

export const VERSION = "0.1.0";

export const PORT = Number(process.env.TOT_PORT ?? 8787);
export const IS_PROD = process.env.NODE_ENV === "production";

/**
 * Legacy sign-in token (see auth.ts, access.ts). Sign-in is normally a password set in the app
 * (Settings → Devices); this still works as a password at /login and as a Bearer token for scripts.
 */
export const ACCESS_TOKEN = process.env.TOT_ACCESS_TOKEN?.trim() || undefined;

/** The port another machine opens: the web server's (Vite in development), not the API's. */
export const WEB_PORT = IS_PROD ? PORT : Number(process.env.TOT_WEB_PORT ?? 5173);

/**
 * Legacy: remote access set in .env instead of the app (Settings → Devices). TOT_LAN=1 serves the home
 * network (and Tailscale); TOT_HOST=tailscale serves Tailscale only. Either one fixes the app's switch.
 */
export const LAN = /^(1|true|yes|on)$/i.test(process.env.TOT_LAN?.trim() ?? "");
export const TAILSCALE = process.env.TOT_HOST?.trim().toLowerCase() === "tailscale";
export const ENV_REMOTE: { mode: "lan" | "tailscale"; variable: "TOT_LAN" | "TOT_HOST" } | null = TAILSCALE
  ? { mode: "tailscale", variable: "TOT_HOST" }
  : LAN
    ? { mode: "lan", variable: "TOT_LAN" }
    : null;

/**
 * The main listener: loopback, unless TOT_HOST names an address (advanced: e.g. 0.0.0.0 behind your own
 * firewall). Remote access otherwise adds listeners on specific addresses at runtime (listeners.ts).
 * IPv4 only: many networks hand out public IPv6 addresses, which would put TOT on the internet.
 */
export const HOST = (!TAILSCALE && process.env.TOT_HOST?.trim()) || "127.0.0.1";
/** TOT_HOST put the main listener itself on the network. */
export const RAW_HOST_EXPOSED = !isLoopbackBind(HOST);

/** Everything TOT persists lives here: the SQLite db, secrets, local computer workspaces. */
export const DATA_DIR = process.env.TOT_DATA_DIR ?? join(homedir(), ".tot");

export const paths = {
  db: join(DATA_DIR, "tot.db"),
  secrets: join(DATA_DIR, "secrets.json"),
  /** Stable cwd for the Claude Code / Codex harness processes (session files are keyed by cwd). */
  agentHome: join(DATA_DIR, "agent-home"),
  /** Local-computer workspaces, one folder per agent. */
  computers: join(DATA_DIR, "computers"),
  /** Executor (apps): the installed program, and its data (connections, credentials, rules). */
  executorRuntime: join(DATA_DIR, "executor-runtime"),
  executorData: join(DATA_DIR, "executor"),
};

for (const dir of [DATA_DIR, paths.agentHome, paths.computers]) {
  mkdirSync(dir, { recursive: true });
  // Chats, secrets, cloned private repos: only this user may look inside.
  chmodSync(dir, 0o700);
}

/** Base URL the harness processes use to reach TOT's built-in MCP server. */
export const INTERNAL_BASE_URL = `http://${
  HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST.includes(":") ? `[${HOST}]` : HOST
}:${PORT}`;

/**
 * Bearer token guarding the built-in MCP endpoint. Regenerated on every boot:
 * only harness processes spawned by this server ever see it.
 */
export const MCP_TOKEN = randomBytes(24).toString("hex");

// ---------------------------------------------------------------------------
// Secrets: write-only from the UI, stored in a 0600 file, env vars as fallback.
// ---------------------------------------------------------------------------

/**
 * `mailPassword:<personaId>` is a persona's mailbox (app) password; `personaGitHubToken:<personaId>` its GitHub token;
 * `deviceToken:<deviceId>` the token for calling a paired device (module 07); `signInPassword` the scrypt hash
 * of the password other devices sign in with.
 */
type SecretName =
  | "boatApiKey"
  | "anthropicApiKey"
  | "githubToken"
  | "slackAppToken"
  | "slackBotToken"
  | `mailPassword:${string}`
  | `personaGitHubToken:${string}`
  | `deviceToken:${string}`
  | "signInPassword";

// No env fallback for the GitHub token: env vars reach the harness processes TOT spawns.
const ENV_FALLBACK: Partial<Record<SecretName, string>> = {
  boatApiKey: "BOAT_API_KEY",
  anthropicApiKey: "ANTHROPIC_API_KEY",
};

function readSecrets(): Partial<Record<SecretName, string>> {
  if (!existsSync(paths.secrets)) return {};
  try {
    return JSON.parse(readFileSync(paths.secrets, "utf8"));
  } catch {
    return {};
  }
}

export function getSecret(name: SecretName): string | undefined {
  const fallback = ENV_FALLBACK[name];
  return readSecrets()[name] || (fallback ? process.env[fallback] : undefined) || undefined;
}

/** Every saved secret whose name starts with `prefix`, e.g. all personas' GitHub tokens. */
export function secretValues(prefix: string): string[] {
  return Object.entries(readSecrets())
    .filter(([name, value]) => name.startsWith(prefix) && value)
    .map(([, value]) => value!);
}

export function setSecret(name: SecretName, value: string): void {
  const secrets = readSecrets();
  if (value) secrets[name] = value;
  else delete secrets[name];
  writeFileSync(paths.secrets, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  chmodSync(paths.secrets, 0o600);
}

// ---------------------------------------------------------------------------
// GitHub. Browser sign-in needs an OAuth app's client id (device flow; no secret).
// The URLs are overridable so tests can point them at a fake GitHub.
// ---------------------------------------------------------------------------

export const GITHUB_CLIENT_ID = process.env.TOT_GITHUB_CLIENT_ID?.trim() || "";
export const GITHUB_API_URL = (process.env.TOT_GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/$/, "");
export const GITHUB_WEB_URL = (process.env.TOT_GITHUB_WEB_URL?.trim() || "https://github.com").replace(/\/$/, "");
export const GITHUB_MCP_URL = (process.env.TOT_GITHUB_MCP_URL?.trim() || "https://api.githubcopilot.com/mcp").replace(/\/$/, "");

// ---------------------------------------------------------------------------
// Apps (Executor). A fixed port: Google sign-ins register its callback URL.
// ---------------------------------------------------------------------------

export const EXECUTOR_PORT = Number(process.env.TOT_EXECUTOR_PORT ?? 4791);
export const EXECUTOR_VERSION = "1.6.10";
