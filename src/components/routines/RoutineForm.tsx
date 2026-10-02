import { useState, type FormEvent } from "react";
import clsx from "clsx";
import type { Routine } from "@shared/types";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { formatSchedule } from "./format";
import {
  buildSchedule,
  EMPTY_ROUTINE_FORM,
  routineToFormValues,
  toggleDay,
  toRoutineInput,
  WEEKDAYS,
  type RoutineFormValues,
  type ScheduleKind,
} from "./formValues";
import { errorMessage, routinesApi } from "./routinesApi";

export interface RoutineFormProps {
  agentId: string;
  /** Editing an existing routine PATCHes it; omit to create a new one. */
  routine?: Routine;
  /** Prefills fields for a new routine, e.g. from an example chip. Ignored when `routine` is set. */
  initialValues?: Partial<RoutineFormValues>;
  onSaved: (routine: Routine) => void;
  onCancel: () => void;
}

const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const SCHEDULE_KINDS: { value: ScheduleKind; label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "interval", label: "Interval" },
];

/** Create/edit form for a routine: name, prompt, and a schedule builder with a live preview. */
export function RoutineForm({ agentId, routine, initialValues, onSaved, onCancel }: RoutineFormProps) {
  const [values, setValues] = useState<RoutineFormValues>(() =>
    routine ? routineToFormValues(routine) : { ...EMPTY_ROUTINE_FORM, ...initialValues },
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (patch: Partial<RoutineFormValues>) => {
    setValues((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const schedule = buildSchedule(values);
  const daysOn = values.days.length ? values.days : [0, 1, 2, 3, 4, 5, 6];
  const isWeekdays = values.days.join(",") === WEEKDAYS.join(",");
  const isEveryDay = values.days.length === 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const input = toRoutineInput(values);
    if (typeof input === "string") {
      setError(input);
      return;
    }
    setSaving(true);
    try {
      const saved = routine ? await routinesApi.update(routine.id, input) : await routinesApi.create(agentId, input);
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <Field label="Name" htmlFor="routine-name">
        <input
          id="routine-name"
          autoFocus
          value={values.name}
          onChange={(event) => set({ name: event.target.value })}
          placeholder="Morning AI news"
          className="input"
        />
      </Field>

      <Field label="Prompt" htmlFor="routine-prompt" hint="What should the agent do each time this runs?">
        <textarea
          id="routine-prompt"
          rows={3}
          value={values.prompt}
          onChange={(event) => set({ prompt: event.target.value })}
          placeholder="Brief me on today's top AI news."
          className="input resize-y leading-relaxed"
        />
      </Field>

      <div className="space-y-3">
        <div
          role="radiogroup"
          aria-label="Schedule type"
          className="inline-flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5"
        >
          {SCHEDULE_KINDS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={values.scheduleKind === option.value}
              onClick={() => set({ scheduleKind: option.value })}
              className={clsx(
                "rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors",
                values.scheduleKind === option.value
                  ? "bg-white/[0.1] text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        {values.scheduleKind === "daily" ? (
          <div className="space-y-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3.5">
            <Field label="Time" htmlFor="routine-time">
              <input
                id="routine-time"
                type="time"
                value={values.time}
                onChange={(event) => set({ time: event.target.value })}
                className="input w-36"
              />
            </Field>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-zinc-200">Days</span>
                <div className="flex gap-3 text-xs">
                  <button
                    type="button"
                    onClick={() => set({ days: [] })}
                    className={clsx("font-medium hover:underline", isEveryDay ? "text-violet-300" : "text-zinc-400")}
                  >
                    Every day
                  </button>
                  <button
                    type="button"
                    onClick={() => set({ days: WEEKDAYS })}
                    className={clsx("font-medium hover:underline", isWeekdays ? "text-violet-300" : "text-zinc-400")}
                  >
                    Weekdays
                  </button>
                </div>
              </div>
              <div className="flex gap-1.5">
                {DAY_LETTERS.map((letter, index) => {
                  const active = daysOn.includes(index);
                  return (
                    <button
                      key={index}
                      type="button"
                      aria-pressed={active}
                      aria-label={
                        ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][index]
                      }
                      onClick={() => set({ days: toggleDay(values.days, index) })}
                      className={clsx(
                        "flex size-8 items-center justify-center rounded-full text-xs font-semibold transition-colors",
                        active
                          ? "bg-violet-500 text-white"
                          : "bg-white/[0.04] text-zinc-500 hover:bg-white/[0.08] hover:text-zinc-300",
                      )}
                    >
                      {letter}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3.5">
            <Field label="Every" htmlFor="routine-interval-value" hint="Minimum 15 minutes.">
              <div className="flex gap-2">
                <input
                  id="routine-interval-value"
                  type="number"
                  min={values.intervalUnit === "hours" ? 1 : 15}
                  max={values.intervalUnit === "hours" ? 168 : 10080}
                  step={1}
                  value={values.intervalValue}
                  onChange={(event) => set({ intervalValue: event.target.value })}
                  className="input w-24"
                />
                <select
                  aria-label="Interval unit"
                  value={values.intervalUnit}
                  onChange={(event) => set({ intervalUnit: event.target.value as "minutes" | "hours" })}
                  className="input w-32"
                >
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                </select>
              </div>
            </Field>
          </div>
        )}

        <p className="text-xs text-zinc-500">
          {schedule ? (
            <>
              Preview: <span className="text-zinc-300">{formatSchedule(schedule)}</span>
            </>
          ) : (
            "Set a valid schedule above."
          )}
        </p>
      </div>

      {error && <p className="rounded-lg bg-red-500/[0.08] px-3 py-2 text-sm text-red-300">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? "Saving…" : routine ? "Save changes" : "Create routine"}
        </Button>
      </div>
    </form>
  );
}
