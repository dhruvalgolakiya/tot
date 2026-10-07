import { randomUUID } from "node:crypto";
import type {
  Agent,
  ConversationOrigin,
  ConvertToTaskRequest,
  Message,
  MessagePart,
  Project,
  ProviderId,
  Role,
  SendMessageRequest,
  SendMessageResponse,
  StartTaskRequest,
  TaskBrief,
  TaskChanges,
  TaskPlan,
  TaskGroupKind,
  TaskInfo,
  TaskPatch,
  TaskRepo,
  TaskResult,
  Tier,
} from "../../shared/types.ts";
import { validateRepoSource } from "../agent/learn-repo.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { parseModelId } from "../agent/router.ts";
import { runRegistry } from "../agent/runs.ts";
import { appEvents } from "../app-events.ts";
import { computerManager } from "../computer/manager.ts";
import { agents } from "../data/agents.ts";
import { conversations, toPublicConversation } from "../data/conversations.ts";
import { checkout, grantFor, prepareTaskNow } from "../projects/checkout.ts";
import { projects } from "../projects/projects.ts";
import { projectRepos } from "../projects/repos.ts";
import { ticketKeyOf } from "../projects/tickets.ts";
import { messages } from "../data/messages.ts";
import { queueHolds } from "../data/queue-holds.ts";
import { settings } from "../data/settings.ts";
import { taskChecks } from "../landing/checks.ts";
import { checkSpawn, childDepth } from "../orchestration/budget.ts";
import { otherProvider, ROLE_NAMES, ROLES } from "../orchestration/roles.ts";
import { roleTier, TIERS } from "../orchestration/tiers.ts";
import { previews } from "../worktrees/preview.ts";
import { taskQueue } from "./queue.ts";
import { runLoop } from "./run-loop.ts";
import { steer } from "./steer.ts";
import { FINISHED, isTask, newTaskInfo, taskStore, type TaskRecord } from "./store.ts";
import { chatWakes } from "./wake.ts";
import { planPath } from "./prompt.ts";
import { homeRelative, inFolder, planRepo, worktrees } from "./worktree.ts";

/**
 * Task lifecycle: creating tasks (from a chat, by the agent or the user; top-level; by turning
 * a chat into one), pausing, resuming, stopping, the agent's own updates and finish, replies,
 * and removal. A task is a conversation, so its transcript, approvals, model and computer work
 * exactly as in a chat.
 */

const MAX_GOAL = 4000;
const MAX_TITLE = 120;

