import type { ProviderId } from "../../shared/types.ts";
import { limits } from "../agent/limits.ts";
import { conversations } from "../data/conversations.ts";
import { settings } from "../data/settings.ts";
import { runLoop } from "../tasks/run-loop.ts";
import { isTask, taskStore } from "../tasks/store.ts";
import { tasks } from "../tasks/tasks.ts";
import { switchProvider } from "./handoff.ts";
import { otherProvider } from "./roles.ts";
import { statuses } from "./statuses.ts";
import { tierModel } from "./tiers.ts";

/**
 * Usage limits mid-task. Between turns, TOT Auto already avoids a provider in its cooldown
 * (agent/limits.ts). A running task that hits the limit mid-turn writes a handoff and carries
 * on with the other provider — when Settings → Tasks allows it and the other one is signed in
 * and not limited too. Otherwise it pauses ("Claude limit until 7:30 AM") and resumes by
 * itself when the cooldown ends, including after a restart.
 */

const LABELS: Record<ProviderId, string> = { claude: "Claude", chatgpt: "ChatGPT" };
/** If a limit gives no reset time, try again after this long. */
const RETRY_MS = 15 * 60_000;

const timers = new Map<string, NodeJS.Timeout>();

const clock = (time: number) => new Date(time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/** Resumes a task paused for a usage limit at `at` (now, if that's passed). */
function resumeAt(taskId: string, at: number): void {
  clearTimeout(timers.get(taskId));
  const timer = setTimeout(() => {
    timers.delete(taskId);
    const task = taskStore.get(taskId);
    if (task?.task.status !== "paused" || !task.task.resumeAt) return;
    taskStore.patch(taskId, { resumeAt: null, progress: null });
    tasks.resume(taskId, { front: true });
  }, Math.max(0, at - Date.now()));
  timer.unref();
  timers.set(taskId, timer);
}

export async function failover(taskId: string, limited: ProviderId): Promise<"switched" | "paused"> {
  const task = taskStore.require(taskId);
  const other = otherProvider(limited);
  const signedIn = await statuses.get();
  const otherUp = Boolean(tierModel(task.task.tier ?? "deep", other, signedIn)) && !limits.active().has(other);
  // A best-of run (module 09) stays on its provider: switching would spoil the comparison.
  if (settings.get().tasks.switchProviders && otherUp && task.task.groupKind !== "best-of") {
    await switchProvider(taskId, other, `${LABELS[limited]} hit its usage limit, so this continues on ${LABELS[other]}`, limited);
    return "switched";
  }
  const until = limits.until(limited) ?? Date.now() + RETRY_MS;
  taskStore.transition(taskId, "paused", { resumeAt: until, progress: `Paused: ${LABELS[limited]} is at its usage limit until ${clock(until)}. It resumes by itself.` });
  resumeAt(taskId, until);
  return "paused";
}

export const taskFailover = {
  /** Handles limits for running loops, and re-arms resumes for tasks paused before a restart. */
  start(): void {
    runLoop.onLimit(failover);
    for (const task of conversations.tasks()) {
      if (isTask(task) && task.task.status === "paused" && task.task.resumeAt) resumeAt(task.id, task.task.resumeAt);
    }
  },

  stop(): void {
    runLoop.onLimit(null);
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  },
};
