import { setTimeout as sleep } from "node:timers/promises";
import type { LeadSignal, TaskStatus } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { runRegistry } from "../agent/runs.ts";
import { conversations, type ConversationRecord } from "../data/conversations.ts";
import { messageText } from "../data/messages.ts";
import { settings } from "../data/settings.ts";
import { signalsNote, signalsText } from "../signals/note.ts";
import { leadSignals, signalWakes } from "../signals/store.ts";
import { taskNotifications } from "./notify.ts";
import { LEAD_NEWS, markResultsRead, resultsNote } from "./prompt.ts";
import { runEnd, runLoop } from "./run-loop.ts";
import { taskStore, type TaskRecord } from "./store.ts";

/**
 * Wake-ups (module 05): a chat hears back when its tasks finish, instead of on the user's next
 * message. Results its model hasn't seen wait in the chat's `childResults`, and are marked read
 * by its next turn, by task_status, or by a wake:
 *  - steered into the chat's running turn, when the provider can take input mid-turn;
 *  - otherwise, once the turn ends (if it didn't read them itself), as one auto turn.
 * A wake never interrupts or restarts a turn. Results that come in together share one wake (they
 * wait a few seconds for each other), a chat has at most one wake at a time, and results that come
 * in during one get one follow-up. Groups spawned with then: "synthesize" are fan-in's job.
 *
 * Module 12: a project's Lead is woken the same way by its unread signals (pull requests, tickets, schedules,
 * server/lead/inbox.ts), in the same wake as any task results, and they're marked read when it hears them. At most
 * SIGNAL_WAKES_PER_HOUR of those per project in an hour: past that, they wait for the next one that fits (or the
 * Lead's next turn, which reads them too).
 */

/** How long a wake waits for more results, so tasks finishing together give one. */
const BATCH_MS = 3000;
/** Attempts to start the wake turn while someone else keeps starting turns in the chat. */
const BUSY_RETRIES = 90;

let batchMs = BATCH_MS;
let started = false;
/** Chat id → its wake, waiting for more results. */
const timers = new Map<string, NodeJS.Timeout>();
/** Chats with a wake under way, and those that got more results meanwhile. */
const busy = new Set<string>();
const followUps = new Set<string>();
/** Tasks a tool call is waiting on (wait.ts): their results go back in that call, not in a wake. */
const heldBack = new Map<string, number>();
/** Leads whose signals wait for the hourly bound (module 12): the wake that comes when the next one fits. */
const later = new Map<string, NodeJS.Timeout>();

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Whether a finished task's result wakes the chat that started it. Not a best-of run's (module 09): its chat gets one notice for the group. */
export function wakes(task: TaskRecord): boolean {
  if (!started || !settings.get().tasks.wakeChats || task.task.then === "synthesize" || task.task.groupKind === "best-of" || !task.parentId) return false;
  return conversations.get(task.parentId)?.kind === "chat";
}

/** The chat's unread results a wake covers: tasks that still exist, not in a group still to be combined (fan-in hands those over). */
function unread(chat: ConversationRecord): string[] {
  return chat.childResults.filter((id) => {
    const task = taskStore.get(id);
    return task !== null && task.task.then !== "synthesize" && !heldBack.has(id);
  });
}

/** A Lead's unread signals (module 12). */
function signalsOf(chat: ConversationRecord): LeadSignal[] {
  return chat.lead && chat.projectId ? leadSignals.unread(chat.projectId) : [];
}

/** The signals this wake covers: all of the Lead's unread ones, unless the project's hourly bound is used up. */
function dueSignals(chat: ConversationRecord): LeadSignal[] {
  const signals = signalsOf(chat);
  return signals.length && signalWakes.allowed(chat.projectId!) ? signals : [];
}

/** The note a wake gives the chat: its tasks' results, then (a Lead's) signals. */
function wakeNote(chat: ConversationRecord, ids: string[], signals: LeadSignal[]): string {
  return [resultsNote(ids, chat.lead ? LEAD_NEWS : undefined), signalsNote(signals)].filter(Boolean).join("\n\n");
}

/** The signals were heard: read, and one more wake for the project's hourly bound. */
function heard(chat: ConversationRecord, signals: LeadSignal[]): void {
  if (!signals.length) return;
  leadSignals.markRead(signals.map((signal) => signal.id));
  signalWakes.record(chat.projectId!);
}

/** How one task's news reads, other than "finished". (A project's Lead also hears when a task needs input, module 11.) */
const ENDINGS: Partial<Record<TaskStatus, string>> = { stopped: "was stopped", interrupted: "was cut off by a restart", "needs-input": "needs input" };

