import type { Routine, RoutineInput, RoutineSchedule } from "@tot/shared/types";

const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

export type ScheduleKind = "daily" | "interval";
export type IntervalUnit = "minutes" | "hours";

/** Editable state for RoutineForm; converted to a RoutineSchedule on submit. */
export interface RoutineFormValues {
  name: string;
  prompt: string;
  scheduleKind: ScheduleKind;
  /** "HH:MM", used when scheduleKind is "daily". */
  time: string;
  /** 0 (Sunday) .. 6 (Saturday); empty means every day. */
  days: number[];
  /** Raw text so the field can be edited freely; parsed on submit/preview. */
  intervalValue: string;
  intervalUnit: IntervalUnit;
}

export const WEEKDAYS = [1, 2, 3, 4, 5];

export const EMPTY_ROUTINE_FORM: RoutineFormValues = {
  name: "",
  prompt: "",
  scheduleKind: "daily",
  time: "09:00",
  days: [],
  intervalValue: "1",
  intervalUnit: "hours",
};

export function routineToFormValues(routine: Routine): RoutineFormValues {
  if (routine.schedule.kind === "interval") {
    const minutes = routine.schedule.everyMinutes;
    const useHours = minutes >= 60 && minutes % 60 === 0;
    return {
      ...EMPTY_ROUTINE_FORM,
      name: routine.name,
      prompt: routine.prompt,
      scheduleKind: "interval",
      intervalValue: String(useHours ? minutes / 60 : minutes),
      intervalUnit: useHours ? "hours" : "minutes",
    };
  }
  return {
    ...EMPTY_ROUTINE_FORM,
    name: routine.name,
    prompt: routine.prompt,
    scheduleKind: "daily",
    time: routine.schedule.time,
    days: routine.schedule.days ? [...routine.schedule.days] : [],
  };
}

/** Toggle one day, treating "every day" (empty array) as all seven being on. Never returns an empty set. */
export function toggleDay(current: number[], day: number): number[] {
  const active = current.length ? current : [0, 1, 2, 3, 4, 5, 6];
  const next = active.includes(day) ? active.filter((d) => d !== day) : [...active, day];
  if (next.length === 0) return current;
  next.sort((a, b) => a - b);
  return next.length === 7 ? [] : next;
}

/** Builds a schedule from the current form values, or null while the fields don't yet form a valid one. */
export function buildSchedule(values: RoutineFormValues): RoutineSchedule | null {
  if (values.scheduleKind === "interval") {
    const raw = Number(values.intervalValue);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const everyMinutes = Math.round(values.intervalUnit === "hours" ? raw * 60 : raw);
    return { kind: "interval", everyMinutes };
  }
  if (!/^\d{2}:\d{2}$/.test(values.time)) return null;
  return { kind: "daily", time: values.time, ...(values.days.length ? { days: values.days } : {}) };
}

/** Validate the routine form. Returns the request body, or a human error message (matches the server's wording). */
export function toRoutineInput(values: RoutineFormValues): RoutineInput | string {
  const name = values.name.trim();
  if (!name || name.length > 80) return "Routine names need 1–80 characters.";
  const prompt = values.prompt.trim();
  if (!prompt || prompt.length > 4000) return "Tell the agent what to do (up to 4000 characters).";

  const schedule = buildSchedule(values);
  if (!schedule) {
    return values.scheduleKind === "daily"
      ? 'Daily routines need a time like "08:30".'
      : `Intervals must be whole minutes between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}.`;
  }
  if (schedule.kind === "interval" && (schedule.everyMinutes < MIN_INTERVAL_MINUTES || schedule.everyMinutes > MAX_INTERVAL_MINUTES)) {
    return `Intervals must be whole minutes between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}.`;
  }

  return { name, prompt, schedule };
}
