import type { Effort, Message, ModelOption, ProviderId } from "@tot/shared/types";

export const AUTO_MODEL_ID = "auto";
export const AUTO_LABEL = "TOT Auto";
export const AUTO_DESCRIPTION = "Sonnet 5.5 for quick asks, Opus 5.5 for hard ones";

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
};

/** Reasoning efforts as the model menu names them (short enough to sit side by side). */
export const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-high",
  max: "Max",
};

/** Models (and their account) that match every word of a query: the model menu's search. */
export function filterModels(models: ModelOption[], query: string): ModelOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return models;
  return models.filter((model) => {
    const text = `${displayLabel(model)} ${model.model} ${model.accountName ?? PROVIDER_LABELS[model.provider as ProviderId] ?? ""} ${displayDescription(model) ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function displayLabel(model: ModelOption): string {
  return model.provider === "auto" ? AUTO_LABEL : model.label;
}

export function displayDescription(model: ModelOption): string | undefined {
  return model.provider === "auto" ? (model.description ?? AUTO_DESCRIPTION) : model.description;
}

/** Label for a ModelOption id, even before the model list has loaded. */
export function modelLabel(models: ModelOption[], id: string): string {
  if (id === AUTO_MODEL_ID) return AUTO_LABEL;
  const match = models.find((m) => m.id === id);
  if (match) return displayLabel(match);
  return id.slice(id.indexOf(":") + 1) || id;
}

/** Label for the model that actually answered a message. */
export function answeredByLabel(models: ModelOption[], message: Message): string | null {
  if (!message.model) return null;
  const account = message.account ?? message.provider;
  const match =
    models.find((m) => m.model === message.model && (!account || (m.accountId ?? m.provider) === account)) ??
    models.find((m) => m.model === message.model && (!message.provider || m.provider === message.provider));
  return match?.label ?? message.model;
}

/** A provider account's models, under its name (the model menu's groups, like T3 Code's: "Claude Mix", "Codex"). */
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

/**
 * `<Select>` options for picking a model: the current model first if it isn't in the list yet (the list
 * hasn't loaded, or it's since been retired), then Auto ungrouped, then each account's models as a labeled group.
 * Shaped to match `SelectOption`/`SelectOptionGroup` structurally, without importing the UI types here.
 */
export function modelSelectOptions(models: ModelOption[], currentId: string) {
  const { auto, groups } = groupModels(models);
  const known = models.some((m) => m.id === currentId);
  const toOption = (model: ModelOption) => ({ value: model.id, label: model.label, disabled: !model.available });
  return [
    ...(known ? [] : [{ value: currentId, label: modelLabel(models, currentId) }]),
    ...auto.map((model) => ({ value: model.id, label: displayLabel(model), disabled: !model.available })),
    ...groups.map((group) => ({ label: group.label, options: group.models.map(toOption) })),
  ];
}