/**
 * The wake's own message, shown as a quiet divider: `2 tasks finished: “Fix checkout”, “Update docs”.` A Lead's
 * signals (module 12) follow: `Checks failed on draft PR #12 “Fix cart”.`
 */
export function wakeText(ids: string[], signals: Pick<LeadSignal, "title" | "kind">[] = []): string {
  return [ids.length ? tasksText(ids) : "", signalsText(signals)].filter(Boolean).join(" ");
}

function tasksText(ids: string[]): string {
  const ended = ids.map((id) => taskStore.get(id)).filter((task): task is TaskRecord => task !== null);
  const titles = ended.map((task) => `“${task.title}”`);
  if (ended.length === 1) {
    const { status } = ended[0]!.task;
    return `${titles[0]} ${ENDINGS[status] ?? "finished"}.`;
  }
  const allFinished = ended.every((task) => task.task.status === "done" || task.task.status === "failed");
  // A project's Lead also hears when tasks need input (module 11).
  const asking = ended.some((task) => task.task.status === "needs-input");
  return `${titles.length} tasks ${allFinished ? "finished" : asking ? "have news" : "ended"}: ${titles.join(", ")}.`;
}

/** The wake is over: no longer pending, unless results (or a Lead's signals) it didn't cover came in meanwhile. */
function settle(chatId: string, handled: string[] = [], handledSignals: string[] = []): void {
  const chat = conversations.get(chatId);
  const pending = chat ? unread(chat).some((id) => !handled.includes(id)) || signalsOf(chat).some((signal) => !handledSignals.includes(signal.id)) : false;
  conversations.update(chatId, { wakePending: pending });
  if (chat && pending) waitForBound(chat);
}

/** A Lead whose signals wait for the hourly bound gets its wake when the next one fits (module 12). */
function waitForBound(chat: ConversationRecord): void {
  if (!started || !chat.lead || !chat.projectId || later.has(chat.id) || !signalsOf(chat).length || signalWakes.allowed(chat.projectId)) return;
  const delay = Math.max(signalWakes.nextAt(chat.projectId) - Date.now(), 1000);
  later.set(
    chat.id,
    setTimeout(() => {
      later.delete(chat.id);
      schedule(chat.id);
    }, delay),
  );
}

/** Puts results back as unread (the wake turn couldn't start, or didn't get through). */
function restore(chatId: string, ids: string[]): void {
  const chat = conversations.get(chatId);
  if (chat) conversations.update(chatId, { childResults: [...new Set([...chat.childResults, ...ids])] });
}

/** Tasks a Slack or email thread has already been told about by a wake, so it isn't told twice. */
const told = new Set<string>();

/** A chat from Slack or email: the wake's answer goes to its thread (the tasks' own notices were held back for it). */
async function deliver(chat: ConversationRecord, ids: string[], answer: string): Promise<void> {
  if (!chat.origin) return;
  if (answer && (await taskNotifications.deliver(chat.id, answer))) {
    for (const id of ids) told.add(id);
    return;
  }
  // No answer to send: the thread hears about each task the way it would have without wake-ups, once.
  for (const id of ids) {
    const task = told.has(id) ? null : taskStore.get(id);
    if (!task) continue;
    told.add(id);
    await taskNotifications.tell(task);
  }
}

