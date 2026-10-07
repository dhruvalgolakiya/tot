import { setImmediate as tick, setTimeout as sleep } from "node:timers/promises";
import type { Message, MessageStatus, ProviderId, RunEvent, SendMessageRequest } from "../../shared/types.ts";
import { HANDOFF_TAIL_BUDGET, lastExchange } from "../agent/context-select.ts";
import { limits } from "../agent/limits.ts";
import { HttpError, sendMessage, type TurnOptions } from "../agent/orchestrator.ts";
import { runRegistry } from "../agent/runs.ts";
import { appEvents } from "../app-events.ts";
import { conversations } from "../data/conversations.ts";
import { messageText, messages } from "../data/messages.ts";
import { queueHolds } from "../data/queue-holds.ts";
import { overBudget } from "../orchestration/budget.ts";
import { renderBrief } from "../orchestration/roles.ts";
import { grantFor, prepareTask } from "../projects/checkout.ts";
import { continuationPreamble, handoffPreamble } from "./prompt.ts";
import { ACTIVE, taskStore, type TaskRecord } from "./store.ts";
import { worktrees } from "./worktree.ts";

/**
 * Keeps a task going. One provider turn ends when the model stops talking; a task keeps
 * going until the agent calls task_finish: after each turn that made progress (ticked its
 * plan, changed its branch, or used tools), TOT sends another turn with the plan so far.
 * Turns that make no progress twice in a row mean it's stuck: the task fails as "stalled"
 * (the same rule as Learn a repo's study steps). Everything a loop needs to carry on lives in
 * the conversation and its task, so after a restart a new loop picks up where it left off.
 */

/** Model/tool steps one turn may take; a turn that runs out is simply continued. */
const STEP_LIMIT = 200;
/** Turns a task may take before TOT stops it and asks the user to look. */
const MAX_TURNS = 40;
/** Turns in a row without progress (or failing) before the task counts as stalled. */
const MAX_STALLS = 2;
/** Past this much context, the next turn starts a fresh session with the plan carried over. */
const FRESH_SESSION_TOKENS = 150_000;
/** How long a loop waits for a turn someone else started in the task to end. */
const BUSY_WAIT_MS = 10 * 60_000;

type Sender = typeof sendMessage;
type RunEnd = Extract<RunEvent, { type: "run-end" }>;

/** How a turn is started; tests swap in a fake. */
let send: Sender = sendMessage;
let shuttingDown = false;

