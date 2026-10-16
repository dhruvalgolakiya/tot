import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderAccount, ProviderId, T3ImportCandidate } from "@tot/shared/types";
import { AccountError, accountDir, accounts, accountsHome } from "./accounts.ts";

/**
 * Import from T3 Code: its settings.json lists provider instances (`providerInstances`, keyed by id, each
 * `{ driver, displayName, enabled, config }`). Claude Code ones ("claudeAgent") have a `homePath`, Codex ones a
 * `shadowHomePath`; an empty one is the default folder, which TOT's built-in account already uses, so only instances
 * with their own folder are offered. TOT only ever reads that file.
 */

const DRIVERS: Record<string, ProviderId> = { claudeAgent: "claude", codex: "chatgpt" };
/** The CLIs' own names: T3 Code's default binaryPath, which just means "the usual one". */
const DEFAULT_BINARIES = new Set(["claude", "codex"]);

export function t3SettingsPath(): string {
  return process.env.TOT_T3_SETTINGS || join(accountsHome(), ".t3", "userdata", "settings.json");
}

/** T3 Code's Claude/Codex instances that have their own folder, from its settings file's text. */
export function parseT3Instances(text: string, existing: ProviderAccount[] = []): T3ImportCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AccountError(400, "T3 Code's settings file isn't valid JSON.");
  }
  const instances = (parsed as { providerInstances?: unknown })?.providerInstances;
  if (!instances || typeof instances !== "object") return [];
  const out: T3ImportCandidate[] = [];
  for (const [t3Id, raw] of Object.entries(instances as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const instance = raw as { driver?: unknown; displayName?: unknown; config?: Record<string, unknown> };
    const driver = DRIVERS[String(instance.driver)];
    if (!driver) continue;
    const config = instance.config ?? {};
    const folder = String((driver === "claude" ? config.homePath : config.shadowHomePath) ?? "").trim();
    if (!folder) continue;
    const binary = typeof config.binaryPath === "string" ? config.binaryPath.trim() : "";
    const name = typeof instance.displayName === "string" && instance.displayName.trim() ? instance.displayName.trim() : t3Id;
    const dir = accountDir({ driver, configDir: folder });
    out.push({
      t3Id,
      driver,
      name,
      configDir: folder,
      binaryPath: binary && !DEFAULT_BINARIES.has(binary) ? binary : null,
      alreadyAdded: existing.some((account) => account.driver === driver && accountDir(account) === dir),
    });
  }
  return out;
}

export const t3Import = {
  candidates(): T3ImportCandidate[] {
    let text: string;
    try {
      text = readFileSync(t3SettingsPath(), "utf8");
    } catch {
      throw new AccountError(404, "Couldn't find T3 Code's settings on this Mac.");
    }
    return parseT3Instances(text, accounts.list());
  },

  /** Adds the chosen instances as accounts (ones already added are skipped). */
  run(ids: string[]): ProviderAccount[] {
    const wanted = new Set(ids);
    const added: ProviderAccount[] = [];
    for (const candidate of t3Import.candidates()) {
      if (!wanted.has(candidate.t3Id) || candidate.alreadyAdded) continue;
      added.push(
        accounts.add({ driver: candidate.driver, name: candidate.name, configDir: candidate.configDir, binaryPath: candidate.binaryPath, useAccountTools: true }),
      );
    }
    return added;
  },
};
