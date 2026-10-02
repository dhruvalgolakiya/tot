import type { Effort, ProviderId, ProviderStatus } from "../../shared/types.ts";

export const CLAUDE_OPUS = "claude-opus-5-5";
export const CLAUDE_SONNET = "claude-sonnet-5-5";

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
}

function modelLabel(statuses: ProviderStatus[], provider: ProviderId, model: string): string {
  const label = statuses.find((s) => s.id === provider)?.models.find((m) => m.model === model)?.label ?? model;
  return label.replace(/^Claude /, "");
}

/**
 * Resolves the model for a turn. "auto" keeps light turns on Sonnet 5.5 (fast)
 * and sends complex ones to Opus 5.5; "Think harder" always gets the strongest
 * model at xhigh. When Claude is unavailable or rate-limited, Auto tiers the
 * ChatGPT models the same way.
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

  const chatgptModels = (status("chatgpt")?.models ?? []).filter((m) => m.available).map((m) => m.model);
  const claudeUp = Boolean(status("claude")?.loggedIn);
  const chatgptUp = Boolean(status("chatgpt")?.loggedIn) && chatgptModels.length > 0;
  const claudeFirst = claudeUp && (!opts.limited.has("claude") || !chatgptUp || opts.limited.has("chatgpt"));

  if (claudeFirst) {
    if (opts.thinkHarder) {
      return { ok: true, route: { provider: "claude", model: CLAUDE_OPUS, effort: "xhigh", reason: "Auto · think harder → Opus 5.5" } };
    }
    if (complexity.complex) {
      return { ok: true, route: { provider: "claude", model: CLAUDE_OPUS, effort: "high", reason: `Auto · ${complexity.why} → Opus 5.5` } };
    }
    return { ok: true, route: { provider: "claude", model: CLAUDE_SONNET, effort: "low", reason: "Auto · quick ask → Sonnet 5.5" } };
  }

  if (chatgptUp) {
    const { light, heavy } = chatgptTiers(chatgptModels);
    const heavyTurn = opts.thinkHarder || complexity.complex;
    const model = heavyTurn ? heavy : light;
    const effort: Effort = opts.thinkHarder ? "xhigh" : complexity.complex ? "high" : "low";
    const why = opts.thinkHarder ? "think harder" : complexity.complex ? complexity.why : "quick ask";
    const because = claudeUp ? "Claude at its usage limit" : "Claude not connected";
    return {
      ok: true,
      route: {
        provider: "chatgpt",
        model,
        effort,
        reason: `Auto · ${why} → ${modelLabel(opts.statuses, "chatgpt", model)} (${because})`,
      },
    };
  }

  return {
    ok: false,
    error: "No model provider is connected. Log in to Claude Code (`claude`) or Codex (`codex login`), then reload.",
  };
}

/** Default model (listed first) for quick asks; the frontier model for hard ones when the plan has it. */
function chatgptTiers(models: string[]): { light: string; heavy: string } {
  const light = models[0];
  return { light, heavy: models.find((m) => /astra/i.test(m)) ?? light };
}

/**
 * The model for one-shot work TOT does itself on a given provider — light for drafting and
 * classifying, heavy for reviewing code — with the same tiers as Auto. Null when the provider has none.
 */
export function modelForWork(provider: ProviderId, heavy: boolean, statuses: ProviderStatus[]): string | null {
  if (provider === "claude") return heavy ? CLAUDE_OPUS : CLAUDE_SONNET;
  const models = (statuses.find((s) => s.id === "chatgpt")?.models ?? []).filter((m) => m.available).map((m) => m.model);
  if (!models.length) return null;
  const tiers = chatgptTiers(models);
  return heavy ? tiers.heavy : tiers.light;
}
