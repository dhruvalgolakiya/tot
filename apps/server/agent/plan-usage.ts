import type { PlanUsage, PlanUsageWindow } from "@tot/shared/types";

/**
 * Each provider account's plan limits as it last reported them, for the composer's context meter: Claude Code sends
 * a rate-limit event when a window's standing changes (5-hour, weekly), Codex its windows' percentages with every
 * update. Kept in memory: after a restart they come back with the next turn.
 */

const usage = new Map<string, PlanUsage>();

const CLAUDE_WINDOWS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly Opus",
  seven_day_sonnet: "Weekly Sonnet",
};

function put(accountId: string, window: PlanUsageWindow): void {
  const windows = (usage.get(accountId)?.windows ?? []).filter((entry) => entry.label !== window.label);
  usage.set(accountId, { windows: [...windows, window].sort((a, b) => order(a.label) - order(b.label)), updatedAt: Date.now() });
}

const order = (label: string) => (label === "5-hour" ? 0 : label === "Weekly" ? 1 : 2);

/** Codex's window length in minutes, as a label: 300 is the 5-hour one, 10080 the weekly one. */
function codexLabel(minutes: number | null | undefined, fallback: string): string {
  if (minutes === 300) return "5-hour";
  if (minutes === 10_080) return "Weekly";
  if (!minutes) return fallback;
  return minutes % 1440 === 0 ? `${minutes / 1440}-day` : minutes % 60 === 0 ? `${minutes / 60}-hour` : fallback;
}

type CodexWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null | undefined;

export const planUsage = {
  /** A Claude Code `rate_limit_event`'s info: its window's standing (utilization is a 0-1 fraction, resetsAt in seconds). */
  fromClaude(accountId: string, info: { status?: string; rateLimitType?: string; utilization?: number; resetsAt?: number }): void {
    const label = info.rateLimitType ? CLAUDE_WINDOWS[info.rateLimitType] : undefined;
    if (!label) return;
    const reached = info.status === "rejected";
    const percent = typeof info.utilization === "number" ? Math.round(info.utilization * 100) : reached ? 100 : null;
    put(accountId, { label, usedPercent: percent, resetsAt: info.resetsAt ? info.resetsAt * 1000 : null, ...(reached ? { reached } : {}) });
  },

  /** Codex's rate-limit snapshot: its primary and secondary windows (resetsAt in seconds). */
  fromCodex(accountId: string, limits: { primary?: CodexWindow; secondary?: CodexWindow } | null): void {
    for (const [window, fallback] of [
      [limits?.primary, "Short window"],
      [limits?.secondary, "Long window"],
    ] as const) {
      if (!window) continue;
      put(accountId, {
        label: codexLabel(window.windowDurationMins, fallback),
        usedPercent: Math.round(window.usedPercent),
        resetsAt: window.resetsAt ? window.resetsAt * 1000 : null,
        ...(window.usedPercent >= 100 ? { reached: true } : {}),
      });
    }
  },

  all(): Record<string, PlanUsage> {
    return Object.fromEntries(usage);
  },
};
