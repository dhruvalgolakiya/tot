import { setTimeout as sleep } from "node:timers/promises";
import type { RunEvent } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { runRegistry } from "../agent/runs.ts";
import { conversations } from "../data/conversations.ts";
import { messageText } from "../data/messages.ts";
import { taskNotifications } from "../tasks/notify.ts";
import { resultBlock } from "../tasks/prompt.ts";
import { runLoop } from "../tasks/run-loop.ts";
import { FINISHED, taskStore, type TaskRecord } from "../tasks/store.ts";
import { roleTier } from "./tiers.ts";

/**
 * Fan-in: when the last task of a group spawned with then: "synthesize" finishes, the chat that
 * started them gets one writer turn with all their results as structured data (not their
 * transcripts), and its answer goes back to Slack or email when the chat came from there. A
 * task that spawned a group needs nothing extra: its loop waits for them, and its next turn
 * starts with their results.
 */

const BUSY_RETRIES = 90;

function runEnd(runId: string): Promise<Extract<RunEvent, { type: "run-end" }> | null> {
  const run = runRegistry.get(runId);
  if (!run) return Promise.resolve(null);
  return new Promise((resolve) => run.subscribe((_seq, event) => event.type === "run-end" && resolve(event)));
}

export function writerPreamble(children: TaskRecord[]): string {
  return `[You're the writer now: the ${children.length} tasks you started have all finished. Combine their results into one answer for the user — complete and well organized, keeping every source as a link, saying where they disagree and what's still unknown. Don't just list the tasks; answer the question they were working on.
<task_results>
${children.map((child) => resultBlock(child)).join("\n")}
</task_results>]`;
}

async function synthesize(parentId: string, children: TaskRecord[]): Promise<void> {
  const parent = conversations.get(parentId);
  if (!parent || parent.kind === "task") return;
  // These results go to the writer turn; the chat's next turn shouldn't hear them again.
  conversations.update(parentId, { childResults: parent.childResults.filter((id) => !children.some((child) => child.id === id)) });
  let runId: string | null = null;
  for (let attempt = 0; attempt < BUSY_RETRIES && !runId; attempt++) {
    try {
      ({ runId } = await runLoop.send(
        parentId,
        { text: `Combine the results of the ${children.length} tasks.` },
        { auto: true, keepTitle: true, preamble: writerPreamble(children), tier: roleTier("writer"), heavy: "writer" },
      ));
    } catch (err) {
      // Someone is chatting there right now: wait for their turn to end.
      if (!(err instanceof HttpError && err.status === 409)) throw err;
      await sleep(2000);
    }
  }
  if (!runId) return;
  const end = await runEnd(runId);
  const answer = end && end.status === "complete" ? messageText(end.message) : "";
  if (answer) await taskNotifications.deliver(parentId, answer);
}

let unsubscribe: (() => void) | null = null;

export const fanIn = {
  start(): void {
    unsubscribe ??= taskStore.onChange((task) => {
      if (!FINISHED.has(task.task.status) || !task.parentId || !task.task.group || task.task.then !== "synthesize") return;
      const group = conversations.tasks({ parentId: task.parentId }).filter((c): c is TaskRecord => c.task?.group === task.task.group);
      if (!group.every((member) => FINISHED.has(member.task.status))) return;
      // Once per group.
      for (const member of group) taskStore.patch(member.id, { then: null });
      void synthesize(task.parentId, group).catch((err) => console.warn("[tot] combining task results failed:", err instanceof Error ? err.message : err));
    });
  },

  stop(): void {
    unsubscribe?.();
    unsubscribe = null;
  },
};
