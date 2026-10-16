import type { Routine } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { runRegistry } from "../agent/runs.ts";
import { messages } from "../data/messages.ts";
import { describeSchedule, routines } from "../data/routines.ts";
import { leadInbox } from "../lead/inbox.ts";
import { leads } from "../lead/lead.ts";
import { projects } from "./projects.ts";

/**
 * A project's schedules (roadmap module 12, lane B): routines with a project. One doesn't start a new chat when
 * it's due: it posts a "schedule" signal (its name and prompt) to the project's Lead (lead/inbox.ts), which the
 * Lead hears about and acts on; it runs with the Lead's agent, opening the Lead first if the project has none
 * yet. A schedule doesn't run again while the wake from its last run is still going: while the Lead is in a turn
 * that started after that run, the slot is skipped (as a routine's is while its last chat still replies).
 */

/** "Scheduled “Standup” (every weekday at 09:00)". */
export function scheduleTitle(routine: Pick<Routine, "name" | "schedule">): string {
  return `Scheduled “${routine.name}” (${describeSchedule(routine.schedule)})`;
}

/** Whether the Lead is still in a turn begun since the schedule last ran: its wake, most likely, still going. */
function lastWakeRunning(routine: Routine): boolean {
  if (!routine.lastConversationId || routine.lastRunAt === null) return false;
  const run = runRegistry.activeFor(routine.lastConversationId);
  if (!run) return false;
  const started = messages.get(run.messageId)?.createdAt ?? 0;
  return started >= routine.lastRunAt;
}

export const projectSchedules = {
  /**
   * Runs it now: the Lead (opened with the schedule's agent when the project has none yet) gets a "schedule"
   * signal. Throws when the project is gone or archived; either way the schedule moves to its next time.
   */
  run(routine: Routine): { conversationId: string; runId: string } {
    const project = projects.get(routine.projectId);
    if (!project || project.archived) {
      routines.markRun(routine.id, null);
      throw new HttpError(409, "This schedule's project is archived.");
    }
    let leadId: string;
    try {
      leadId = leads.open(project.id, routine.agentId).lead.id;
    } catch (err) {
      // Advance even when the Lead couldn't be opened, so a broken schedule can't spin.
      routines.markRun(routine.id, null);
      throw err;
    }
    // Before the signal: its wake starts after this, so lastWakeRunning can tell it from turns begun earlier.
    routines.markRun(routine.id, leadId);
    // Null when it's a duplicate (or nobody listens yet): the Lead heard about it already.
    leadInbox.post(project.id, { kind: "schedule", title: scheduleTitle(routine), detail: routine.prompt, url: null, repoName: null, taskId: null, prNumber: null });
    return { conversationId: leadId, runId: runRegistry.activeFor(leadId)?.id ?? "" };
  },

  /** A due slot (the scheduler's tick): skipped while its last wake still runs, and quietly for an archived project. */
  due(routine: Routine): void {
    const project = projects.get(routine.projectId);
    if (!project || project.archived || lastWakeRunning(routine)) {
      // Not a run: its last run's time stays, which is what tells its wake from later turns.
      routines.skip(routine.id);
      return;
    }
    try {
      projectSchedules.run(routine);
    } catch (err) {
      console.warn(`[tot] schedule "${routine.name}" couldn't run:`, err instanceof Error ? err.message : err);
    }
  },

  /** A new schedule for the project: it runs with its Lead's agent (the Lead is opened now when it has none). */
  create(projectId: string, input: Parameters<typeof routines.create>[1]): Routine {
    const project = projects.get(projectId);
    if (!project) throw new HttpError(404, "Project not found.");
    if (project.archived) throw new HttpError(400, "This project is archived.");
    const { lead } = leads.open(project.id);
    return routines.create(lead.agentId, { ...input, projectId: project.id });
  },
};
