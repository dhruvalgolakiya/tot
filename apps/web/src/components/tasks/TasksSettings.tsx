import { useState } from "react";
import { toast } from "sonner";
import type { Settings } from "@shared/types";
import { api } from "../../lib/api";
import { CLEANUP_DAYS, TASK_LIMITS, isValidCleanupDays, isValidTaskLimit, type SettingsSectionProps } from "../../lib/settings";
import { notifyError, useStore } from "../../store";
import { Button } from "../ui/Button";
import { LedgerField, LedgerGroup } from "../ui/Ledger";
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

/** "Clean up now" (module 09): removes old worktrees with the days on screen, saved or not, and says how many went. */
function CleanUpNow({ days }: { days: number }) {
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const { removed } = await api.cleanUpWorktrees(days);
      toast.success(removed ? `Removed ${removed} worktree${removed === 1 ? "" : "s"}` : "Nothing to clean up");
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button size="sm" variant="secondary" disabled={busy || !isValidCleanupDays(days) || days < 1} onClick={() => void run()}>
      {busy ? "Cleaning up…" : "Clean up now"}
    </Button>
  );
}

/** Settings → Tasks: how many run at once, what happens after a restart, who hears when they finish, and old worktrees. */
export function TasksSettings({ draft, onChange }: SettingsSectionProps) {
  const tasks = draft.tasks;
  const slack = useStore((s) => s.slack);
  const update = (patch: Partial<TasksDraft>) => onChange({ ...draft, tasks: { ...tasks, ...patch } });
  const people = slack?.state === "connected" ? slack.allowedUsers : [];
  const cleanupDays = tasks.worktreeCleanupDays;

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <LedgerGroup title="Running at once">
          <LedgerField
            htmlFor="tasks-per-agent"
            title="Tasks per agent"
            description="Each agent has one computer, so it works on a few tasks at a time. The rest wait in its queue."
            control={<LimitInput id="tasks-per-agent" value={tasks.perAgentLimit} max={TASK_LIMITS.perAgent} onChange={(perAgentLimit) => update({ perAgentLimit })} />}
          />
          <LedgerField
            htmlFor="tasks-global"
            title="Tasks across all agents"
            description="A cap for everything running at once, so your model plans aren't stretched too thin."
            control={<LimitInput id="tasks-global" value={tasks.globalLimit} max={TASK_LIMITS.global} onChange={(globalLimit) => update({ globalLimit })} />}
          />
        </LedgerGroup>
        {(!isValidTaskLimit(tasks.perAgentLimit, TASK_LIMITS.perAgent) || !isValidTaskLimit(tasks.globalLimit, TASK_LIMITS.global)) && (
          <p className="px-1 text-xs text-danger">
            Use whole numbers: 1–{TASK_LIMITS.perAgent} per agent, 1–{TASK_LIMITS.global} in total.
          </p>
        )}
      </div>

      <LedgerGroup title="Splitting work">
        <LedgerField
          htmlFor="tasks-switch"
          title="Switch providers when one hits its limit"
          description="A task that runs into Claude's or ChatGPT's usage limit writes a handoff and carries on with the other. Off: it pauses until the limit resets."
          control={<Switch id="tasks-switch" checked={tasks.switchProviders} onCheckedChange={(switchProviders) => update({ switchProviders })} />}
        />
        <LedgerField
          htmlFor="tasks-children"
          title="Tasks one chat or task can start"
          description="Caps how far TOT fans out a single request."
          control={<LimitInput id="tasks-children" value={tasks.maxChildren} max={TASK_LIMITS.children} onChange={(maxChildren) => update({ maxChildren })} />}
        />
      </LedgerGroup>

      <LedgerGroup title="Restarts and notifications">
        <LedgerField
          htmlFor="tasks-resume"
          title="Resume interrupted tasks"
          description="When TOT restarts in the middle of a task, pick it back up by itself."
          control={<Switch id="tasks-resume" checked={tasks.resumeInterrupted} onCheckedChange={(resumeInterrupted) => update({ resumeInterrupted })} />}
        />
        <LedgerField
          htmlFor="tasks-wake"
          title="Tell the chat when its tasks finish"
          description="The chat picks up the results and replies by itself, instead of waiting for your next message."
          control={<Switch id="tasks-wake" checked={tasks.wakeChats} onCheckedChange={(wakeChats) => update({ wakeChats })} />}
        />
        <LedgerField
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
      </LedgerGroup>

      <div className="space-y-2">
        <LedgerGroup title="Worktrees">
          <LedgerField
            htmlFor="tasks-cleanup"
            title="Remove finished worktrees after"
            description="A task that finished but was never merged, opened as a pull request or discarded keeps its worktree this long. Its branch always stays. 0 keeps them."
            control={
              <div className="flex items-center gap-1.5">
                <input
                  id="tasks-cleanup"
                  type="number"
                  inputMode="numeric"
                  min={CLEANUP_DAYS.min}
                  max={CLEANUP_DAYS.max}
                  value={Number.isNaN(cleanupDays) ? "" : cleanupDays}
                  onChange={(event) => update({ worktreeCleanupDays: event.target.valueAsNumber })}
                  aria-invalid={!isValidCleanupDays(cleanupDays)}
                  className="input input-sm w-20 text-right tabular-nums"
                />
                <span className="text-xs text-fg-subtle">days</span>
              </div>
            }
          />
          <LedgerField
            title="Remove them now"
            description={
              isValidCleanupDays(cleanupDays) && cleanupDays >= 1
                ? `Clean up worktrees older than ${cleanupDays} day${cleanupDays === 1 ? "" : "s"} now, instead of at the daily sweep.`
                : "Cleanup is off. Set a number of days to remove old worktrees."
            }
            control={<CleanUpNow days={cleanupDays} />}
          />
        </LedgerGroup>
        {!isValidCleanupDays(cleanupDays) && (
          <p className="px-1 text-xs text-danger">
            Use a whole number of days, {CLEANUP_DAYS.min}–{CLEANUP_DAYS.max}.
          </p>
        )}
      </div>
    </div>
  );
}
