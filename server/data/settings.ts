import type { ModelTierSettings, Settings, SettingsPatch } from "../../shared/types.ts";
import { getSecret, setSecret } from "../config.ts";
import { db, parseJson, type Row } from "../db.ts";

type StoredSettings = Omit<Settings, "computer" | "claude"> & {
  computer: Omit<Settings["computer"], "boatApiKeySet">;
  claude: Omit<Settings["claude"], "apiKeySet">;
};

function defaults(): StoredSettings {
  return {
    defaultModelId: "auto",
    userName: "",
    customInstructions: "",
    // Cloud VMs when a Boat key exists, otherwise a sandboxed local folder so tools work out of the box.
    computer: { mode: getSecret("boatApiKey") ? "boat" : "local", size: "default", idleStopMinutes: 10 },
    memory: { enabled: true },
    claude: { authMode: "subscription", useConnectedApps: true },
    chatgpt: { useConnectedApps: true },
    tasks: {
      perAgentLimit: 4,
      globalLimit: 8,
      resumeInterrupted: true,
      notifySlackUserId: null,
      wakeChats: true,
      switchProviders: true,
      missionTokenBudget: 5_000_000,
      maxChildren: 6,
      worktreeCleanupDays: 14,
    },
    models: {
      tiers: { fast: { claude: null, chatgpt: null }, standard: { claude: null, chatgpt: null }, deep: { claude: null, chatgpt: null } },
      roles: { explorer: "fast", planner: "deep", implementer: "deep", tester: "standard", reviewer: "deep", researcher: "standard", writer: "standard" },
    },
  };
}

/** Tier choices merge per tier and provider, so changing one model keeps the others. */
function mergeModels(base: ModelTierSettings, patch: Partial<ModelTierSettings> | undefined): ModelTierSettings {
  return {
    tiers: {
      fast: { ...base.tiers.fast, ...patch?.tiers?.fast },
      standard: { ...base.tiers.standard, ...patch?.tiers?.standard },
      deep: { ...base.tiers.deep, ...patch?.tiers?.deep },
    },
    roles: { ...base.roles, ...patch?.roles },
  };
}

function readStored(): StoredSettings {
  const base = defaults();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'settings'`).get() as Row | undefined;
  const stored = parseJson<Partial<StoredSettings>>(row?.value, {});
  return {
    ...base,
    ...stored,
    computer: { ...base.computer, ...stored.computer },
    memory: { ...base.memory, ...stored.memory },
    claude: { ...base.claude, ...stored.claude },
    chatgpt: { ...base.chatgpt, ...stored.chatgpt },
    tasks: { ...base.tasks, ...stored.tasks },
    models: mergeModels(base.models, stored.models),
  };
}

function withSecretFlags(stored: StoredSettings): Settings {
  return {
    ...stored,
    computer: { ...stored.computer, boatApiKeySet: Boolean(getSecret("boatApiKey")) },
    claude: { ...stored.claude, apiKeySet: Boolean(getSecret("anthropicApiKey")) },
  };
}

export const settings = {
  get(): Settings {
    return withSecretFlags(readStored());
  },

  patch(patch: SettingsPatch): Settings {
    const current = readStored();
    const { boatApiKey, anthropicApiKey, computer, memory, claude, chatgpt, tasks, models, ...top } = patch;

    if (boatApiKey !== undefined) setSecret("boatApiKey", boatApiKey.trim());
    if (anthropicApiKey !== undefined) setSecret("anthropicApiKey", anthropicApiKey.trim());

    const next: StoredSettings = {
      ...current,
      ...top,
      computer: { ...current.computer, ...computer },
      memory: { ...current.memory, ...memory },
      claude: { ...current.claude, ...claude },
      chatgpt: { ...current.chatgpt, ...chatgpt },
      tasks: { ...current.tasks, ...tasks },
      models: mergeModels(current.models, models),
    };
    // Adding a Boat key is a clear signal: switch local computers to Boat unless told otherwise.
    if (boatApiKey && !computer?.mode) next.computer.mode = "boat";

    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(JSON.stringify(next));
    return withSecretFlags(next);
  },
};
