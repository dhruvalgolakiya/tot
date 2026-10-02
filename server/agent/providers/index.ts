import type { ModelOption, ProviderId, ProviderStatus } from "../../../shared/types.ts";
import { limits } from "../limits.ts";
import { chatgptProvider } from "./chatgpt.ts";
import { claudeProvider } from "./claude.ts";
import type { AgentProvider } from "./types.ts";

export const providers: Record<ProviderId, AgentProvider> = {
  claude: claudeProvider,
  chatgpt: chatgptProvider,
};

const STATUS_TTL_MS = 30_000;
let cached: { at: number; statuses: Promise<ProviderStatus[]> } | null = null;

async function loadStatuses(): Promise<ProviderStatus[]> {
  return Promise.all(
    Object.values(providers).map((provider) =>
      provider.status().catch(
        (err): ProviderStatus => ({
          id: provider.id,
          label: provider.label,
          installed: false,
          loggedIn: false,
          detail: `Couldn't check ${provider.label}: ${err instanceof Error ? err.message : String(err)}`,
          models: [],
        }),
      ),
    ),
  );
}

/** Provider statuses, with any running usage-limit cooldown surfaced in `detail`. */
export async function providerStatuses(refresh = false): Promise<ProviderStatus[]> {
  if (refresh || !cached || Date.now() - cached.at > STATUS_TTL_MS) {
    cached = { at: Date.now(), statuses: loadStatuses() };
  }
  return (await cached.statuses).map((status) => {
    const limit = limits.message(status.id);
    return limit ? { ...status, detail: `Usage limit reached: ${limit}` } : status;
  });
}

export async function modelOptions(): Promise<ModelOption[]> {
  const statuses = await providerStatuses();
  const claude = statuses.find((s) => s.id === "claude")?.loggedIn;
  const chatgpt = statuses.find((s) => s.id === "chatgpt")?.loggedIn;
  const auto: ModelOption = {
    id: "auto",
    provider: "auto",
    model: "auto",
    label: "TOT Auto",
    description: claude
      ? "Sonnet 5.5 for quick asks, Opus 5.5 for hard ones — ChatGPT when Claude is at its limit"
      : "Routes to ChatGPT until Claude is connected",
    available: Boolean(claude || chatgpt),
    unavailableReason: claude || chatgpt ? undefined : "Connect Claude or ChatGPT first",
  };
  return [auto, ...statuses.flatMap((s) => s.models)];
}
