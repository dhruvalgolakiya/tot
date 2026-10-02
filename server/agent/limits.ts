import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderId } from "../../shared/types.ts";
import { DATA_DIR } from "../config.ts";

/** After a usage-limit error without a readable reset time, Auto avoids that provider this long. */
const DEFAULT_COOLDOWN_MS = 15 * 60_000;
const MAX_COOLDOWN_MS = 24 * 60 * 60_000;

// Persisted so a server restart doesn't send the next turn into a known limit.
const FILE = join(DATA_DIR, "limits.json");
const limited = new Map<ProviderId, { until: number; message: string }>(
  existsSync(FILE) ? Object.entries(JSON.parse(readFileSync(FILE, "utf8"))) as [ProviderId, { until: number; message: string }][] : [],
);
const save = () => writeFileSync(FILE, JSON.stringify(Object.fromEntries(limited)));

/**
 * Reads reset times like "resets 7:30am (Asia/Calcutta)" and returns the next
 * matching moment, or undefined when the text doesn't say.
 */
export function parseResetTime(message: string, now = Date.now()): number | undefined {
  const match = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?/i.exec(message);
  if (!match) return undefined;
  const [, h, m = "0", meridiem, zone] = match;
  const hour = (Number(h) % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      })
        .formatToParts(new Date(now))
        .map((p) => [p.type, Number(p.value)]),
    );
    // Offset between the zone's wall clock and UTC right now.
    const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - now;
    let target = Date.UTC(parts.year, parts.month - 1, parts.day, hour, Number(m)) - offset;
    if (target <= now) target += 24 * 60 * 60_000;
    return target;
  } catch {
    return undefined;
  }
}

export const limits = {
  mark(provider: ProviderId, message: string): void {
    const reset = parseResetTime(message);
    const until = reset ? Math.min(reset, Date.now() + MAX_COOLDOWN_MS) : Date.now() + DEFAULT_COOLDOWN_MS;
    limited.set(provider, { until, message });
    save();
  },

  clear(provider: ProviderId): void {
    if (limited.delete(provider)) save();
  },

  /** The provider's last limit message while its cooldown is running. */
  message(provider: ProviderId): string | undefined {
    const entry = limited.get(provider);
    if (!entry) return undefined;
    if (Date.now() > entry.until) {
      limited.delete(provider);
      return undefined;
    }
    return entry.message;
  },

  /** When the provider's cooldown ends; undefined when it isn't limited. */
  until(provider: ProviderId): number | undefined {
    return limits.message(provider) === undefined ? undefined : limited.get(provider)?.until;
  },

  active(): Set<ProviderId> {
    return new Set([...limited.keys()].filter((provider) => limits.message(provider) !== undefined));
  },
};
