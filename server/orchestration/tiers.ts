import type { Effort, ProviderId, ProviderStatus, Role, Tier } from "../../shared/types.ts";
import { settings } from "../data/settings.ts";

/**
 * Model tiers: fast (searching, classifying), standard (most work), deep (the hard change).
 * Settings → Models picks a model per tier and provider; the defaults are read from the
 * models each account offers rather than hard-coded, except Claude's two:
 *
 *   tier      Claude                    ChatGPT
 *   fast      Sonnet 5.5, effort low    the newest "luna" model (the cheapest)
 *   standard  Sonnet 5.5, effort high   the newest "sol" model after the default
 *   deep      Opus 5.5, effort high     the account's default (its strongest)
 *
 * "Think harder" turns deep up to xhigh. A provider in a usage-limit cooldown is avoided
 * while the other one can take the turn.
 */

export const CLAUDE_OPUS = "claude-opus-5-5";
export const CLAUDE_SONNET = "claude-sonnet-5-5";

export const TIERS: Tier[] = ["fast", "standard", "deep"];
export const PROVIDERS: ProviderId[] = ["claude", "chatgpt"];

const CLAUDE_DEFAULTS: Record<Tier, string> = { fast: CLAUDE_SONNET, standard: CLAUDE_SONNET, deep: CLAUDE_OPUS };
const EFFORTS: Record<ProviderId, Record<Tier, Effort>> = {
  claude: { fast: "low", standard: "high", deep: "high" },
  chatgpt: { fast: "low", standard: "medium", deep: "high" },
};

/** "gpt-6.1-sol" → version 6.1, family "sol". */
function gptParts(id: string): { id: string; version: number; family: string } {
  const match = /gpt-(\d+(?:\.\d+)?)(?:-([a-z]+))?/i.exec(id);
  return { id, version: Number(match?.[1] ?? 0), family: (match?.[2] ?? "").toLowerCase() };
}

/** TOT's default ChatGPT model for a tier, from the models the account offers (its default listed first). */
export function defaultChatgptModel(tier: Tier, available: string[]): string | undefined {
  if (!available.length) return undefined;
  const deep = available[0]!;
  if (tier === "deep") return deep;
  const newest = (family: string) =>
    available
      .map(gptParts)
      .filter((model) => model.family === family && model.id !== deep)
      .sort((a, b) => b.version - a.version)[0]?.id;
  const standard = newest("sol") ?? deep;
  return tier === "standard" ? standard : (newest("luna") ?? standard);
}

/** The model and effort a tier uses on a provider; null when the provider isn't connected. */
export function tierModel(tier: Tier, provider: ProviderId, statuses: ProviderStatus[]): { model: string; effort: Effort } | null {
  const status = statuses.find((s) => s.id === provider);
  if (!status?.loggedIn) return null;
  const available = status.models.filter((m) => m.available).map((m) => m.model);
  const chosen = settings.get().models.tiers[tier][provider];
  const model = chosen && available.includes(chosen) ? chosen : provider === "claude" ? CLAUDE_DEFAULTS[tier] : defaultChatgptModel(tier, available);
  return model ? { model, effort: EFFORTS[provider][tier] } : null;
}

export interface TierPick {
  provider: ProviderId;
  model: string;
  effort: Effort;
  /** Why it isn't on the provider TOT would normally use, e.g. "Claude at its usage limit". */
  note?: string;
}

/**
 * Picks the provider and model for a tier: the preferred provider when it's connected and not
 * at its limit, else Claude, else ChatGPT; a provider at its limit only when nothing else is up.
 */
export function pickTier(
  tier: Tier,
  opts: { statuses: ProviderStatus[]; limited: ReadonlySet<ProviderId>; prefer?: ProviderId | null; thinkHarder?: boolean },
): TierPick | null {
  const candidates = opts.prefer ? [opts.prefer, ...PROVIDERS.filter((p) => p !== opts.prefer)] : PROVIDERS;
  const up = candidates.filter((provider) => tierModel(tier, provider, opts.statuses));
  const provider = up.find((p) => !opts.limited.has(p)) ?? up[0];
  if (!provider) return null;
  const { model, effort } = tierModel(tier, provider, opts.statuses)!;
  const first = candidates[0]!;
  const label = (id: ProviderId) => opts.statuses.find((s) => s.id === id)?.label ?? id;
  const note =
    provider === first
      ? undefined
      : opts.statuses.find((s) => s.id === first)?.loggedIn
        ? `${label(first)} at its usage limit`
        : `${label(first)} not connected`;
  return { provider, model, effort: opts.thinkHarder && tier === "deep" ? "xhigh" : effort, ...(note ? { note } : {}) };
}

/** The tier a role runs on by default (Settings → Models). */
export function roleTier(role: Role): Tier {
  return settings.get().models.roles[role];
}
