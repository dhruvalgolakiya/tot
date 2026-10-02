import type { RoutineSchedule } from "@shared/types";

const DAY_ABBREVIATIONS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * "Every weekday at 09:00" / "Every 2 hours". Mirrors the wording of the
 * server's describeSchedule() (server/data/routines.ts) so the phrasing the
 * agent might use in chat matches what the UI shows.
 */
export function formatSchedule(schedule: RoutineSchedule): string {
  if (schedule.kind === "interval") {
    const every = schedule.everyMinutes;
    if (every % 60 === 0) {
      const hours = every / 60;
      return `Every ${hours === 1 ? "hour" : `${hours} hours`}`;
    }
    return `Every ${every} minutes`;
  }
  const days = schedule.days?.length ? [...schedule.days].sort((a, b) => a - b) : null;
  const when =
    !days || days.length === 7
      ? "day"
      : days.join(",") === "1,2,3,4,5"
        ? "weekday"
        : days.map((day) => DAY_ABBREVIATIONS[day]).join(", ");
  return `Every ${when} at ${schedule.time}`;
}

/** Timestamps are epoch milliseconds; tolerate epoch seconds too. */
function toMs(timestamp: number): number {
  return timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

/**
 * Relative time that reads naturally for both the past ("2h ago", a last
 * run) and the future ("in 2h", a next run). Falls back to a short date
 * beyond a week either way.
 */
export function formatRelative(time: number, now: number = Date.now()): string {
  const ms = toMs(time);
  const diff = ms - now;
  const abs = Math.abs(diff);
  const future = diff >= 0;

  if (abs < 45_000) return future ? "in a moment" : "just now";

  const days = Math.round(abs / 86_400_000);
  if (days >= 7) {
    const date = new Date(ms);
    const label = date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: date.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
    });
    return future ? `on ${label}` : label;
  }

  const seconds = Math.round(abs / 1000);
  const minutes = Math.round(seconds / 60);
  const hours = Math.round(minutes / 60);

  let value: string;
  if (minutes < 1) value = `${seconds}s`;
  else if (minutes < 60) value = `${minutes}m`;
  else if (hours < 24) value = `${hours}h`;
  else value = `${days}d`;

  return future ? `in ${value}` : `${value} ago`;
}
