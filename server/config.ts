import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tailscaleAddress } from "./net.ts";

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

/** Sign-in token for reaching TOT from other devices (see auth.ts). Unset = this machine only. */
export const ACCESS_TOKEN = process.env.TOT_ACCESS_TOKEN?.trim() || undefined;

/**
 * Serve other devices on the local network. In dev the Vite server listens on the
 * network and the API stays on loopback behind its proxy; in production the API
 * server itself listens on the network. Requires ACCESS_TOKEN.
 */
export const LAN = /^(1|true|yes|on)$/i.test(process.env.TOT_LAN?.trim() ?? "");

/**
 * TOT_HOST=tailscale: serve other devices over Tailscale only (from anywhere on your tailnet, and nowhere
 * else). In dev the Vite server listens on the Tailscale address and the API stays on loopback, as with LAN.
 */
export const TAILSCALE = process.env.TOT_HOST?.trim().toLowerCase() === "tailscale";

// IPv4 only: many networks hand out public IPv6 addresses, and "all addresses"
// would put TOT on the internet rather than just the LAN.
export const HOST = TAILSCALE
  ? (IS_PROD && tailscaleAddress()) || "127.0.0.1"
  : process.env.TOT_HOST?.trim() || (LAN && IS_PROD ? "0.0.0.0" : "127.0.0.1");

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
 * `deviceToken:<deviceId>` the token for calling a paired device (module 07).
 */
type SecretName =
  | "boatApiKey"
  | "anthropicApiKey"
  | "githubToken"
  | "slackAppToken"
  | "slackBotToken"
  | `mailPassword:${string}`
  | `personaGitHubToken:${string}`
  | `deviceToken:${string}`;

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
