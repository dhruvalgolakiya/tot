import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderAccount } from "@tot/shared/types";
import type { McpServerSpec } from "../agent/providers/types.ts";
import { accountDir, accountsHome, dirExists } from "./accounts.ts";

/**
 * What an account's own config folder brings, read fresh on each use (the files are small and the user may edit
 * them any time). Values from these files (env values, tokens in MCP headers) stay inside the server: they go to the
 * account's CLI process and nowhere else — never into logs, the database or API answers. Key and server names are fine.
 */

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Claude Code's global config for a folder: <dir>/.claude.json, or ~/.claude.json for the default folder. */
function claudeGlobalConfigPath(account: Pick<ProviderAccount, "driver" | "configDir">): string {
  if (!account.configDir && !process.env.TOT_CLAUDE_CONFIG_DIR) return join(accountsHome(), ".claude.json");
  return join(accountDir(account), ".claude.json");
}

/** The `env` block of the folder's settings.json: values for the CLI process only. */
export function claudeSettingsEnv(account: Pick<ProviderAccount, "driver" | "configDir">): Record<string, string> {
  const env = readJson(join(accountDir(account), "settings.json"))?.env;
  if (!isRecord(env)) return {};
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0])));
}

/** One MCP server entry from Claude Code's config, as TOT's spec (stdio or http; others are skipped). */
function toSpec(name: string, raw: unknown): McpServerSpec | null {
  if (!isRecord(raw) || !/^[A-Za-z0-9_-]+$/.test(name)) return null;
  const type = typeof raw.type === "string" ? raw.type : raw.url ? "http" : "stdio";
  const strings = (value: unknown): Record<string, string> | undefined =>
    isRecord(value) ? Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string")) : undefined;
  if (type === "http" && typeof raw.url === "string") return { name, type: "http", url: raw.url, headers: strings(raw.headers) };
  if (type === "stdio" && typeof raw.command === "string") {
    const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [];
    return { name, type: "stdio", command: raw.command, args, env: strings(raw.env) };
  }
  return null;
}

/** The Claude account's own MCP servers: its .claude.json `mcpServers`, plus settings.json's when it has some. */
export function claudeMcpServers(account: Pick<ProviderAccount, "driver" | "configDir">): McpServerSpec[] {
  const sources = [readJson(claudeGlobalConfigPath(account))?.mcpServers, readJson(join(accountDir(account), "settings.json"))?.mcpServers];
  const byName = new Map<string, McpServerSpec>();
  for (const source of sources) {
    if (!isRecord(source)) continue;
    for (const [name, raw] of Object.entries(source)) {
      const spec = toSpec(name, raw);
      if (spec && !byName.has(name)) byName.set(name, spec);
    }
  }
  return [...byName.values()];
}

/**
 * The Claude account's enabled plugins with where they're installed (settings.json `enabledPlugins`, located through
 * plugins/installed_plugins.json). Plugins not installed in the folder are left out.
 */
export function claudePlugins(account: Pick<ProviderAccount, "driver" | "configDir">): { name: string; path: string }[] {
  const dir = accountDir(account);
  const enabled = readJson(join(dir, "settings.json"))?.enabledPlugins;
  const installed = readJson(join(dir, "plugins", "installed_plugins.json"))?.plugins;
  if (!isRecord(enabled) || !isRecord(installed)) return [];
  const out: { name: string; path: string }[] = [];
  for (const [name, on] of Object.entries(enabled)) {
    if (on !== true) continue;
    const entries = installed[name];
    const list = Array.isArray(entries) ? entries.filter(isRecord) : [];
    // The user-scope install, else any.
    const entry = list.find((e) => e.scope === "user") ?? list[0];
    if (entry && typeof entry.installPath === "string" && dirExists(entry.installPath)) out.push({ name, path: entry.installPath });
  }
  return out;
}

/** Names of the MCP servers in a Codex home's config.toml (`[mcp_servers.<name>]` tables). */
export function codexMcpServerNames(account: Pick<ProviderAccount, "driver" | "configDir">): string[] {
  let text = "";
  try {
    text = readFileSync(join(accountDir(account), "config.toml"), "utf8");
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const match of text.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*\]/gm)) names.add(match[1] ?? match[2]!);
  return [...names];
}

/** What a Claude account sends Claude Code that changes where it signs in: a base URL or a token in its env block. */
export function claudeAuthEnv(env: Record<string, string>): { proxy: boolean; hasAuth: boolean } {
  return {
    proxy: Boolean(env.ANTHROPIC_BASE_URL),
    hasAuth: Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN),
  };
}

/**
 * TOT's servers plus the account's own: TOT's always win a name, and an account server whose name is taken gets an
 * "account_" prefix rather than being dropped. With the account's tools off, nothing is added.
 */
export function mergeMcpServers(tot: McpServerSpec[], account: McpServerSpec[], useAccountTools: boolean): McpServerSpec[] {
  if (!useAccountTools || !account.length) return tot;
  const taken = new Set(tot.map((spec) => spec.name.toLowerCase()));
  const extra: McpServerSpec[] = [];
  for (const spec of account) {
    let name = spec.name;
    if (taken.has(name.toLowerCase())) name = `account_${name}`;
    if (taken.has(name.toLowerCase())) continue;
    taken.add(name.toLowerCase());
    extra.push({ ...spec, name });
  }
  return [...tot, ...extra];
}
