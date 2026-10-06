import { conversations } from "../data/conversations.ts";
import { FINISHED, isTask, taskStore, type TaskRecord } from "../tasks/store.ts";
import { chatWakes } from "../tasks/wake.ts";

/**
 * A project's Lead hears about every task in its project (roadmap module 11, lane D), not only those it
 * started: when one finishes or needs input, it's added to the Lead's unread results and the Lead is woken
 * (module 05's wakes: batched, steered into a running turn when it can be, else one auto turn). Its own
 * tasks' endings already reach it as their parent chat (tasks.ts reportToParent), so only their questions
 * come through here. Left out: a task's own sub-tasks finishing (their parent task takes those), and runs
 * that report as a group (best-of, then: "synthesize"), which tell their own chat once.
 */

/** Whether this change of status is news for the project's Lead. */
function news(task: TaskRecord, leadId: string, from: string): boolean {
  if (task.id === leadId) return false;
  if (task.task.status === "needs-input") return from !== "needs-input";
  if (!FINISHED.has(task.task.status) || task.parentId === leadId) return false;
  if (task.task.groupKind === "best-of" || task.task.then === "synthesize") return false;
  const parent = task.parentId ? conversations.get(task.parentId) : null;
  return !isTask(parent);
}

let unsubscribe: (() => void) | null = null;

export const leadWakes = {
  start(): void {
    unsubscribe ??= taskStore.onChange((task, from) => {
      if (!task.projectId) return;
      const leadId = conversations.leadOf(task.projectId);
      if (!leadId || !news(task, leadId, from)) return;
      const lead = conversations.get(leadId);
      if (!lead) return;
      conversations.update(leadId, { childResults: [...new Set([...lead.childResults, task.id])] });
      chatWakes.flagChat(leadId);
    });
  },

  stop(): void {
    unsubscribe?.();
    unsubscribe = null;
  },
};
