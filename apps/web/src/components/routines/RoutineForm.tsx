import { useState, type FormEvent } from "react";
import clsx from "clsx";
import type { Routine, RoutineInput } from "@tot/shared/types";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { cardClass } from "../ui/Card";
import { Field } from "../ui/Field";
import { Select } from "../ui/Select";
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
  /** Whose routine a new one is (not needed with `onSubmit`). */
  agentId?: string;
  /** Editing an existing routine PATCHes it; omit to create a new one. */
  routine?: Routine;
  /** Saves it somewhere else than the agent's routines, e.g. a project's schedules (module 12). */
  onSubmit?: (input: RoutineInput) => Promise<Routine>;
  /** What it's called on the create button ("routine" by default). */
  noun?: string;
  /** The hint under the prompt, and the fields' placeholders. */
  promptHint?: string;
  placeholders?: { name: string; prompt: string };
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
export function RoutineForm({ agentId, routine, onSubmit, noun = "routine", promptHint, placeholders, initialValues, onSaved, onCancel }: RoutineFormProps) {
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
      const saved = onSubmit ? await onSubmit(input) : routine ? await routinesApi.update(routine.id, input) : await routinesApi.create(agentId ?? "", input);
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
          placeholder={placeholders?.name ?? "Morning AI news"}
          className="input h-10 rounded-xl"
        />
      </Field>

      <Field label="Prompt" htmlFor="routine-prompt" hint={promptHint ?? "What should the agent do each time this runs?"}>
        <textarea
          id="routine-prompt"
          rows={3}
          value={values.prompt}
          onChange={(event) => set({ prompt: event.target.value })}
          placeholder={placeholders?.prompt ?? "Brief me on today's top AI news."}
          className="input resize-y rounded-xl leading-relaxed"
        />
      </Field>

      <div className="space-y-3">
        <div
          role="radiogroup"
          aria-label="Schedule type"
          className="inline-flex rounded-lg border border-edge bg-fill-subtle p-0.5"
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
                values.scheduleKind === option.value ? "bg-canvas text-fg shadow-sm" : "text-fg-muted hover:text-fg",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        {values.scheduleKind === "daily" ? (
          <div className={cardClass({ padding: "sm", className: "space-y-3" })}>
            <Field label="Time" htmlFor="routine-time">
              <input
                id="routine-time"
                type="time"
                value={values.time}
                onChange={(event) => set({ time: event.target.value })}
                className="input h-10 w-36 rounded-xl"
              />
            </Field>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-fg">Days</span>
                <div className="flex gap-3 text-xs">
                  <button
                    type="button"
                    onClick={() => set({ days: [] })}
                    className={clsx("font-medium hover:underline", isEveryDay ? "text-fg" : "text-fg-muted")}
                  >
                    Every day
                  </button>
                  <button
                    type="button"
                    onClick={() => set({ days: WEEKDAYS })}
                    className={clsx("font-medium hover:underline", isWeekdays ? "text-fg" : "text-fg-muted")}
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
                        active ? "bg-fg text-canvas" : "bg-fill text-fg-subtle hover:bg-fill-strong hover:text-fg-muted",
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
          <div className={cardClass({ padding: "sm" })}>
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
                  className="input h-10 w-24 rounded-xl"
                />
                <Select
                  aria-label="Interval unit"
                  value={values.intervalUnit}
                  onValueChange={(intervalUnit) => set({ intervalUnit: intervalUnit as "minutes" | "hours" })}
                  className="h-10 w-32 rounded-xl"
                  options={[
                    { value: "minutes", label: "minutes" },
                    { value: "hours", label: "hours" },
                  ]}
                />
              </div>
            </Field>
          </div>
        )}

        <p className="text-xs text-fg-subtle">
          {schedule ? (
            <>
              Preview: <span className="text-fg">{formatSchedule(schedule)}</span>
            </>
          ) : (
            "Set a valid schedule above."
          )}
        </p>
      </div>

      {error && <Callout tone="danger">{error}</Callout>}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? "Saving…" : routine ? "Save changes" : `Create ${noun}`}
        </Button>
      </div>
    </form>
  );
}