/** Instant title from the goal: its first line, cut at a word. */
export function taskTitle(goal: string): string {
  const line =
    goal
      .replace(/[`*_#>[\]()]/g, "")
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "Task";
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 24 ? cut.lastIndexOf(" ") : 60)}…`;
}

function cleanGoal(value: unknown): string {
  const goal = typeof value === "string" ? value.trim() : "";
  if (!goal) throw new HttpError(400, "Say what the task should do.");
  if (goal.length > MAX_GOAL) throw new HttpError(400, `Keep the goal under ${MAX_GOAL} characters.`);
  return goal;
}

function cleanTitle(value: unknown): string | undefined {
  const title = typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) : "";
  return title || undefined;
}

function cleanRepo(value: unknown): string | undefined {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return undefined;
  const source = validateRepoSource(value);
  if (settings.get().computer.mode === "off") {
    throw new HttpError(400, "Coding tasks need a computer to work on. Turn one on in Settings → Computer.");
  }
  return source;
}

/**
 * A new task's repo. Inside a project with code it's one of the project's repos, in its folder (module
 * 06): the one `repo` names, or the primary (module 11); a folder on this Mac must be allowed, a git repo,
 * and on a local computer.
 */
function taskRepo(
  agentId: string,
  project: Project | null,
  repo: unknown,
  title: string,
  baseBranch?: string,
  ticketKey?: string | null,
): TaskRepo | null {
  const own = project ? projectRepos.pick(project, repo) : null;
  if (!project || !own) {
    const source = cleanRepo(repo);
    return source ? planRepo(source, title, baseBranch, ticketKey) : null;
  }
  if (own.kind === "folder") checkout.usableRepoFolder(agentId, project, own, { forTasks: true });
  const source = cleanRepo(own.source)!;
  const planned = planRepo(source, title, baseBranch ?? own.defaultBranch ?? undefined, ticketKey);
  return { ...inFolder(planned, projectRepos.folder(own)), repoName: own.name };
}

function cleanModel(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (value !== "auto" && parseModelId(value) === "auto") throw new HttpError(400, `Unknown model "${value}".`);
  return value;
}

export interface CreateTaskInput extends StartTaskRequest {
  agentId: string;
  parentId?: string | null;
  /** A top-level task's project (module 06); a task started from a chat is in the chat's. */
  projectId?: string | null;
  origin?: ConversationOrigin;
  /** Orchestration: tasks spawned together, what the parent does when they've all finished, and the brief. */
  group?: string | null;
  then?: "synthesize" | null;
  brief?: TaskBrief | null;
  /** What the group is (module 09): split from one job, or the same job on several providers. */
  groupKind?: TaskGroupKind | null;
}

function cleanRole(value: unknown): Role | null {
  if (value === undefined || value === null || value === "") return null;
  if (!ROLE_NAMES.includes(value as Role)) throw new HttpError(400, `Unknown role "${value}". Roles: ${ROLE_NAMES.join(", ")}.`);
  return value as Role;
}

function cleanTier(value: unknown): Tier | null {
  if (value === undefined || value === null || value === "") return null;
  if (!TIERS.includes(value as Tier)) throw new HttpError(400, `Unknown tier "${value}". Tiers: ${TIERS.join(", ")}.`);
  return value as Tier;
}

function cleanProvider(value: unknown): ProviderId | null {
  if (value === undefined || value === null || value === "") return null;
  if (value !== "claude" && value !== "chatgpt") throw new HttpError(400, `Unknown provider "${value}".`);
  return value;
}

function publishConversation(id: string, touch = false): void {
  const record = conversations.update(id, {}, touch);
  if (record) appEvents.publish({ type: "conversation", conversation: toPublicConversation(record) });
}

/**
 * Adds tasks' cards to the chat that started them: into the agent's reply while it's being
 * written, or as a message of their own (after the user's request, when they typed it).
 */
export function showCards(parentId: string, taskIds: string[], opts: { userText?: string; text?: string } = {}): void {
  const parts: MessagePart[] = taskIds.map((taskId) => ({ type: "task", id: `t_${randomUUID().slice(0, 12)}`, taskId }));
  const run = runRegistry.activeFor(parentId);
  if (!opts.userText && !opts.text && run?.addPart) {
    for (const part of parts) run.addPart(part);
    return;
  }
  const now = Date.now();
  if (opts.userText) {
    messages.insert({
      id: randomUUID(),
      conversationId: parentId,
      role: "user",
      parts: [{ type: "text", id: randomUUID(), text: opts.userText }],
      status: "complete",
      createdAt: now,
    });
  }
  const text: MessagePart[] = opts.text ? [{ type: "text", id: randomUUID(), text: opts.text }] : [];
  messages.insert({ id: randomUUID(), conversationId: parentId, role: "assistant", parts: [...text, ...parts], status: "complete", createdAt: now + 1 });
  publishConversation(parentId, true);
}

/** Tasks being deleted: their ending isn't news to the chat that started them. */
const removing = new Set<string>();

/** How a task's ending reads in the chat that started it. */
function endingNotice(task: TaskRecord): string {
  const { status } = task.task;
  if (status === "stopped") return `“${task.title}” was stopped.`;
  if (status === "interrupted") return `“${task.title}” was cut off when TOT restarted and is waiting for you to resume it.`;
  const summary = (task.task.summary ?? "").replace(/\s+/g, " ").trim();
  const excerpt = summary.length > 180 ? `${summary.slice(0, 179).trimEnd()}…` : summary;
  return `${status === "done" ? `“${task.title}” is done` : `“${task.title}” failed`}${excerpt ? `: ${excerpt}` : "."}`;
}

/**
 * Every ending of a task (done, failed, stopped, or cut off by a restart without resuming) goes back
 * to the chat that started it: a note there, and its model hears on its next turn (or a wake-up).
 */
function reportToParent(task: TaskRecord): void {
  const parent = task.parentId ? conversations.get(task.parentId) : null;
  if (!parent || removing.has(task.id)) return;
  conversations.update(parent.id, { childResults: [...new Set([...parent.childResults, task.id])] });
  // A best-of run (module 09) ends with one notice for the whole group, once they've all finished (mission/best-of.ts).
  if (task.task.groupKind !== "best-of") {
    messages.insert({
      id: randomUUID(),
      conversationId: parent.id,
      role: "assistant",
      parts: [{ type: "notice", id: `n_${randomUUID().slice(0, 12)}`, kind: task.task.status === "done" ? "info" : "warning", text: endingNotice(task) }],
      status: "complete",
      createdAt: Date.now(),
    });
  }
  publishConversation(parent.id, true);
  chatWakes.flag(task);
}

function create(input: CreateTaskInput): TaskRecord {
  const agent = agents.get(input.agentId);
  if (!agent) throw new HttpError(404, "Agent not found.");
  const goal = cleanGoal(input.goal);
  const title = cleanTitle(input.title) ?? taskTitle(goal);
  const parent = input.parentId ? conversations.get(input.parentId) : null;
  // Inside a project with code, a task always works on the project's repo (module 06).
  const project = projects.get(parent?.projectId ?? input.projectId);
  // A task about a ticket (its own, or its chat's) names its branch after it.
  const repo = taskRepo(agent.id, project, input.repo, title, input.baseBranch, ticketKeyOf(input.origin, parent?.id));
  const role = cleanRole(input.role);
  // A reviewer runs on the other provider from the session whose work it reviews.
  const provider = cleanProvider(input.provider) ?? (role && ROLES[role].otherProvider && parent?.provider ? otherProvider(parent.provider) : null);
  const record = conversations.create({
    agentId: agent.id,
    modelId: cleanModel(input.modelId) ?? agent.modelId,
    title,
    origin: input.origin,
    kind: "task",
    parentId: parent?.id ?? null,
    // A task works in its chat's project.
    projectId: project?.id ?? null,
    task: {
      ...newTaskInfo(goal, repo),
      role,
      tier: cleanTier(input.tier) ?? (role ? roleTier(role) : null),
      provider,
      depth: parent ? childDepth(parent) : 1,
      group: input.group ?? null,
      then: input.then ?? null,
      brief: input.brief ?? null,
      ...(input.groupKind ? { groupKind: input.groupKind } : {}),
    },
  });
  const task = taskStore.get(record.id)!;
  taskStore.publish(task);
  appEvents.agentChanged(agent.id);
  taskQueue.enqueue(task.id);
  return taskStore.get(task.id)!;
}

let unsubscribe: (() => void) | null = null;

export const tasks = {
  create,
  showCards,

  /**
   * A task started from a chat: by its agent (task_start; the card goes into the reply being
   * written) or by the user ("Run as task"; their request and the card are added to the chat).
   */
  startFromChat(parentId: string, request: StartTaskRequest & Pick<CreateTaskInput, "brief">, by: "agent" | "user"): TaskRecord {
    const parent = conversations.get(parentId);
    if (!parent) throw new HttpError(404, "Chat not found.");
    checkSpawn(parent, 1);
    const task = create({ ...request, agentId: parent.agentId, parentId, modelId: request.modelId ?? parent.modelId });
    showCards(parentId, [task.id], by === "user" ? { userText: request.goal.trim() } : {});
    return task;
  },

  /** Turns a chat into a task, keeping its transcript (the provider session carries on). */
  convert(chatId: string, request: ConvertToTaskRequest): TaskRecord {
    const chat = conversations.get(chatId);
    if (!chat) throw new HttpError(404, "Chat not found.");
    if (chat.kind === "task") throw new HttpError(400, "This is already a task.");
    if (runRegistry.activeFor(chatId)) throw new HttpError(409, "Wait for the reply to finish, then make it a task.");
    const goal = cleanGoal(request.goal?.trim() || chat.title);
    const repo = taskRepo(chat.agentId, projects.get(chat.projectId), request.repo, chat.title, request.baseBranch, ticketKeyOf(chat.origin, chat.parentId));
    // The system prompt is written again on the next turn, with the task's instructions in it.
    conversations.update(chatId, { kind: "task", task: newTaskInfo(goal, repo), systemPrompt: null }, true);
    taskStore.publish(taskStore.get(chatId)!);
    appEvents.agentChanged(chat.agentId);
    taskQueue.enqueue(chatId);
    return taskStore.get(chatId)!;
  },

  /** Back to a plain chat (its branch and worktree stay where they are). */
  toChat(taskId: string): void {
    const task = taskStore.require(taskId);
    if (!FINISHED.has(task.task.status) && task.task.status !== "paused" && task.task.status !== "interrupted") {
      throw new HttpError(409, "Stop or pause the task first.");
    }
    conversations.update(taskId, { kind: "chat", task: null, systemPrompt: null }, true);
    publishConversation(taskId);
    appEvents.agentChanged(task.agentId);
  },

  pause(taskId: string): TaskRecord {
    const task = taskStore.require(taskId);
    if (task.task.status === "paused" || !taskStore.transition(taskId, "paused")) throw new HttpError(409, `A ${task.task.status} task can't be paused.`);
    runRegistry.activeFor(taskId)?.stop();
    return taskStore.get(taskId)!;
  },

  /** Back in the queue; it continues from its plan when a slot is free. */
  resume(taskId: string, { front = false } = {}): TaskRecord {
    const task = taskStore.require(taskId);
    if (task.task.status === "queued") return task;
    if (task.task.status === "running" || task.task.status === "needs-input") throw new HttpError(409, "The task is already running.");
    if (!taskQueue.enqueue(taskId, { front })) throw new HttpError(409, `A ${task.task.status} task can't be resumed.`);
    return taskStore.get(taskId)!;
  },

  /** `why` is its summary when someone other than the user stops it (a project's Lead, module 12). */
  stop(taskId: string, why?: string): TaskRecord {
    const task = taskStore.require(taskId);
    if (FINISHED.has(task.task.status)) return task;
    taskStore.transition(taskId, "stopped", { summary: why ?? task.task.summary ?? "Stopped by you." });
    runRegistry.activeFor(taskId)?.stop();
    return taskStore.get(taskId)!;
  },

  /** A paused queue (a provider kept failing) starts tasks again. */
  resumeQueue(agentId: string): Agent {
    if (!agents.get(agentId)) throw new HttpError(404, "Agent not found.");
    if (queueHolds.clear(agentId)) appEvents.agentChanged(agentId);
    taskQueue.pump();
    return agents.get(agentId)!;
  },

  /** To the front of its queue; it starts right away if its agent has a free slot (resuming a paused queue: the user asked). */
  runNow(taskId: string): TaskRecord {
    const task = taskStore.require(taskId);
    if (queueHolds.clear(task.agentId)) appEvents.agentChanged(task.agentId);
    if (task.task.status === "queued") {
      taskQueue.move(taskId, 1);
      taskQueue.pump();
      return taskStore.get(taskId)!;
    }
    return tasks.resume(taskId, { front: true });
  },

  patch(taskId: string, patch: TaskPatch): TaskRecord {
    const task = taskStore.require(taskId);
    const title = patch.title === undefined ? undefined : cleanTitle(patch.title);
    if (patch.title !== undefined && !title) throw new HttpError(400, "Title can't be empty.");
    if (title) conversations.update(taskId, { title });
    if (patch.goal !== undefined) taskStore.patch(taskId, { goal: cleanGoal(patch.goal) });
    if (patch.queuePosition !== undefined) {
      if (task.task.status !== "queued") throw new HttpError(409, "Only queued tasks have a place in the queue.");
      if (!Number.isFinite(patch.queuePosition)) throw new HttpError(400, "Invalid queue position.");
      taskQueue.move(taskId, patch.queuePosition);
    }
    const updated = taskStore.get(taskId)!;
    taskStore.publish(updated);
    return updated;
  },

  /** The agent's own report (task_update): what it's doing, or a question for the user. (Its plan is a file: plan().) */
  update(taskId: string, update: { progress?: string; question?: string }): TaskRecord {
    const task = taskStore.require(taskId);
    if (update.progress !== undefined) taskStore.patch(taskId, { progress: update.progress.trim().slice(0, 300) || null });
    const question = update.question?.trim();
    if (question && (task.task.status === "running" || task.task.status === "needs-input")) {
      taskStore.transition(taskId, "needs-input", { question: question.slice(0, 1000) });
    }
    return taskStore.get(taskId)!;
  },

  /** The agent's task_finish: the result (with its structured parts, when given), reported back to whoever asked. */
  finish(taskId: string, outcome: "done" | "failed", summary: string, result?: TaskResult): TaskRecord {
    const task = taskStore.require(taskId);
    const working = task.task.status === "running" || task.task.status === "needs-input";
    const extra: Partial<TaskInfo> = { summary: summary.trim().slice(0, 20_000) || null, progress: null, ...(result ? { result } : {}) };
    if (!working || !taskStore.transition(taskId, outcome, extra)) {
      throw new HttpError(409, `The task is ${task.task.status}; it can't be finished now.`);
    }
    return taskStore.get(taskId)!;
  },

  /**
   * A message to a task (from the chat composer, Slack or email): a running or queued task is
   * steered; any other is picked up again, with the message as its next turn.
   */
  async message(taskId: string, request: SendMessageRequest): Promise<{ steered: Message } | { started: SendMessageResponse }> {
    const task = taskStore.require(taskId);
    const { status, question } = task.task;
    const waitingOnUser = status === "needs-input" && question && !runRegistry.activeFor(taskId);
    if ((status === "running" || status === "queued" || status === "needs-input") && !waitingOnUser) {
      if (request.attachments?.length) throw new HttpError(409, "Attach files once the task has stopped, or send the note as text.");
      return { steered: steer(taskId, request.text ?? "") };
    }
    // Picking it up again, alone for the task (worktrees.forTask): cleanup can't take its worktree meanwhile.
    const pickedUp = await worktrees.forTask(taskId, async () => {
      const current = taskStore.require(taskId);
      // Someone else picked it up first: this message goes to it as theirs does.
      if (current.task.status !== status) return false;
      const { landing } = current.task;
      // Merged or discarded, its worktree is gone: new work gets a new one (from the base when its branch went too), and can land again.
      const reopened = landing?.kind === "merged" || landing?.kind === "discarded";
      const repo = current.task.repo && reopened ? { ...current.task.repo, headSha: null } : current.task.repo;
      // A coding task's worktree must be there before the turn.
      if (repo && !repo.headSha) {
        const prepared = await prepareTaskNow({ ...current, task: { ...current.task, repo } });
        taskStore.patch(taskId, { repo: prepared, ...(reopened ? { landing: null } : {}) });
      }
      if (!taskStore.transition(taskId, "running")) throw new HttpError(409, `A ${status} task can't take messages.`);
      return true;
    });
    if (!pickedUp) return tasks.message(taskId, request);
    let started: SendMessageResponse;
    try {
      started = await runLoop.send(taskId, request, runLoop.turnOptions(task));
    } catch (err) {
      taskStore.transition(taskId, "failed", { summary: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    // The loop waits for this turn, then keeps the task going.
    runLoop.start(taskId);
    return { started };
  },

  /** Deletes a task with its worktree; its branch too when asked and it was never pushed. */
  async remove(taskId: string, { deleteBranch = false } = {}): Promise<void> {
    const task = taskStore.require(taskId);
    removing.add(taskId);
    if (!FINISHED.has(task.task.status)) taskStore.transition(taskId, "stopped");
    runRegistry.activeFor(taskId)?.stop();
    await runLoop.settled(taskId);
    // Its preview (module 09) goes before its worktree does.
    await previews.stop(taskId);
    if (task.task.repo?.headSha) {
      const repo = task.task.repo;
      await Promise.resolve()
        .then(() => worktrees.remove(task.agentId, repo, { deleteBranch, force: true, grant: grantFor(task) }))
        .catch((err) => {
          console.warn(`[tot] couldn't remove the worktree of task ${taskId}:`, err instanceof Error ? err.message : err);
        });
    }
    conversations.delete(taskId);
    removing.delete(taskId);
    appEvents.publish({ type: "conversation-deleted", conversationId: taskId });
    appEvents.agentChanged(task.agentId);
  },

  /**
   * GET /api/tasks/:id/plan: the task's own plan file on its agent's computer. Read only from a computer that's on
   * (or local, which costs nothing to reach); a cloud computer that's off isn't started just to show a plan.
   */
  async plan(taskId: string): Promise<TaskPlan> {
    const task = taskStore.require(taskId);
    const path = planPath(taskId);
    const computer = computerManager.get(task.agentId);
    if (!computer || (computer.kind !== "local" && computer.state !== "running")) {
      return { path, content: null, reason: "The agent's computer is off. The plan shows here while it's on." };
    }
    try {
      const active = await computerManager.ensure(task.agentId);
      const content = await active.backend.readFile(active.externalId, homeRelative(path));
      return { path, content: content.trim() ? content : null, reason: null };
    } catch {
      // No file yet (the agent hasn't written one), or it can't be read right now.
      return { path, content: null, reason: null };
    }
  },

  async changes(taskId: string): Promise<TaskChanges> {
    const task = taskStore.require(taskId);
    const repo = task.task.repo;
    if (!repo) throw new HttpError(400, "This task has no repo.");
    if (!repo.headSha) throw new HttpError(409, "The task's branch isn't set up yet.");
    return worktrees.changes(task.agentId, repo, grantFor(task));
  },

  /**
   * On startup: tasks that were running when TOT stopped are "interrupted" (a turn cut off
   * mid-way can't finish), and go back to the front of their queue when Settings → Tasks says
   * so. Also keeps the queue moving, reports finished tasks to their chats, and mirrors
   * approval cards in task status ("needs-input" while one waits).
   */
  start(): void {
    if (unsubscribe) return;
    taskQueue.start();
    const offChange = taskStore.onChange((task) => {
      if (FINISHED.has(task.task.status)) reportToParent(task);
      // Module 09: a coding task that's done gets its repo's checks.
      if (task.task.status === "done" && task.task.repo) taskChecks.afterDone(task.id);
    });
    const offApprovals = appEvents.subscribe((event) => {
      if (event.type !== "approval") return;
      const task = taskStore.get(event.conversationId);
      if (!task) return;
      if (event.pending && task.task.status === "running") taskStore.transition(task.id, "needs-input", { question: null });
      if (!event.pending && task.task.status === "needs-input" && !task.task.question) taskStore.transition(task.id, "running");
    });
    unsubscribe = () => {
      offChange();
      offApprovals();
      taskQueue.stop();
    };

    const resume = settings.get().tasks.resumeInterrupted;
    for (const task of conversations.tasks()) {
      if (!isTask(task)) continue;
      const { status, question } = task.task;
      if (status !== "running" && !(status === "needs-input" && !question)) continue;
      taskStore.transition(task.id, "interrupted");
      if (resume) {
        runLoop.markRestarted(task.id);
        taskQueue.enqueue(task.id, { front: true });
      } else {
        // It won't resume by itself: the chat that started it hears so.
        reportToParent(taskStore.get(task.id)!);
      }
    }
    taskQueue.pump();
    taskChecks.recover();
  },

  /** The server is stopping: running turns get stopped, and their tasks resume (or show as interrupted) next time. */
  shutdown(): void {
    runLoop.shutdown();
  },

  /** Tests: forget listeners, as a restarted server would. */
  stopListening(): void {
    unsubscribe?.();
    unsubscribe = null;
  },
};
