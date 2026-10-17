import type { Effort, ProviderId, ProviderStatus, Tier } from "@tot/shared/types";
import { accounts } from "../accounts/accounts.ts";
import { PROVIDERS, pickTier, tierModel } from "../orchestration/tiers.ts";

export { CLAUDE_OPUS, CLAUDE_SONNET } from "../orchestration/tiers.ts";

export interface Route {
  provider: ProviderId;
  /** The provider account the turn runs on; the built-in one ("claude" / "chatgpt") unless another was picked. */
  account: string;
  model: string;
  effort: Effort;
  /** Shown to the user under the reply, e.g. "Auto · coding task → Opus 5.5". */
  reason: string;
}

/** "<account>:<model>" → its provider, account and model; "auto" for Auto and for ids of accounts that don't exist. */
export function parseModelId(modelId: string): { provider: ProviderId; account: string; model: string } | "auto" {
  if (modelId === "auto") return "auto";
  const [account = "", ...rest] = modelId.split(":");
  const model = rest.join(":");
  const provider = model ? accounts.driverOf(account) : null;
  return provider ? { provider, account, model } : "auto";
}

export type Complexity = { complex: false } | { complex: true; why: string };

// Signals that a turn deserves the strongest model. Everything else is a quick ask.
const SIGNALS: [RegExp, string][] = [
  [/```|\b(stack ?trace|traceback|exception|segfault|compile error|TypeError|undefined is not)\b/i, "debugging"],
  [
    /\b(build|implement|develop|code|program|refactor|debug|fix|optimi[sz]e|migrate|deploy|scaffold)\b.{0,60}\b(app|site|website|api|server|service|function|class|component|script|program|system|bug|error|code|database|schema|pipeline|game|tool|feature|page|extension|bot)\b/is,
    "coding task",
  ],
  [/\b(on (your|the) computer|in (a|the) terminal|install|run (it|this|the)|spin up|docker|git(hub)? repo)\b/i, "uses the computer"],
  [
    /\b(analy[sz]e|research|investigate|compare|evaluate|prove|derive|architect|design (a|an|the)|strategy|business plan|step[- ]by[- ]step|in[- ]depth|thorough(ly)?|comprehensive|deep dive)\b/i,
    "deep analysis",
  ],
];

export function assessComplexity(text: string): Complexity {
  if (text.length > 900) return { complex: true, why: "long request" };
  for (const [pattern, why] of SIGNALS) if (pattern.test(text)) return { complex: true, why };
  return { complex: false };
}

export type RouteResult = { ok: true; route: Route } | { ok: false; error: string };

/** TOT's efforts, lowest first. */
export const EFFORT_LEVELS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export interface RouteOptions {
  thinkHarder?: boolean;
  /** A picked model's effort, chosen for the chat; without it, TOT picks one from the turn. Auto ignores it. */
  effort?: Effort;
  statuses: ProviderStatus[];
  /** Accounts (built-in ones by their provider id) in a usage-limit cooldown; Auto avoids them while an alternative exists. */
  limited: ReadonlySet<string>;
  /**
   * Every provider account's status (`accountId` set). With it, a picked model runs on its own account and Auto on
   * each provider's default account (Settings → Models); without it, only the built-in accounts in `statuses` count.
   */
  accounts?: ProviderStatus[];
  /** Overrides the text-based guess, e.g. for work TOT itself started (studying a repo). */
  complexity?: Complexity;
  /** Auto only: the model tier to use, whatever the text looks like (a task's role, a dispatch decision). */
  tier?: Tier;
  /** Auto only: run on this provider when it's connected and not at its limit (e.g. a reviewer on the other provider). */
  prefer?: ProviderId | null;
}

function modelLabel(statuses: ProviderStatus[], provider: ProviderId, model: string): string {
  const label = statuses.find((s) => s.id === provider)?.models.find((m) => m.model === model)?.label ?? model;
  return label.replace(/^Claude /, "");
}

/**
 * Resolves the model for a turn. "auto" runs on a tier (see orchestration/tiers.ts): the one
 * asked for, else fast for light turns (Sonnet 5.5, low effort) and deep for complex ones
 * (Opus 5.5); "Think harder" always gets deep at xhigh. When Claude is unavailable or
 * rate-limited, Auto uses the same tier on ChatGPT.
 */
export function resolveRoute(modelId: string, text: string, opts: RouteOptions): RouteResult {
  const ofAccount = (id: string) => (opts.accounts ?? opts.statuses).find((s) => (s.accountId ?? s.id) === id);
  const complexity = opts.complexity ?? assessComplexity(text);
  const parsed = parseModelId(modelId);

  if (parsed !== "auto") {
    const picked = ofAccount(parsed.account);
    if (!picked?.loggedIn) {
      return { ok: false, error: `${picked?.label ?? parsed.account} isn't connected. ${picked?.detail ?? ""}`.trim() };
    }
    const chosen: Effort = opts.effort ?? (parsed.provider === "claude" || complexity.complex ? "high" : "medium");
    // "Think harder" raises the effort to at least xhigh, never lowers it.
    const effort: Effort = opts.thinkHarder && EFFORT_LEVELS.indexOf(chosen) < EFFORT_LEVELS.indexOf("xhigh") ? "xhigh" : chosen;
    return { ok: true, route: { ...parsed, effort, reason: opts.thinkHarder ? "Think harder" : "Picked by you" } };
  }

  const tier: Tier = opts.thinkHarder ? "deep" : (opts.tier ?? (complexity.complex ? "deep" : "fast"));
  const why = opts.thinkHarder ? "think harder" : complexity.complex ? complexity.why : opts.tier ? `${opts.tier} tier` : "quick ask";
  // Auto runs each provider on its default account: tiers see that account's status and cooldown as the provider's.
  // When the default is at its limit or signed out, another signed-in account of the same provider stands in, before
  // Auto moves to the other provider.
  const usable = (id: string) => Boolean(ofAccount(id)?.loggedIn) && !opts.limited.has(id);
  const accountOf = (provider: ProviderId): string => {
    if (!opts.accounts) return provider;
    const preferred = accounts.defaultId(provider);
    if (usable(preferred)) return preferred;
    const other = opts.accounts.find((s) => s.id === provider && s.accountId && usable(s.accountId));
    return other?.accountId ?? preferred;
  };
  const statuses = opts.accounts
    ? PROVIDERS.flatMap((provider) => {
        const status = ofAccount(accountOf(provider)) ?? ofAccount(provider);
        return status ? [{ ...status, id: provider }] : [];
      })
    : opts.statuses;
  const limited = opts.accounts ? new Set(PROVIDERS.filter((provider) => opts.limited.has(accountOf(provider)))) : opts.limited;
  const picked = pickTier(tier, { statuses, limited, prefer: opts.prefer, thinkHarder: opts.thinkHarder });
  if (!picked) {
    return {
      ok: false,
      error: "No model provider is connected. Log in to Claude Code (`claude`) or Codex (`codex login`), then reload.",
    };
  }
  const { provider, model, effort, note } = picked;
  return {
    ok: true,
    route: {
      provider,
      account: statuses.find((s) => s.id === provider)?.accountId ?? provider,
      model,
      effort,
      reason: `Auto · ${why} → ${modelLabel(statuses, provider, model)}${note ? ` (${note})` : ""}`,
    },
  };
}

/**
 * The model for one-shot work TOT does itself on a given provider — light (fast tier) for
 * drafting and classifying, heavy (deep tier) for reviewing code — with the same tiers as Auto.
 * Null when the provider has none.
 */
export function modelForWork(provider: ProviderId, heavy: boolean, statuses: ProviderStatus[]): string | null {
  return tierModel(heavy ? "deep" : "fast", provider, statuses)?.model ?? null;
}
