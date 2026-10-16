import type { ModelOption, ProviderId, Role, Tier } from "@tot/shared/types";

/**
 * Model labels and grouping, ported from apps/web/src/lib/models.ts and apps/web/src/lib/orchestration.ts: TOT Auto
 * first, then each provider account's models under its name ("Claude", "Claude Mix", "ChatGPT").
 */

export const AUTO_MODEL_ID = "auto";

/** One empty list, so a store selector that finds no models returns the same value each time (a new [] re-renders forever). */
export const NO_MODELS: ModelOption[] = [];
export const AUTO_LABEL = "TOT Auto";
export const AUTO_DESCRIPTION = "Sonnet 5.5 for quick asks, Opus 5.5 for hard ones";

export const PROVIDERS: ProviderId[] = ["claude", "chatgpt"];
export const PROVIDER_LABELS: Record<ProviderId, string> = { claude: "Claude", chatgpt: "ChatGPT" };

export function displayLabel(model: ModelOption): string {
  return model.provider === "auto" ? AUTO_LABEL : model.label;
}

export function displayDescription(model: ModelOption): string | undefined {
  return model.provider === "auto" ? (model.description ?? AUTO_DESCRIPTION) : model.description;
}

/** Label for a model id, even before the list has loaded (or for a model since retired). */
export function modelLabel(models: ModelOption[], id: string): string {
  if (id === AUTO_MODEL_ID) return AUTO_LABEL;
  const match = models.find((m) => m.id === id);
  if (match) return displayLabel(match);
  return id.slice(id.indexOf(":") + 1) || id;
}

export interface ModelGroup {
  accountId: string;
  label: string;
  models: ModelOption[];
}

/** Auto, then one group per account in the server's order (Claude accounts, then ChatGPT ones). */
export function groupModels(models: ModelOption[]): { auto: ModelOption[]; groups: ModelGroup[] } {
  const groups: ModelGroup[] = [];
  for (const model of models) {
    if (model.provider === "auto") continue;
    const accountId = model.accountId ?? model.provider;
    let group = groups.find((g) => g.accountId === accountId);
    if (!group) groups.push((group = { accountId, label: model.accountName ?? PROVIDER_LABELS[model.provider], models: [] }));
    group.models.push(model);
  }
  return { auto: models.filter((m) => m.provider === "auto"), groups };
}

export const TIERS: Tier[] = ["fast", "standard", "deep"];
export const TIER_LABELS: Record<Tier, string> = { fast: "Fast", standard: "Standard", deep: "Deep" };
export const TIER_DESCRIPTIONS: Record<Tier, string> = {
  fast: "Searching, classifying, quick answers",
  standard: "Most work: research, tests, writing",
  deep: "The hard change",
};

export const ROLE_LABELS: Record<Role, string> = {
  explorer: "Explorer",
  planner: "Planner",
  implementer: "Implementer",
  tester: "Tester",
  reviewer: "Reviewer",
  researcher: "Researcher",
  writer: "Writer",
};
export const ROLES = Object.keys(ROLE_LABELS) as Role[];

/** TOT's own pick for a tier when nothing is chosen (mirrors the web's TierSettings, for the label). */
export function defaultTierLabel(tier: Tier, provider: ProviderId, models: { model: string; label: string }[]): string {
  if (provider === "claude") return tier === "deep" ? "Opus 5.5" : "Sonnet 5.5";
  const deep = models[0];
  const version = (model: string) => Number(/gpt-(\d+(?:\.\d+)?)/.exec(model)?.[1] ?? 0);
  const newest = (family: string) =>
    models.filter((m) => m.model !== deep?.model && new RegExp(`-${family}$`).test(m.model)).sort((a, b) => version(b.model) - version(a.model))[0];
  const standard = newest("sol") ?? deep;
  const pick = tier === "deep" ? deep : tier === "standard" ? standard : (newest("luna") ?? standard);
  return pick?.label ?? "None available";
}