/** Task id → its loop, while one runs. */
const loops = new Map<string, { agentId: string; done: Promise<void> }>();
/** Steering notes waiting for the task's next turn (they missed the turn that was running). */
const notes = new Map<string, string[]>();
/** Tasks resumed after a restart, whose next turn should say so. */
const restarted = new Set<string>();
/** Tasks whose next turn starts a fresh session from their handoff packet, and why (a provider switch). */
const handOffs = new Map<string, string>();
const idleListeners = new Set<() => void>();
/** What to do when a task's provider hits its usage limit mid-run (orchestration/failover.ts): switch, or pause. */
let onLimit: ((taskId: string, provider: ProviderId) => Promise<"switched" | "paused">) | null = null;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Resolves with how a run ended (null when it's unknown). */
export function runEnd(runId: string): Promise<RunEnd | null> {
  const run = runRegistry.get(runId);
  if (!run) return Promise.resolve(null);
  return new Promise((resolve) => {
    run.subscribe((_seq, event) => {
      if (event.type === "run-end") resolve(event);
    });
  });
}

/** Waits (up to a limit) for turns someone else started in the task to end. */
async function waitForIdle(conversationId: string): Promise<void> {
  const until = Date.now() + BUSY_WAIT_MS;
  for (let run = runRegistry.activeFor(conversationId); run && Date.now() < until; run = runRegistry.activeFor(conversationId)) {
    await Promise.race([runEnd(run.id), sleep(until - Date.now())]);
  }
}

const workingChildren = (taskId: string) => conversations.tasks({ parentId: taskId }).filter((child) => child.task && ACTIVE.has(child.task.status));

/** A task that started tasks of its own waits for them before its next turn, which gets their results. */
async function waitForChildren(taskId: string): Promise<void> {
  if (!workingChildren(taskId).length) return;
  await new Promise<void>((resolve) => {
    const check = () => {
      const self = taskStore.get(taskId);
      if (shuttingDown || !self || self.task.status !== "running" || !workingChildren(taskId).length) {
        stop();
        resolve();
      }
    };
    const stop = taskStore.onChange(check);
    check();
  });
}

interface Snapshot {
  plan: string;
  progress: string | null;
  headSha: string | null;
}

const snapshot = (task: TaskRecord): Snapshot => ({
  plan: JSON.stringify(task.task.plan),
  progress: task.task.progress,
  headSha: task.task.repo?.headSha ?? null,
});

/** Whether a turn moved the task forward: it ticked the plan, changed the branch, or got tools to work. */
export function madeProgress(before: Snapshot, after: Snapshot, reply: Message | undefined): boolean {
  const toolsWorked = (reply?.parts ?? []).some((part) => part.type === "tool" && part.status === "done");
  return toolsWorked || before.plan !== after.plan || before.progress !== after.progress || before.headSha !== after.headSha;
}

/** The next turn: the goal to start with, else "continue" with the plan, notes and context carried over. */
function nextTurn(task: TaskRecord): { body: SendMessageRequest; options: TurnOptions } {
  const history = messages.listByConversation(task.id);
  const pending = notes.get(task.id) ?? [];
  notes.delete(task.id);
  const wasRestarted = restarted.delete(task.id);
  const options = turnOptions(task);
  // A new task (nothing in it yet but notes the user sent while it waited) starts with its brief, or its goal.
  if (history.every((m) => m.steered)) {
    const preamble = pending.map((note) => `[The user added before you started: “${note}”]`).join("\n");
    return { body: { text: task.task.brief ? renderBrief(task.task.brief) : task.task.goal }, options: { ...options, ...(preamble ? { preamble } : {}) } };
  }
  const lastReply = history.findLast((m) => m.role === "assistant");
  // After a provider switch the new session starts from the handoff packet instead of the transcript.
  const handOff = handOffs.get(task.id);
  handOffs.delete(task.id);
  const packet = handOff ? task.task.handoff : null;
  const fresh = Boolean(packet) || (lastReply?.usage?.inputTokens ?? 0) > FRESH_SESSION_TOKENS;
  const continuation = continuationPreamble(task.task, task.id, {
    turn: task.task.turns + 1,
    notes: pending,
    restarted: wasRestarted,
    fresh: fresh && !packet,
    lastReply: lastReply ? messageText(lastReply) : "",
    firstTurnOfConvertedChat: task.task.turns === 0,
    handedOff: Boolean(packet),
  });
  return {
    body: { text: pending.length ? "Continue the task, with my note in mind." : "Continue the task." },
    options: {
      ...options,
      auto: true,
      freshSession: fresh,
      preamble: packet
        ? `${handoffPreamble(packet, `${handOff}.`, lastExchange(history, { budgetTokens: HANDOFF_TAIL_BUDGET, chatId: task.id }))}\n${continuation}`
        : continuation,
    },
  };
}

/** Task turns are real work: under TOT Auto they run on the task's tier (deep unless its role says otherwise) and preferred provider. */
function turnOptions(task: TaskRecord): TurnOptions {
  return {
    keepTitle: true,
    heavy: task.task.role ?? (task.task.repo ? "coding task" : "task"),
    tier: task.task.tier ?? "deep",
    prefer: task.task.provider,
    maxSteps: STEP_LIMIT,
  };
}

/** A task's folder grant (module 06), or none when its folder can't be used right now: its head then reads as unknown. */
function folderGrant(task: TaskRecord) {
  try {
    return grantFor(task);
  } catch {
    return null;
  }
}

/** After a turn: add up its tokens and note where the branch is now, and how much it changed (module 09). */
async function recordTurn(task: TaskRecord, reply: Message | undefined): Promise<Snapshot> {
  const repo = task.task.repo;
  const grant = repo ? folderGrant(task) : null;
  const headSha = repo ? await worktrees.head(task.agentId, repo, grant) : null;
  const stats = repo && headSha ? await worktrees.stats(task.agentId, repo, grant).catch(() => null) : null;
  // Against the task as it is now: what changed while git ran (its repo, its usage) stays, only the head and stats are new.
  const current = taskStore.get(task.id);
  if (!current) return snapshot(task);
  const usage = {
    inputTokens: current.task.usage.inputTokens + (reply?.usage?.inputTokens ?? 0),
    outputTokens: current.task.usage.outputTokens + (reply?.usage?.outputTokens ?? 0),
  };
  const now = current.task.repo;
  const updated = taskStore.patch(task.id, {
    usage,
    ...(now && headSha ? { repo: { ...now, headSha } } : {}),
    ...(stats ? { stats } : {}),
  });
  return snapshot(updated ?? current);
}

function fail(taskId: string, summary: string): void {
  taskStore.transition(taskId, "failed", { summary });
}

async function loop(taskId: string, first: SendMessageRequest | null): Promise<void> {
  let task = taskStore.get(taskId);
  if (!task || !taskStore.transition(taskId, "running")) return;

  if (task.task.repo) {
    // The first run clones the repo and adds the worktree, which can take a while: say so on the card.
    const setup = `Setting up ${task.task.repo.branch}…`;
    if (!task.task.repo.headSha) taskStore.patch(taskId, { progress: setup });
    try {
      const repo = await prepareTask(task);
      const current = taskStore.get(taskId);
      taskStore.patch(taskId, { repo, ...(current?.task.progress === setup ? { progress: null } : {}) });
    } catch (err) {
      fail(taskId, `Couldn't set up ${task.task.repo.source} on the computer: ${errorText(err)}`);
      return;
    }
  }

  let request = first;
  let stalls = 0;
  while (!shuttingDown) {
    task = taskStore.get(taskId);
    if (!task || task.task.status !== "running") return;
    if (!request && task.task.turns >= MAX_TURNS) {
      fail(taskId, `Stopped after ${MAX_TURNS} turns without finishing. Reply to keep it going.`);
      return;
    }
    const spent = overBudget(task);
    if (spent) {
      taskStore.transition(taskId, "paused", {
        progress: `Paused: this work used its token budget (${Math.round(spent.used / 1000)}k tokens). Raise it in Settings → Tasks, then resume.`,
      });
      return;
    }
    const before = snapshot(task);
    const turn = request ? { body: request, options: turnOptions(task) } : nextTurn(task);
    let runId: string;
    try {
      ({ runId } = await send(taskId, turn.body, turn.options));
    } catch (err) {
      // Someone (the user, a Slack follow-up) is already running a turn here: let it finish first.
      if (err instanceof HttpError && err.status === 409) {
        await waitForIdle(taskId);
        continue;
      }
      fail(taskId, `Couldn't continue: ${errorText(err)}`);
      return;
    }
    request = null;
    taskStore.patch(taskId, { turns: task.task.turns + 1 });

    const end = await runEnd(runId);
    // A steer that missed this turn lands in `notes` a moment after it ends.
    await tick();
    if (shuttingDown) return;
    task = taskStore.get(taskId);
    if (!task) return;
    const after = await recordTurn(task, end?.message);
    task = taskStore.get(taskId);
    // Finished (task_finish), asked the user something, or paused or stopped meanwhile.
    if (!task || task.task.status !== "running") return;

    const status: MessageStatus = end?.status ?? "error";
    if (status === "stopped" && !notes.has(taskId)) {
      // The turn itself was stopped (not through pause or stop): hold the task until the user resumes it.
      taskStore.transition(taskId, "paused");
      return;
    }
    if (status === "error") {
      // Its provider hit its usage limit: carry on with the other one, or wait for the reset.
      const provider = end?.message.provider;
      if (provider && onLimit && limits.active().has(provider)) {
        if ((await onLimit(taskId, provider)) === "paused") return;
        stalls = 0;
        continue;
      }
      stalls++;
      if (stalls >= MAX_STALLS) {
        const error = end?.message.error ?? "the turn ended unexpectedly.";
        // A provider that keeps failing would fail every queued task the same way: pause the agent's queue
        // until the user resumes it. Not for the task's own trouble (too many steps, too long for the model),
        // and never for a usage limit (failover switches or waits for the reset).
        const providerFault = end?.errorKind !== "turn" && end?.errorKind !== "limit";
        if (providerFault && !(provider && limits.active().has(provider))) {
          queueHolds.set(task.agentId, provider ?? null, error);
          appEvents.agentChanged(task.agentId);
        }
        fail(taskId, `Stopped after repeated errors: ${error}`);
        return;
      }
      continue;
    }
    stalls = madeProgress(before, after, end?.message) || notes.has(taskId) ? 0 : stalls + 1;
    if (stalls >= MAX_STALLS) {
      fail(taskId, `Stalled: no progress in the last ${MAX_STALLS} turns, and the task wasn't finished. Reply to nudge it, or look at what it did.`);
      return;
    }
    // Tasks it started work on their own; its next turn starts with their results.
    await waitForChildren(taskId);
  }
}

export const runLoop = {
  /**
   * Starts a task's loop (it becomes "running"); false when one is already running or the task
   * can't start. `first` is a message from the user to send as the first turn.
   */
  start(taskId: string, first: SendMessageRequest | null = null): boolean {
    const task = taskStore.get(taskId);
    if (!task || loops.has(taskId) || shuttingDown) return false;
    const done = loop(taskId, first)
      .catch((err) => {
        console.error(`[tot] task ${taskId} crashed:`, err);
        fail(taskId, `Something went wrong in TOT: ${errorText(err)}`);
      })
      .finally(() => {
        loops.delete(taskId);
        for (const listener of idleListeners) listener();
      });
    loops.set(taskId, { agentId: task.agentId, done });
    return true;
  },

  /** Starts one turn in a task, the way loops do (tests swap in a fake). */
  send(taskId: string, request: SendMessageRequest, options: TurnOptions): ReturnType<Sender> {
    return send(taskId, request, { maxSteps: STEP_LIMIT, ...options });
  },

  /** How a task's turns run: its tier, preferred provider and step cap. */
  turnOptions,

  isRunning(taskId: string): boolean {
    return loops.has(taskId);
  },

  /** Loops running now: all of them, or one agent's. */
  count(agentId?: string): number {
    if (!agentId) return loops.size;
    let n = 0;
    for (const entry of loops.values()) if (entry.agentId === agentId) n++;
    return n;
  },

  /** Resolves when the task's loop (if any) has ended. */
  async settled(taskId: string): Promise<void> {
    await loops.get(taskId)?.done;
  },

  /** A note for the task's next turn (a steer that couldn't reach the running one). */
  addNote(taskId: string, text: string): void {
    notes.set(taskId, [...(notes.get(taskId) ?? []), text]);
  },

  hasNotes(taskId: string): boolean {
    return notes.has(taskId);
  },

  markRestarted(taskId: string): void {
    restarted.add(taskId);
  },

  /** The task's next turn starts a fresh session from its handoff packet; `why` says what happened. */
  handOff(taskId: string, why: string): void {
    handOffs.set(taskId, why);
  },

  /** Set by failover: what to do when a task's provider hits its usage limit mid-run. */
  onLimit(handler: typeof onLimit): void {
    onLimit = handler;
  },

  /** Called whenever a loop ends, so the queue can start the next task. */
  onIdle(listener: () => void): () => void {
    idleListeners.add(listener);
    return () => idleListeners.delete(listener);
  },

  /** The server is stopping: runs get stopped, and loops must not take that as the user's doing. */
  shutdown(): void {
    shuttingDown = true;
  },

  /** Tests: start turns with a fake instead of the real models, and undo a simulated shutdown. */
  useSender(fake: Sender): void {
    send = fake;
  },
  reset(): void {
    shuttingDown = false;
  },
};
