import type { Conversation, TaskInfo, TaskStatus } from "@tot/shared/types";
import type { DotTone } from "./computer";
import { toMs } from "./format";

/** A conversation that is a task, with its task info present. */
export type TaskConversation = Conversation & { kind: "task"; task: TaskInfo };

export function isTask(conversation: Conversation | null | undefined): conversation is TaskConversation {
  return conversation?.kind === "task" && conversation.task !== null;
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  "needs-input": "Needs input",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
};

/** The status dot: green while working, amber while it waits on the user or was cut off, red when it failed. */
export function taskTone(status: TaskStatus): { tone: DotTone; pulse: boolean } {
  switch (status) {
    case "running":
      return { tone: "green", pulse: true };
    case "needs-input":
    case "interrupted":
      return { tone: "amber", pulse: false };
    case "failed":
      return { tone: "red", pulse: false };
    default:
      return { tone: "gray", pulse: false };
  }
}

/** Badge tone for a status pill. */
export function taskBadgeTone(status: TaskStatus): "neutral" | "success" | "warning" | "danger" {
  if (status === "done") return "success";
  if (status === "failed") return "danger";
  if (status === "needs-input" || status === "interrupted") return "warning";
  return "neutral";
}

/** Still has work ahead (or is doing it): shown first in the sidebar. */
export function isOpenTask(status: TaskStatus): boolean {
  return status !== "done" && status !== "failed" && status !== "stopped";
}

/** Running or about to: what can be steered rather than picked up again. */
export function isSteerable(task: TaskInfo): boolean {
  return task.status === "running" || task.status === "queued" || (task.status === "needs-input" && !task.question);
}

/** "4m", "1h 12m", "2d": how long it has been working (until now, or until it finished). */
export function taskElapsed(task: TaskInfo, now = Date.now()): string | null {
  if (!task.startedAt) return null;
  const ms = Math.max(0, (task.finishedAt ? toMs(task.finishedAt) : now) - toMs(task.startedAt));
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

/** "12.4k" tokens. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** "acme/web" or the folder name, for showing a task's repo compactly. */
export function repoLabel(source: string): string {
  const github = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(source);
  if (github) return github[1]!;
  return source.replace(/\/+$/, "").split("/").pop() ?? source;
}

/**
 * The sidebar's order: open tasks (waiting on the user and running first, then the queue in
 * order, then interrupted or paused), then finished ones newest first.
 */
export function sortTasks(tasks: TaskConversation[]): { open: TaskConversation[]; finished: TaskConversation[] } {
  const rank: Partial<Record<TaskStatus, number>> = { "needs-input": 0, running: 1, queued: 2, interrupted: 3, paused: 4 };
  const open = tasks
    .filter((task) => isOpenTask(task.task.status))
    .sort(
      (a, b) =>
        (rank[a.task.status] ?? 9) - (rank[b.task.status] ?? 9) ||
        (a.task.queuePosition ?? 0) - (b.task.queuePosition ?? 0) ||
        toMs(b.updatedAt) - toMs(a.updatedAt),
    );
  const finished = tasks
    .filter((task) => !isOpenTask(task.task.status))
    .sort((a, b) => toMs(b.task.finishedAt ?? b.updatedAt) - toMs(a.task.finishedAt ?? a.updatedAt));
  return { open, finished };
}

/** "Waiting to start: 2 tasks ahead", from its place in the queue. */
export function queueLine(task: TaskInfo): string {
  const ahead = task.queuePosition ? task.queuePosition - 1 : null;
  if (ahead === null) return "Waiting to start";
  if (ahead === 0) return "Waiting to start: next in line";
  return `Waiting to start: ${ahead} ${ahead === 1 ? "task" : "tasks"} ahead`;
}

/** A row's one muted line about where the task is: its progress or its result. */
export function taskLine(task: TaskInfo): string | null {
  if (task.status === "queued") return queueLine(task);
  if (isOpenTask(task.status)) return task.progress;
  return task.result?.summary ?? task.summary;
}
