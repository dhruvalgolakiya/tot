import { conversations } from "../data/conversations.ts";
import { queueHolds } from "../data/queue-holds.ts";
import { settings } from "../data/settings.ts";
import { runLoop } from "./run-loop.ts";
import { taskStore, type TaskRecord } from "./store.ts";

/**
 * The task queue. An agent has one computer, so it runs at most a few tasks at once
 * (Settings → Tasks, default 2), and there's an app-wide cap too (default 4). Queued tasks
 * wait their turn, first in first out, unless the user reorders them or says "Run now". A paused
 * queue (a provider kept failing; data/queue-holds.ts) starts nothing until the user resumes it.
 */

const byPosition = (a: TaskRecord, b: TaskRecord) =>
  (a.task.queuePosition ?? Number.MAX_SAFE_INTEGER) - (b.task.queuePosition ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt;

/** Numbers an agent's queued tasks 1, 2, 3… in their current order. */
function renumber(agentId: string, order?: TaskRecord[]): void {
  const queued = order ?? taskQueue.of(agentId);
  queued.forEach((task, index) => {
    if (task.task.queuePosition !== index + 1) taskStore.patch(task.id, { queuePosition: index + 1 });
  });
}

let unsubscribe: (() => void) | null = null;

export const taskQueue = {
  /** An agent's queued tasks, next first. */
  of(agentId: string): TaskRecord[] {
    return conversations
      .tasks({ agentId })
      .filter((task): task is TaskRecord => task.task?.status === "queued")
      .sort(byPosition);
  },

  /** Puts a task in its agent's queue (at the back, or the front), then starts what can start. */
  enqueue(taskId: string, { front = false } = {}): boolean {
    const task = taskStore.get(taskId);
    if (!task) return false;
    const others = taskQueue.of(task.agentId).filter((other) => other.id !== taskId);
    if (task.task.status !== "queued" && !taskStore.transition(taskId, "queued")) return false;
    const self = taskStore.get(taskId)!;
    renumber(task.agentId, front ? [self, ...others] : [...others, self]);
    taskQueue.pump();
    return true;
  },

  /** Moves a queued task to `position` (1 = next) in its agent's queue. */
  move(taskId: string, position: number): void {
    const task = taskStore.get(taskId);
    if (!task || task.task.status !== "queued") return;
    const others = taskQueue.of(task.agentId).filter((other) => other.id !== taskId);
    const index = Math.max(0, Math.min(others.length, Math.round(position) - 1));
    renumber(task.agentId, [...others.slice(0, index), task, ...others.slice(index)]);
  },

  /** Starts queued tasks while their agents (and the app) have free slots: oldest place in line first. Paused queues wait. */
  pump(): void {
    const { perAgentLimit, globalLimit } = settings.get().tasks;
    const queued = conversations
      .tasks()
      .filter((task): task is TaskRecord => task.task?.status === "queued")
      .sort(byPosition);
    const started = new Set<string>();
    const held = new Map<string, boolean>();
    const isHeld = (agentId: string) => held.get(agentId) ?? held.set(agentId, queueHolds.get(agentId) !== null).get(agentId)!;
    for (const task of queued) {
      if (runLoop.count() >= globalLimit) break;
      if (runLoop.count(task.agentId) >= perAgentLimit || isHeld(task.agentId)) continue;
      if (runLoop.start(task.id)) started.add(task.agentId);
    }
    for (const agentId of started) renumber(agentId);
  },

  /** Whether a task would start right away if queued now. */
  hasSlot(agentId: string): boolean {
    const { perAgentLimit, globalLimit } = settings.get().tasks;
    return runLoop.count() < globalLimit && runLoop.count(agentId) < perAgentLimit && !queueHolds.get(agentId);
  },

  /** Keeps the queue moving: renumbers when a task leaves it, and starts the next when a loop ends. */
  start(): void {
    if (unsubscribe) return;
    const offChange = taskStore.onChange((task, from) => {
      if (from === "queued" && task.task.status !== "queued") renumber(task.agentId);
    });
    const offIdle = runLoop.onIdle(() => taskQueue.pump());
    unsubscribe = () => {
      offChange();
      offIdle();
    };
  },

  stop(): void {
    unsubscribe?.();
    unsubscribe = null;
  },
};
