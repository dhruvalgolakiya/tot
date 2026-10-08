import type { Conversation, TaskInfo, TaskStatus } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { appEvents } from "../app-events.ts";
import { conversations, ORCHESTRATION_DEFAULTS, toPublicConversation, type ConversationRecord } from "../data/conversations.ts";

/**
 * A task's state lives in its conversation (the `task` JSON), so everything needed to carry
 * on survives a restart. Status changes go through `transition`, which refuses moves that make
 * no sense (a finished task can't be paused) and tells listeners (the queue, notifications).
 */

export type TaskRecord = ConversationRecord & { kind: "task"; task: TaskInfo };

export function isTask(conversation: ConversationRecord | null | undefined): conversation is TaskRecord {
  return conversation?.kind === "task" && conversation.task !== null;
}

/** Statuses a task can move to from each status. */
const NEXT: Record<TaskStatus, TaskStatus[]> = {
  queued: ["running", "paused", "stopped"],
  running: ["needs-input", "paused", "done", "failed", "stopped", "interrupted"],
  "needs-input": ["running", "paused", "done", "failed", "stopped", "interrupted"],
  paused: ["queued", "running", "stopped"],
  interrupted: ["queued", "running", "paused", "stopped"],
  // A reply picks a finished task up again.
  done: ["queued", "running"],
  failed: ["queued", "running"],
  stopped: ["queued", "running"],
};

/** Statuses after which a task has nothing left to do (until the user picks it up again). */
export const FINISHED: ReadonlySet<TaskStatus> = new Set(["done", "failed", "stopped"]);
/** Statuses in which a task is (or may soon be) working. */
export const ACTIVE: ReadonlySet<TaskStatus> = new Set(["queued", "running", "needs-input"]);

export function canMove(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || NEXT[from].includes(to);
}

type Listener = (task: TaskRecord, from: TaskStatus) => void;
const listeners = new Set<Listener>();

export function newTaskInfo(goal: string, repo: TaskInfo["repo"]): TaskInfo {
  return {
    goal,
    status: "queued",
    progress: null,
    plan: [],
    question: null,
    repo,
    queuePosition: null,
    startedAt: null,
    finishedAt: null,
    summary: null,
    turns: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...ORCHESTRATION_DEFAULTS,
  };
}

export const taskStore = {
  get(id: string): TaskRecord | null {
    const conversation = conversations.get(id);
    return isTask(conversation) ? conversation : null;
  },

  require(id: string): TaskRecord {
    const task = taskStore.get(id);
    if (!task) throw new HttpError(404, "Task not found.");
    return task;
  },

  /** Merges a change into the task and tells every tab. `touch` moves it up in lists. */
  patch(id: string, patch: Partial<TaskInfo>, touch = false): TaskRecord | null {
    const current = taskStore.get(id);
    if (!current) return null;
    const updated = conversations.update(id, { task: { ...current.task, ...patch } }, touch);
    if (!isTask(updated)) return null;
    taskStore.publish(updated);
    return updated;
  },

  /**
   * Moves a task to `to` (when allowed; false otherwise), stamping start and finish times and
   * leaving the queue. Listeners hear about every real change of status.
   */
  transition(id: string, to: TaskStatus, extra: Partial<TaskInfo> = {}): boolean {
    const current = taskStore.get(id);
    if (!current) return false;
    const from = current.task.status;
    if (!canMove(from, to)) return false;
    const now = Date.now();
    const next: Partial<TaskInfo> = {
      ...extra,
      status: to,
      // Picking a finished task up again starts its clock over.
      ...(to === "running" ? { startedAt: FINISHED.has(from) ? now : (current.task.startedAt ?? now), finishedAt: null } : {}),
      ...(FINISHED.has(to) ? { finishedAt: now } : {}),
      ...(to !== "queued" ? { queuePosition: null } : {}),
      ...(to !== "needs-input" && !("question" in extra) ? { question: null } : {}),
      // Leaving a pause by any route cancels its timed resume (module 02).
      ...(to !== "paused" && !("resumeAt" in extra) ? { resumeAt: null } : {}),
    };
    const updated = taskStore.patch(id, next, true);
    if (updated && from !== to) for (const listener of listeners) listener(updated, from);
    return true;
  },

  publish(task: TaskRecord): void {
    appEvents.publish({ type: "task", conversation: toPublicConversation(task) });
  },

  /** Called after every change of status (not for progress or plan updates). */
  onChange(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export const toPublic = (task: TaskRecord): Conversation => toPublicConversation(task);
