import type { Settings, SettingsPatch } from "@shared/types";

/** Write-only secrets typed in the Settings dialog. Empty = leave the stored key alone. */
export interface SecretDrafts {
  anthropicApiKey: string;
  boatApiKey: string;
  clearAnthropicApiKey: boolean;
  clearBoatApiKey: boolean;
}

/** Props shared by the General / Models / Computer settings sections. */
export interface SettingsSectionProps {
  draft: Settings;
  onChange: (next: Settings) => void;
  secrets: SecretDrafts;
  /** Takes an updater so several edits in one event can't clobber each other. */
  onSecretsChange: (update: (current: SecretDrafts) => SecretDrafts) => void;
}

export const EMPTY_SECRETS: SecretDrafts = {
  anthropicApiKey: "",
  boatApiKey: "",
  clearAnthropicApiKey: false,
  clearBoatApiKey: false,
};

function changed<T extends object, K extends keyof T>(before: T, after: T, keys: K[]): Partial<Pick<T, K>> | undefined {
  const out: Partial<Pick<T, K>> = {};
  let any = false;
  for (const key of keys) {
    if (before[key] !== after[key]) {
      out[key] = after[key];
      any = true;
    }
  }
  return any ? out : undefined;
}

/** Minimal PATCH body: only fields that differ from what the server has, plus typed secrets. */
export function buildSettingsPatch(saved: Settings, draft: Settings, secrets: SecretDrafts): SettingsPatch {
  const patch: SettingsPatch = {
    ...changed(saved, draft, ["userName", "customInstructions", "defaultModelId"]),
  };
  const computer = changed(saved.computer, draft.computer, ["mode", "size", "idleStopMinutes"]);
  if (computer) patch.computer = computer;
  const memory = changed(saved.memory, draft.memory, ["enabled"]);
  if (memory) patch.memory = memory;
  const claude = changed(saved.claude, draft.claude, ["authMode", "useConnectedApps"]);
  if (claude) patch.claude = claude;
  const chatgpt = changed(saved.chatgpt, draft.chatgpt, ["useConnectedApps"]);
  if (chatgpt) patch.chatgpt = chatgpt;
  const tasks = changed(saved.tasks, draft.tasks, [
    "perAgentLimit",
    "globalLimit",
    "resumeInterrupted",
    "notifySlackUserId",
    "wakeChats",
    "switchProviders",
    "maxChildren",
    "worktreeCleanupDays",
  ]);
  if (tasks) patch.tasks = tasks;
  // Model tiers are small nested tables: send them whole when anything in them changed.
  if (JSON.stringify(saved.models) !== JSON.stringify(draft.models)) patch.models = draft.models;

  const anthropicKey = secrets.anthropicApiKey.trim();
  if (anthropicKey) patch.anthropicApiKey = anthropicKey;
  else if (secrets.clearAnthropicApiKey) patch.anthropicApiKey = "";

  const boatKey = secrets.boatApiKey.trim();
  if (boatKey) patch.boatApiKey = boatKey;
  else if (secrets.clearBoatApiKey) patch.boatApiKey = "";

  return patch;
}

export const IDLE_MINUTES = { min: 1, max: 1440 };

export function isValidIdleMinutes(value: number): boolean {
  return Number.isInteger(value) && value >= IDLE_MINUTES.min && value <= IDLE_MINUTES.max;
}

export const TASK_LIMITS = { perAgent: 10, global: 20, children: 20 };

export function isValidTaskLimit(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= max;
}

/** Days before a finished, unlanded task's worktree is removed: 0 (never) to 365. */
export const CLEANUP_DAYS = { min: 0, max: 365 };

export function isValidCleanupDays(value: number): boolean {
  return Number.isInteger(value) && value >= CLEANUP_DAYS.min && value <= CLEANUP_DAYS.max;
}

