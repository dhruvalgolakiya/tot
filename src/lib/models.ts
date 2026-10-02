import type { Message, ModelOption, ProviderId } from "@shared/types";

export const AUTO_MODEL_ID = "auto";
export const AUTO_LABEL = "TOT Auto";
export const AUTO_DESCRIPTION = "Sonnet 5.5 for quick asks, Opus 5.5 for hard ones";

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
};

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
  const match = models.find(
    (m) => m.model === message.model && (!message.provider || m.provider === message.provider),
  );
  return match?.label ?? message.model;
}

export function groupModels(models: ModelOption[]) {
  return {
    auto: models.filter((m) => m.provider === "auto"),
    claude: models.filter((m) => m.provider === "claude"),
    chatgpt: models.filter((m) => m.provider === "chatgpt"),
  };
}

/**
 * `<Select>` options for picking a model: the current model first if it isn't in the list yet (the list
 * hasn't loaded, or it's since been retired), then Auto ungrouped, then Claude and ChatGPT as labeled groups.
 * Shaped to match `SelectOption`/`SelectOptionGroup` structurally, without importing the UI types here.
 */
export function modelSelectOptions(models: ModelOption[], currentId: string) {
  const groups = groupModels(models);
  const known = models.some((m) => m.id === currentId);
  const toOption = (model: ModelOption) => ({ value: model.id, label: model.label, disabled: !model.available });
  return [
    ...(known ? [] : [{ value: currentId, label: modelLabel(models, currentId) }]),
    ...groups.auto.map((model) => ({ value: model.id, label: displayLabel(model), disabled: !model.available })),
    ...(groups.claude.length > 0 ? [{ label: "Claude", options: groups.claude.map(toOption) }] : []),
    ...(groups.chatgpt.length > 0 ? [{ label: "ChatGPT", options: groups.chatgpt.map(toOption) }] : []),
  ];
}
