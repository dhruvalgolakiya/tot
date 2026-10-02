import type { Settings } from "@shared/types";
import { TASK_LIMITS, isValidTaskLimit, type SettingsSectionProps } from "../../lib/settings";
import { useStore } from "../../store";
import { SettingRow } from "../settings/SettingRow";
import { Card } from "../ui/Card";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";

type TasksDraft = Settings["tasks"];

/** A small number field for a limit, with its validity. */
function LimitInput({ id, value, max, onChange }: { id: string; value: number; max: number; onChange: (value: number) => void }) {
  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      min={1}
      max={max}
      value={Number.isNaN(value) ? "" : value}
      onChange={(event) => onChange(event.target.valueAsNumber)}
      aria-invalid={!isValidTaskLimit(value, max)}
      className="input input-sm w-20 text-right tabular-nums"
    />
  );
}

/** Settings → Tasks: how many run at once, what happens after a restart, and who hears when they finish. */
export function TasksSettings({ draft, onChange }: SettingsSectionProps) {
  const tasks = draft.tasks;
  const slack = useStore((s) => s.slack);
  const update = (patch: Partial<TasksDraft>) => onChange({ ...draft, tasks: { ...tasks, ...patch } });
  const people = slack?.state === "connected" ? slack.allowedUsers : [];

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-fg">Running at once</h2>
        <Card padding="none" className="divide-y divide-hairline">
          <SettingRow
            className="px-4"
            htmlFor="tasks-per-agent"
            title="Tasks per agent"
            description="Each agent has one computer, so it works on a few tasks at a time. The rest wait in its queue."
            control={<LimitInput id="tasks-per-agent" value={tasks.perAgentLimit} max={TASK_LIMITS.perAgent} onChange={(perAgentLimit) => update({ perAgentLimit })} />}
          />
          <SettingRow
            className="px-4"
            htmlFor="tasks-global"
            title="Tasks across all agents"
            description="A cap for everything running at once, so your model plans aren't stretched too thin."
            control={<LimitInput id="tasks-global" value={tasks.globalLimit} max={TASK_LIMITS.global} onChange={(globalLimit) => update({ globalLimit })} />}
          />
        </Card>
        {(!isValidTaskLimit(tasks.perAgentLimit, TASK_LIMITS.perAgent) || !isValidTaskLimit(tasks.globalLimit, TASK_LIMITS.global)) && (
          <p className="text-xs text-danger">
            Use whole numbers: 1–{TASK_LIMITS.perAgent} per agent, 1–{TASK_LIMITS.global} in total.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-fg">Restarts and notifications</h2>
        <Card padding="none" className="divide-y divide-hairline">
          <SettingRow
            className="px-4"
            htmlFor="tasks-resume"
            title="Resume interrupted tasks"
            description="When TOT restarts in the middle of a task, pick it back up by itself."
            control={<Switch id="tasks-resume" checked={tasks.resumeInterrupted} onCheckedChange={(resumeInterrupted) => update({ resumeInterrupted })} />}
          />
          <SettingRow
            className="px-4"
            title="Also tell me on Slack"
            description={
              people.length
                ? "A direct message from TOT's Slack bot when a task finishes or needs you. Tasks started from Slack or email always answer there."
                : "Connect TOT's Slack bot (Settings → Slack) to get a direct message when a task finishes or needs you."
            }
            control={
              <Select
                size="sm"
                className="w-40"
                aria-label="Slack person to notify"
                value={tasks.notifySlackUserId ?? ""}
                onValueChange={(value) => update({ notifySlackUserId: value || null })}
                disabled={!people.length}
                options={[{ value: "", label: "Off" }, ...people.map((person) => ({ value: person.id, label: person.name }))]}
              />
            }
          />
        </Card>
      </section>
    </div>
  );
}
