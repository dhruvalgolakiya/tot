import { chatWakes } from "./wake.ts";
import { FINISHED, taskStore, type TaskRecord } from "./store.ts";

/**
 * Waiting for a task (module 05): task_start / task_spawn_many with `wait` hold the tool call until
 * the tasks are through, so an agent can use a quick task's result in the same turn instead of
 * ending it. The wait is capped under the providers' tool-call timeouts (11 minutes on Claude, 620 s
 * on ChatGPT); a wait that runs out leaves the rest to a wake-up, and stopping the turn ends it.
 */

/** Longest wait, in minutes. */
export const MAX_WAIT_MINUTES = 10;
export const DEFAULT_WAIT_MINUTES = 5;

let minuteMs = 60_000;

/** A task is through waiting for: it ended, or it needs the user (a question, a pause, a restart). */
export function settled(task: TaskRecord): boolean {
  const { status, question } = task.task;
  return FINISHED.has(status) || status === "paused" || status === "interrupted" || (status === "needs-input" && Boolean(question));
}

/** Waits until every task is settled, `minutes` run out, or `signal` aborts (the turn was stopped). */
export function waitForTasks(ids: string[], minutes: number, signal?: AbortSignal): Promise<"settled" | "timeout" | "stopped"> {
  // While waited on, their results come back here, not in a wake-up.
  chatWakes.holdBack(ids);
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let off = () => {};
    let ended = false;
    const end = (how: "settled" | "timeout" | "stopped") => {
      if (ended) return;
      ended = true;
      off();
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      chatWakes.release(ids);
      resolve(how);
    };
    const stop = () => end("stopped");
    const check = () => {
      if (ids.every((id) => {
        const task = taskStore.get(id);
        return !task || settled(task);
      })) end("settled");
    };
    if (signal?.aborted) return end("stopped");
    off = taskStore.onChange(check);
    timer = setTimeout(() => end("timeout"), minutes * minuteMs);
    signal?.addEventListener("abort", stop, { once: true });
    check();
  });
}

export const taskWaits = {
  /** Tests: a shorter minute. */
  useMinute(ms: number): void {
    minuteMs = ms;
  },
};
