import type { Conversation, MessagePart, Message, Project, Role, TaskChecks, TaskDiffStats, TaskInfo, TaskLanding, TaskStatus, Tier } from "@tot/shared/types";
import { ROLE_LABELS } from "./models";

/**
 * Tasks, mission control and projects, ported from apps/web/src/lib/tasks.ts, mission.ts, orchestration.ts,
 * projects.ts and TaskNotices.tsx: the same words and the same board, so a task reads the same on the phone.
 */

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

/** Still has work ahead (or is doing it). */
export function isOpenTask(status: TaskStatus): boolean {
  return status !== "done" && status !== "failed" && status !== "stopped";
}

/** Running or about to: what the composer steers (adds a note to) rather than starting a new turn. */
export function isSteerable(task: TaskInfo): boolean {
  return task.status === "running" || task.status === "queued" || (task.status === "needs-input" && !task.question);
}

export const canPause = (status: TaskStatus) => status === "running" || status === "queued" || status === "needs-input";
export const canResume = (status: TaskStatus) => status === "paused" || status === "interrupted";

/** "4m", "1h 12m", "2d": how long it has been working (until now, or until it finished). */
export function taskElapsed(task: TaskInfo, now = Date.now()): string | null {
  if (!task.startedAt) return null;
  const ms = Math.max(0, (task.finishedAt ?? now) - task.startedAt);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

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

/** "acme/web" or the folder name, for showing a task's repo compactly. */
export function repoLabel(source: string): string {
  const github = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(source);
  if (github) return github[1]!;
  return source.replace(/\/+$/, "").split("/").pop() ?? source;
}

/** "Researcher · standard" for a task's role and tier, when it has a role. */
export function roleLine(role: Role | null, tier: Tier | null): string | null {
  if (!role) return null;
  return tier ? `${ROLE_LABELS[role]} · ${tier}` : ROLE_LABELS[role];
}

/** Where a task is, in plain words, and whether Resume moves it on (the web's TaskEmptyState). */
export function taskState(task: TaskConversation, queueHeld: boolean): { text: string; resumable: boolean } {
  const { status, progress, question, summary } = task.task;
  switch (status) {
    case "queued":
      return { text: queueHeld ? "Waiting to start: the queue is paused" : queueLine(task.task), resumable: false };
    case "running":
      return { text: progress ?? "Starting…", resumable: false };
    case "needs-input":
      return { text: question ?? progress ?? "Waiting for you.", resumable: false };
    case "paused":
      return { text: progress ?? "Paused before it started.", resumable: true };
    case "interrupted":
      return { text: "Cut off when TOT restarted, before it replied.", resumable: true };
    default:
      return { text: summary ?? TASK_STATUS_LABELS[status], resumable: false };
  }
}

// ---------------------------------------------------------------------------
// Mission control (module 09)
// ---------------------------------------------------------------------------

export type MissionSection = "needs-you" | "working" | "ready" | "landed";

export const SECTION_TITLES: Record<MissionSection, string> = {
  "needs-you": "Needs you",
  working: "Working",
  ready: "Ready to land",
  landed: "Landed",
};

const FINISHED_STATUSES = new Set(["done", "failed", "stopped", "interrupted"]);

/** Where a task sits on the board: waiting on the user, working, finished with code to land, or landed (or finished without code). */
export function missionSection(task: TaskConversation): MissionSection {
  const { status, landing, repo } = task.task;
  // A draft PR is landed until its task works on it again (review fixes) and has new commits to push.
  const prWithNews = landing?.kind === "pr" && (!FINISHED_STATUSES.has(status) || (Boolean(repo?.headSha) && repo?.headSha !== landing.sha));
  if (landing && !prWithNews) return "landed";
  if (status === "needs-input" || status === "failed" || status === "interrupted") return "needs-you";
  if (status === "running" || status === "queued" || status === "paused") return "working";
  // Ready to land only with something to land: a task that read the code and changed nothing is finished.
  return repo?.headSha && (!task.task.stats || task.task.stats.files > 0) ? "ready" : "landed";
}

/** The board's sections in order, each sorted: running first, ready ones in land order, landed ones newest first. */
export function boardSections(tasks: TaskConversation[], landOrder: string[]): Record<MissionSection, TaskConversation[]> {
  const sections: Record<MissionSection, TaskConversation[]> = { "needs-you": [], working: [], ready: [], landed: [] };
  for (const task of tasks) sections[missionSection(task)].push(task);
  const newest = (a: TaskConversation, b: TaskConversation) => b.updatedAt - a.updatedAt;
  const rank: Record<string, number> = { running: 0, queued: 1, paused: 2 };
  sections["needs-you"].sort(newest);
  sections.working.sort(
    (a, b) => (rank[a.task.status] ?? 3) - (rank[b.task.status] ?? 3) || (a.task.queuePosition ?? 0) - (b.task.queuePosition ?? 0) || newest(a, b),
  );
  const place = (id: string) => (landOrder.includes(id) ? landOrder.indexOf(id) : landOrder.length);
  sections.ready.sort((a, b) => place(a.id) - place(b.id) || newest(a, b));
  const ended = (task: TaskConversation) => task.task.landing?.at ?? task.task.finishedAt ?? task.updatedAt;
  sections.landed.sort((a, b) => ended(b) - ended(a));
  return sections;
}

/** "+42 −7 · 3 files". */
export function statsLine(stats: TaskDiffStats): string {
  return `+${stats.added} −${stats.removed} · ${stats.files} file${stats.files === 1 ? "" : "s"}`;
}

/** "Merged into main · abc1234", "Draft PR against main", "Discarded". */
export function landingLine(landing: TaskLanding): string {
  if (landing.kind === "merged") return `Merged into ${landing.target ?? "main"}${landing.sha ? ` · ${landing.sha.slice(0, 7)}` : ""}`;
  if (landing.kind === "pr") return landing.pr ? `Draft PR #${landing.pr.number} against ${landing.target ?? "main"}` : `Draft PR against ${landing.target ?? "main"}`;
  return "Discarded";
}

/** What a task is doing, or what it needs, in one line. */
export function taskStatusLine(task: TaskConversation): string {
  const info = task.task;
  if (info.landing && missionSection(task) === "landed") return landingLine(info.landing);
  const firstLine = (text: string | null | undefined) => text?.split("\n").find((line) => line.trim())?.trim() ?? null;
  switch (info.status) {
    case "needs-input":
      return info.question ?? "Waiting for your OK";
    case "queued":
      return info.queuePosition ? `Waiting in line · #${info.queuePosition}` : "Waiting in line";
    case "interrupted":
      return "Cut off by a restart · resume it to carry on";
    case "paused":
      return info.progress ?? "Paused";
    case "running":
      return info.progress ?? info.goal;
    default:
      return firstLine(info.result?.summary) ?? firstLine(info.summary) ?? info.goal;
  }
}

export const CHECKS_LABELS: Record<TaskChecks["state"], string> = {
  running: "Checks running",
  passing: "Checks passing",
  failing: "Checks failing",
  none: "No checks",
};

/** A finished coding task with code not landed yet: what the Land and Discard buttons are for. */
export function isReadyToLand(task: TaskConversation): boolean {
  return missionSection(task) === "ready";
}

// ---------------------------------------------------------------------------
// Task groups and endings in a chat
// ---------------------------------------------------------------------------

/** The header's counts, in this order, e.g. "6 tasks · 1 running · 4 done · 1 paused" (only states some task is in). */
const COUNTS: [TaskStatus, string][] = [
  ["needs-input", "need you"],
  ["running", "running"],
  ["queued", "queued"],
  ["interrupted", "cut off"],
  ["paused", "paused"],
  ["done", "done"],
  ["failed", "failed"],
  ["stopped", "stopped"],
];

export function groupSummary(group: TaskConversation[]): string {
  const bestOf = group[0]?.task.groupKind === "best-of";
  const counts = COUNTS.map(([status, label]) => {
    const count = group.filter((task) => task.task.status === status).length;
    return count ? `${count} ${label}` : null;
  });
  return [bestOf ? `Best of ${group.length}` : `${group.length} tasks`, ...counts].filter(Boolean).join(" · ");
}

type Notice = Extract<MessagePart, { type: "notice" }>;

/** How the server words a task's ending in its chat (apps/server/tasks/tasks.ts endingNotice). */
const ENDING = /^“(.+?)” (is done|failed|was stopped|was cut off when TOT restarted)(?:[^:]*?)(?::\s*([\s\S]*))?\.?$/;
const ENDING_STATUS: Record<string, TaskStatus> = {
  "is done": "done",
  failed: "failed",
  "was stopped": "stopped",
  "was cut off when TOT restarted": "interrupted",
};

export function isTaskEndingNotice(part: MessagePart): part is Notice {
  return part.type === "notice" && !part.group && (Boolean(part.taskId) || ENDING.test(part.text));
}

/** A message that is nothing but task endings: it joins its neighbours in one compact list. */
export function isTaskEndingMessage(message: Message): boolean {
  return message.role === "assistant" && message.status === "complete" && message.parts.length > 0 && message.parts.every(isTaskEndingNotice);
}

/** A task-ending notice, read: its title, how it ended and the start of its result. */
export function readEnding(notice: Notice): { title: string; status: TaskStatus; result: string } {
  const match = ENDING.exec(notice.text);
  return {
    title: match?.[1] ?? notice.text,
    status: (match && ENDING_STATUS[match[2]!]) ?? (notice.kind === "warning" ? "failed" : "done"),
    result: (match?.[3] ?? "").replace(/\s+/g, " ").replace(/…$/, "").trim(),
  };
}

// ---------------------------------------------------------------------------
// Projects (modules 06, 11)
// ---------------------------------------------------------------------------

/** It has code to look at: a repo or a folder. */
export function isCodeProject(project: Pick<Project, "kind">): boolean {
  return project.kind !== "none";
}

/** A code project agents may work in (a folder needs the user's OK on the computer first). */
export function canPickWorkspace(project: Project): boolean {
  return isCodeProject(project) && !(project.kind === "folder" && !project.folderGranted);
}

/** "/Users/dhruval/playground/x" → "~/playground/x". */
function tildePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** "GitHub acme/web · main", "~/playground/meet-notes", or "No files". */
export function sourceLabel(project: Project): string {
  if (project.kind === "folder") return project.source ? tildePath(project.source) : "Folder";
  if (project.kind === "none") return "No files";
  const source = project.source ?? "";
  const repo = /^[\w.-]+\/[\w.-]+$/.test(source) ? `GitHub ${source}` : source.replace(/^[a-z]+:\/\//i, "").replace(/\.git$/i, "");
  return project.defaultBranch ? `${repo} · ${project.defaultBranch}` : repo;
}
