import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AccountInput, AccountPatch, ProviderAccount, ProviderId } from "../../shared/types.ts";
import { settings } from "../data/settings.ts";
import { db, parseJson, type Row } from "../db.ts";

/**
 * Provider accounts: several sign-ins per provider, modelled on T3 Code's provider instances. A Claude account is
 * a Claude Code config folder (run with CLAUDE_CONFIG_DIR), a ChatGPT account a Codex home (CODEX_HOME). The two
 * built-in accounts, "claude" and "chatgpt", use the default folders and always exist, so every provider id stored
 * before accounts existed (chats, messages, settings, limits) is simply the built-in account of that provider.
 */

/**
 * A request the accounts store refuses, with the HTTP status the routes answer with. Not the orchestrator's HttpError:
 * the providers import this module, and the orchestrator imports the providers.
 */
export class AccountError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export const BUILT_IN_IDS: readonly ProviderId[] = ["claude", "chatgpt"];
const BUILT_IN_NAMES: Record<ProviderId, string> = { claude: "Claude", chatgpt: "ChatGPT" };
/** Ids an account can't take: the built-ins and "auto" (TOT Auto's model id). */
const RESERVED = new Set(["auto", "claude", "chatgpt"]);

/** Home, for "~" and the default folders; tests point it at a temp folder so they never read the real ones. */
export function accountsHome(): string {
  return process.env.TOT_ACCOUNTS_HOME || homedir();
}

/** "~/x" → "/Users/me/x"; relative paths count from home too. */
export function expandHome(path: string): string {
  const home = accountsHome();
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return isAbsolute(path) ? path : resolve(home, path);
}

/** "/Users/me/x" → "~/x", for showing paths. */
export function tildePath(path: string): string {
  const home = accountsHome();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

/** The folder an account's CLI reads: its own, else the driver's default (Claude Code's or Codex's). */
export function accountDir(account: Pick<ProviderAccount, "driver" | "configDir">): string {
  if (account.configDir) return expandHome(account.configDir);
  if (account.driver === "claude") return process.env.TOT_CLAUDE_CONFIG_DIR || join(accountsHome(), ".claude");
  return process.env.CODEX_HOME || join(accountsHome(), ".codex");
}

export function dirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** An explicit CLI path, honoured only when it's an absolute path to a file (a bare "claude" means TOT's own). */
export function binaryFor(account: Pick<ProviderAccount, "binaryPath">): string | null {
  const path = account.binaryPath?.trim();
  if (!path) return null;
  const full = path.startsWith("~") ? expandHome(path) : path;
  return isAbsolute(full) && existsSync(full) ? full : null;
}

function builtIn(driver: ProviderId): ProviderAccount {
  return { id: driver, driver, name: BUILT_IN_NAMES[driver], configDir: null, binaryPath: null, useAccountTools: false, enabled: true, builtIn: true };
}

// Stored as one JSON list in the settings table: the built-ins only for what the user changed (name, tools, enabled).
type Stored = Omit<ProviderAccount, "builtIn">;

function readStored(): Stored[] {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'accounts'`).get() as Row | undefined;
  return parseJson<Stored[]>(row?.value, []);
}

function writeStored(list: Stored[]): void {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('accounts', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    JSON.stringify(list),
  );
  for (const listener of listeners) listener();
}

const listeners = new Set<() => void>();

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "account"
  );
}

function cleanDir(value: string | null | undefined): string | null {
  const dir = value?.trim().replace(/(.)\/+$/, "$1");
  return dir ? dir : null;
}

export const accounts = {
  /** Every account: the built-in Claude account, then other Claude accounts, then ChatGPT's the same way. */
  list(): ProviderAccount[] {
    const stored = readStored();
    const out: ProviderAccount[] = [];
    for (const driver of BUILT_IN_IDS) {
      const override = stored.find((a) => a.id === driver);
      // A built-in keeps its id, driver and default folder whatever was stored.
      out.push({ ...builtIn(driver), ...(override ? { name: override.name, useAccountTools: override.useAccountTools, enabled: override.enabled } : {}) });
      for (const account of stored) {
        if (account.driver === driver && !RESERVED.has(account.id)) out.push({ ...account, builtIn: false });
      }
    }
    return out;
  },

  get(id: string | null | undefined): ProviderAccount | null {
    if (!id) return null;
    return accounts.list().find((a) => a.id === id) ?? null;
  },

  require(id: string): ProviderAccount {
    const account = accounts.get(id);
    if (!account) throw new AccountError(404, "Account not found.");
    return account;
  },

  /** The provider of an account id; null for an unknown id. */
  driverOf(id: string): ProviderId | null {
    if (id === "claude" || id === "chatgpt") return id;
    return accounts.get(id)?.driver ?? null;
  },

  /** The account TOT Auto and tasks use for a provider: Settings → Models' choice while it's enabled, else the built-in. */
  defaultId(driver: ProviderId): string {
    const chosen = accounts.get(settings.get().models.accounts?.[driver]);
    return chosen && chosen.driver === driver && chosen.enabled ? chosen.id : driver;
  },

  add(input: AccountInput): ProviderAccount {
    if (input.driver !== "claude" && input.driver !== "chatgpt") throw new AccountError(400, "Pick Claude or ChatGPT.");
    const name = input.name?.trim();
    if (!name) throw new AccountError(400, "Give the account a name.");
    const configDir = cleanDir(input.configDir);
    if (!configDir) throw new AccountError(400, "Pick the account's folder. The default folder is already the built-in account.");
    const all = accounts.list();
    const dir = accountDir({ driver: input.driver, configDir });
    if (all.some((a) => a.driver === input.driver && accountDir(a) === dir)) throw new AccountError(409, "An account with that folder exists already.");
    const base = slug(name);
    let id = RESERVED.has(base) ? `${base}-2` : base;
    for (let n = 2; all.some((a) => a.id === id) || RESERVED.has(id); n++) id = `${base}-${n}`;
    const account: Stored = {
      id,
      driver: input.driver,
      name: name.slice(0, 60),
      configDir,
      binaryPath: cleanDir(input.binaryPath),
      useAccountTools: input.useAccountTools ?? true,
      enabled: true,
    };
    writeStored([...readStored(), account]);
    return { ...account, builtIn: false };
  },

  update(id: string, patch: AccountPatch): ProviderAccount {
    const current = accounts.require(id);
    const next: ProviderAccount = { ...current };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new AccountError(400, "Give the account a name.");
      next.name = name.slice(0, 60);
    }
    if (patch.useAccountTools !== undefined) next.useAccountTools = Boolean(patch.useAccountTools);
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    if (!current.builtIn) {
      if (patch.configDir !== undefined) {
        const configDir = cleanDir(patch.configDir);
        if (!configDir) throw new AccountError(400, "Pick the account's folder.");
        next.configDir = configDir;
      }
      if (patch.binaryPath !== undefined) next.binaryPath = cleanDir(patch.binaryPath);
    }
    const { builtIn: _b, ...stored } = next;
    const list = readStored().filter((a) => a.id !== id);
    writeStored([...list, stored]);
    return next;
  },

  remove(id: string): void {
    const account = accounts.require(id);
    if (account.builtIn) throw new AccountError(400, "The built-in account can't be removed. Turn it off instead.");
    writeStored(readStored().filter((a) => a.id !== id));
  },

  /** Runs when the list changes (providers drop their cached processes and statuses). */
  onChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