async function wake(chatId: string): Promise<void> {
  for (let attempt = 0; attempt < BUSY_RETRIES && started; attempt++) {
    const chat = conversations.get(chatId);
    const ids = chat ? unread(chat) : [];
    const signals = chat ? dueSignals(chat) : [];
    const signalIds = signals.map((signal) => signal.id);
    if (!chat || (!ids.length && !signals.length)) return settle(chatId);

    const run = runRegistry.activeFor(chatId);
    if (run) {
      // A turn is running: hand it the results mid-turn when the provider can take them. Not in a chat from
      // Slack or email: its thread needs a reply about them, so they wait for the turn to end instead.
      if (!chat.origin && run.steer && (await run.steer(wakeNote(chat, ids, signals)).catch(() => false))) {
        markResultsRead(chatId, ids);
        heard(chat, signals);
        return settle(chatId, ids, signalIds);
      }
      // …else wait for it to end (it may read them itself, or the user may reply first).
      await runEnd(run.id);
      continue;
    }

    // Read before the turn starts, so it doesn't get them a second time with the chat's unread results.
    const note = wakeNote(chat, ids, signals);
    markResultsRead(chatId, ids);
    leadSignals.markRead(signalIds);
    let runId: string;
    try {
      ({ runId } = await runLoop.send(chatId, { text: wakeText(ids, signals) }, { auto: true, keepTitle: true, preamble: note, signalIds }));
      if (signals.length) signalWakes.record(chat.projectId!);
    } catch (err) {
      restore(chatId, ids);
      leadSignals.markUnread(signalIds);
      // Someone started a turn there just now: wait for it.
      if (err instanceof HttpError && err.status === 409) {
        await sleep(500);
        continue;
      }
      // The turn can't start (e.g. the chat's model isn't connected): the results wait for the user's next message.
      settle(chatId, ids, signalIds);
      await deliver(chat, ids, "");
      throw err;
    }
    const end = await runEnd(runId);
    const tokens = (end?.message.usage?.inputTokens ?? 0) + (end?.message.usage?.outputTokens ?? 0);
    if (tokens) conversations.update(chatId, { wakeTokens: (conversations.get(chatId)?.wakeTokens ?? 0) + tokens });
    if (end?.status !== "complete") {
      // The turn didn't get through (an error, a stop, TOT stopping): its results stay unread for the chat's next turn.
      restore(chatId, ids);
      leadSignals.markUnread(signalIds);
      // Cut off by a shutdown: the wake is still pending, so it happens again after the restart.
      if (!started) return;
      settle(chatId, ids, signalIds);
      return deliver(chat, ids, "");
    }
    settle(chatId, ids, signalIds);
    return deliver(chat, ids, messageText(end.message));
  }
  // Gave up waiting for the chat to be free: what's unread waits for its next turn. (TOT stopping: after the restart.)
  if (!started) return;
  const chat = conversations.get(chatId);
  if (!chat) return;
  const ids = unread(chat);
  settle(chatId, ids, signalsOf(chat).map((signal) => signal.id));
  await deliver(chat, ids, "");
}

function schedule(chatId: string, delay = batchMs): void {
  if (!started) return;
  if (busy.has(chatId)) {
    followUps.add(chatId);
    return;
  }
  clearTimeout(timers.get(chatId));
  timers.set(
    chatId,
    setTimeout(() => {
      timers.delete(chatId);
      busy.add(chatId);
      void wake(chatId)
        .catch((err) => console.warn(`[tot] couldn't tell chat ${chatId} about its tasks:`, errorText(err)))
        .finally(() => {
          busy.delete(chatId);
          if (followUps.delete(chatId)) schedule(chatId);
        });
    }, delay),
  );
}

export const chatWakes = {
  /** A task's result was added to its chat's unread results (tasks.ts reportToParent): wake the chat. */
  flag(task: TaskRecord): void {
    if (!wakes(task)) return;
    conversations.update(task.parentId!, { wakePending: true });
    schedule(task.parentId!);
  },

  /**
   * Module 11: news for a chat about a task it didn't start (a project's Lead hears about every task in its
   * project, server/lead/wake.ts), already added to its unread results: wake it the same way, batched.
   */
  flagChat(chatId: string): void {
    if (!started || !settings.get().tasks.wakeChats) return;
    conversations.update(chatId, { wakePending: true });
    schedule(chatId);
  },

  /**
   * Module 12: a project's Lead has a new signal (server/lead/inbox.ts): wake it, batched like results. Signals
   * wake it whatever "Tell the chat when its tasks finish" says: a project's subscriptions decide what it hears.
   */
  flagSignals(leadId: string): void {
    conversations.update(leadId, { wakePending: true });
    schedule(leadId);
  },

  /** Starts waking chats, first those whose wake was pending when TOT stopped. */
  start(): void {
    if (started) return;
    started = true;
    for (const chat of conversations.wakePending()) schedule(chat.id);
  },

  /** TOT is stopping: no new wake turns; pending ones happen after the restart. */
  stop(): void {
    started = false;
    for (const timer of [...timers.values(), ...later.values()]) clearTimeout(timer);
    timers.clear();
    later.clear();
    followUps.clear();
  },

  /** A tool call waits on these tasks (wait.ts): wakes leave their results to it until `release`. */
  holdBack(ids: string[]): void {
    for (const id of ids) heldBack.set(id, (heldBack.get(id) ?? 0) + 1);
  },

  release(ids: string[]): void {
    for (const id of ids) {
      const left = (heldBack.get(id) ?? 1) - 1;
      if (left > 0) heldBack.set(id, left);
      else heldBack.delete(id);
    }
  },

  /** Tests: a shorter wait for results to batch up. */
  useBatchDelay(ms: number): void {
    batchMs = ms;
  },
};
