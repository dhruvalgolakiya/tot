import { randomUUID } from "node:crypto";
import type {
  ConversationOrigin,
  ConvertToTaskRequest,
  Message,
  MessagePart,
  ProviderId,
  Role,
  SendMessageRequest,
  SendMessageResponse,
  StartTaskRequest,
  TaskBrief,
  TaskChanges,
  TaskInfo,
  TaskPatch,
  TaskResult,
  Tier,
} from "../../shared/types.ts";
import { validateRepoSource } from "../agent/learn-repo.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { parseModelId } from "../agent/router.ts";
import { runRegistry } from "../agent/runs.ts";
import { appEvents } from "../app-events.ts";
import { agents } from "../data/agents.ts";
import { conversations, toPublicConversation } from "../data/conversations.ts";
import { messages } from "../data/messages.ts";
import { settings } from "../data/settings.ts";
import { checkSpawn, childDepth } from "../orchestration/budget.ts";
import { otherProvider, ROLE_NAMES, ROLES } from "../orchestration/roles.ts";
import { roleTier, TIERS } from "../orchestration/tiers.ts";
import { taskQueue } from "./queue.ts";
import { runLoop } from "./run-loop.ts";
import { steer } from "./steer.ts";
import { FINISHED, isTask, newTaskInfo, taskStore, type TaskRecord } from "./store.ts";
import { planRepo, worktrees } from "./worktree.ts";

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

function cleanModel(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (value !== "auto" && parseModelId(value) === "auto") throw new HttpError(400, `Unknown model "${value}".`);
  return value;
}

export interface CreateTaskInput extends StartTaskRequest {
  agentId: string;
  parentId?: string | null;
  origin?: ConversationOrigin;
  /** Orchestration: tasks spawned together, what the parent does when they've all finished, and the brief. */
  group?: string | null;
  then?: "synthesize" | null;
  brief?: TaskBrief | null;
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

/** A finished task's result goes back to the chat that started it: a note there, and its model hears on its next turn. */
function reportToParent(task: TaskRecord): void {
  const parent = task.parentId ? conversations.get(task.parentId) : null;
  if (!parent) return;
  conversations.update(parent.id, { childResults: [...new Set([...parent.childResults, task.id])] });
  const summary = (task.task.summary ?? "").replace(/\s+/g, " ").trim();
  const excerpt = summary.length > 180 ? `${summary.slice(0, 179).trimEnd()}…` : summary;
  const text = `${task.task.status === "done" ? `“${task.title}” is done` : `“${task.title}” failed`}${excerpt ? `: ${excerpt}` : "."}`;
  messages.insert({
    id: randomUUID(),
    conversationId: parent.id,
    role: "assistant",
    parts: [{ type: "notice", id: `n_${randomUUID().slice(0, 12)}`, kind: task.task.status === "done" ? "info" : "warning", text }],
    status: "complete",
    createdAt: Date.now(),
  });
  publishConversation(parent.id, true);
}

function create(input: CreateTaskInput): TaskRecord {
  const agent = agents.get(input.agentId);
  if (!agent) throw new HttpError(404, "Agent not found.");
  const goal = cleanGoal(input.goal);
  const title = cleanTitle(input.title) ?? taskTitle(goal);
  const source = cleanRepo(input.repo);
  const parent = input.parentId ? conversations.get(input.parentId) : null;
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
    task: {
      ...newTaskInfo(goal, source ? planRepo(source, title, input.baseBranch) : null),
      role,
      tier: cleanTier(input.tier) ?? (role ? roleTier(role) : null),
      provider,
      depth: parent ? childDepth(parent) : 1,
      group: input.group ?? null,
      then: input.then ?? null,
      brief: input.brief ?? null,
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
    const source = cleanRepo(request.repo);
    // The system prompt is written again on the next turn, with the task's instructions in it.
    conversations.update(
      chatId,
      { kind: "task", task: newTaskInfo(goal, source ? planRepo(source, chat.title, request.baseBranch) : null), systemPrompt: null },
      true,
    );
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

  stop(taskId: string): TaskRecord {
    const task = taskStore.require(taskId);
    if (FINISHED.has(task.task.status)) return task;
    taskStore.transition(taskId, "stopped", { summary: task.task.summary ?? "Stopped by you." });
    runRegistry.activeFor(taskId)?.stop();
    return taskStore.get(taskId)!;
  },

  /** To the front of its queue; it starts right away if its agent has a free slot. */
  runNow(taskId: string): TaskRecord {
    const task = taskStore.require(taskId);
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

  /** The agent's own report (task_update): what it's doing, its checklist, or a question for the user. */
  update(taskId: string, update: { progress?: string; plan?: TaskInfo["plan"]; question?: string }): TaskRecord {
    const task = taskStore.require(taskId);
    const patch: Partial<TaskInfo> = {};
    if (update.progress !== undefined) patch.progress = update.progress.trim().slice(0, 300) || null;
    if (update.plan) patch.plan = update.plan.slice(0, 30).map((step) => ({ text: step.text.trim().slice(0, 200), done: Boolean(step.done) }));
    taskStore.patch(taskId, patch);
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
    // Picking a coding task up again: its worktree must be there before the turn.
    if (task.task.repo && !task.task.repo.headSha) {
      taskStore.patch(taskId, { repo: await worktrees.ensure(task.agentId, task.task.repo) });
    }
    if (!taskStore.transition(taskId, "running")) throw new HttpError(409, `A ${status} task can't take messages.`);
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
    if (!FINISHED.has(task.task.status)) taskStore.transition(taskId, "stopped");
    runRegistry.activeFor(taskId)?.stop();
    await runLoop.settled(taskId);
    if (task.task.repo?.headSha) {
      await worktrees.remove(task.agentId, task.task.repo, { deleteBranch }).catch((err) => {
        console.warn(`[tot] couldn't remove the worktree of task ${taskId}:`, err instanceof Error ? err.message : err);
      });
    }
    conversations.delete(taskId);
    appEvents.publish({ type: "conversation-deleted", conversationId: taskId });
    appEvents.agentChanged(task.agentId);
  },

  async changes(taskId: string): Promise<TaskChanges> {
    const task = taskStore.require(taskId);
    const repo = task.task.repo;
    if (!repo) throw new HttpError(400, "This task has no repo.");
    if (!repo.headSha) throw new HttpError(409, "The task's branch isn't set up yet.");
    return worktrees.changes(task.agentId, repo);
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
      if (task.task.status === "done" || task.task.status === "failed") reportToParent(task);
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
      }
    }
    taskQueue.pump();
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
