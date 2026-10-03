import type { Effort, ProviderId, ProviderStatus, Tier } from "../../shared/types.ts";
import { pickTier } from "../orchestration/tiers.ts";

export { CLAUDE_OPUS, CLAUDE_SONNET } from "../orchestration/tiers.ts";

export interface Route {
  provider: ProviderId;
  model: string;
  effort: Effort;
  /** Shown to the user under the reply, e.g. "Auto · coding task → Opus 5.5". */
  reason: string;
}

export function parseModelId(modelId: string): { provider: ProviderId; model: string } | "auto" {
  if (modelId === "auto") return "auto";
  const [provider, ...rest] = modelId.split(":");
  const model = rest.join(":");
  if ((provider === "claude" || provider === "chatgpt") && model) return { provider, model };
  return "auto";
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

export interface RouteOptions {
  thinkHarder?: boolean;
  statuses: ProviderStatus[];
  /** Providers in a usage-limit cooldown; Auto avoids them while an alternative exists. */
  limited: ReadonlySet<ProviderId>;
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
  const status = (id: ProviderId) => opts.statuses.find((s) => s.id === id);
  const complexity = opts.complexity ?? assessComplexity(text);
  const parsed = parseModelId(modelId);

  if (parsed !== "auto") {
    const picked = status(parsed.provider);
    if (!picked?.loggedIn) {
      return { ok: false, error: `${picked?.label ?? parsed.provider} isn't connected. ${picked?.detail ?? ""}`.trim() };
    }
    const effort: Effort = opts.thinkHarder ? "xhigh" : parsed.provider === "claude" || complexity.complex ? "high" : "medium";
    return { ok: true, route: { ...parsed, effort, reason: opts.thinkHarder ? "Think harder" : "Picked by you" } };
  }

  const tier: Tier = opts.thinkHarder ? "deep" : (opts.tier ?? (complexity.complex ? "deep" : "fast"));
  const why = opts.thinkHarder ? "think harder" : complexity.complex ? complexity.why : opts.tier ? `${opts.tier} tier` : "quick ask";
  const picked = pickTier(tier, { statuses: opts.statuses, limited: opts.limited, prefer: opts.prefer, thinkHarder: opts.thinkHarder });
  if (!picked) {
    return {
      ok: false,
      error: "No model provider is connected. Log in to Claude Code (`claude`) or Codex (`codex login`), then reload.",
    };
  }
  const { provider, model, effort, note } = picked;
  return {
    ok: true,
    route: { provider, model, effort, reason: `Auto · ${why} → ${modelLabel(opts.statuses, provider, model)}${note ? ` (${note})` : ""}` },
  };
}
