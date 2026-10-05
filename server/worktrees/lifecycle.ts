import { appEvents } from "../app-events.ts";
import { conversations } from "../data/conversations.ts";
import { taskStore } from "../tasks/store.ts";
import { worktreeCleanup } from "./cleanup.ts";
import { taskPorts } from "./ports.ts";
import { previews } from "./preview.ts";

/**
 * Module 09's worktree lifecycle, wired into the rest of TOT at startup: a task's preview stops when the
 * task is stopped or deleted; when it lands (merged, draft PR, discarded: TaskInfo.landing, lane A) its
 * preview stops and its ports go back; old worktrees are swept daily; previews from before a restart
 * are forgotten, and running ones end when TOT does.
 */

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A landed task gives back what it held. */
async function landed(taskId: string): Promise<void> {
  const task = taskStore.get(taskId);
  if (!task?.task.landing) return;
  if (previews.isRunning(taskId) || task.task.preview) await previews.stop(taskId);
  taskPorts.release(taskId);
}

let unsubscribe: (() => void) | null = null;
/** Task id → the landing already handled (its `at`): a draft PR's task may keep working, and keeps what it gets after. */
const handled = new Map<string, number>();

export const worktreeLifecycle = {
  start(): void {
    if (unsubscribe) return;
    previews.forgetStale();
    for (const task of conversations.tasks()) if (task.task?.landing) handled.set(task.id, task.task.landing.at);
    const offChange = taskStore.onChange((task) => {
      if (task.task.status === "stopped") void previews.stop(task.id);
    });
    const offEvents = appEvents.subscribe((event) => {
      const landing = event.type === "task" ? event.conversation.task?.landing : null;
      if (event.type === "task" && landing && handled.get(event.conversation.id) !== landing.at) {
        const id = event.conversation.id;
        handled.set(id, landing.at);
        // After the change that published this event is done (releasing publishes again).
        queueMicrotask(() => void landed(id).catch((err) => console.warn(`[tot] releasing task ${id}'s ports failed:`, errorText(err))));
      }
      if (event.type === "conversation-deleted") {
        handled.delete(event.conversationId);
        void previews.stop(event.conversationId);
      }
    });
    worktreeCleanup.start();
    unsubscribe = () => {
      offChange();
      offEvents();
      worktreeCleanup.stop();
    };
  },

  /** TOT is stopping: previews end with it. */
  async shutdown(): Promise<void> {
    unsubscribe?.();
    unsubscribe = null;
    await previews.stopAll();
  },
};
