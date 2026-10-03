import { setTimeout as sleep } from "node:timers/promises";
import { HttpError } from "../agent/orchestrator.ts";
import { runRegistry } from "../agent/runs.ts";
import { conversations, type ConversationRecord } from "../data/conversations.ts";
import { messageText } from "../data/messages.ts";
import { settings } from "../data/settings.ts";
import { overBudget } from "../orchestration/budget.ts";
import { taskNotifications } from "./notify.ts";
import { markResultsRead, resultsNote } from "./prompt.ts";
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

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Whether a finished task's result wakes the chat that started it. */
export function wakes(task: TaskRecord): boolean {
  if (!started || !settings.get().tasks.wakeChats || task.task.then === "synthesize" || !task.parentId) return false;
  return conversations.get(task.parentId)?.kind === "chat";
}

/** The chat's unread results a wake covers: tasks that still exist, not in a group still to be combined (fan-in hands those over). */
function unread(chat: ConversationRecord): string[] {
  return chat.childResults.filter((id) => {
    const task = taskStore.get(id);
    return task !== null && task.task.then !== "synthesize" && !heldBack.has(id);
  });
}

/** The wake's own message, shown as a quiet divider: `2 tasks finished: “Fix checkout”, “Update docs”.` */
export function wakeText(ids: string[]): string {
  const ended = ids.map((id) => taskStore.get(id)).filter((task): task is TaskRecord => task !== null);
  const titles = ended.map((task) => `“${task.title}”`);
  if (ended.length === 1) {
    const { status } = ended[0]!.task;
    return `${titles[0]} ${status === "stopped" ? "was stopped" : status === "interrupted" ? "was cut off by a restart" : "finished"}.`;
  }
  const allFinished = ended.every((task) => task.task.status === "done" || task.task.status === "failed");
  return `${titles.length} tasks ${allFinished ? "finished" : "ended"}: ${titles.join(", ")}.`;
}

/** The wake is over: no longer pending, unless results it didn't cover came in meanwhile. */
function settle(chatId: string, handled: string[] = []): void {
  const chat = conversations.get(chatId);
  conversations.update(chatId, { wakePending: chat ? unread(chat).some((id) => !handled.includes(id)) : false });
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
    if (!chat || !ids.length) return settle(chatId);

    const run = runRegistry.activeFor(chatId);
    if (run) {
      // A turn is running: hand it the results mid-turn when the provider can take them. Not in a chat from
      // Slack or email: its thread needs a reply about them, so they wait for the turn to end instead.
      if (!chat.origin && run.steer && (await run.steer(resultsNote(ids)).catch(() => false))) {
        markResultsRead(chatId, ids);
        return settle(chatId, ids);
      }
      // …else wait for it to end (it may read them itself, or the user may reply first).
      await runEnd(run.id);
      continue;
    }

    if (overBudget(chat)) {
      // No turn past the budget: the results wait for the user's next message.
      settle(chatId, ids);
      return deliver(chat, ids, "");
    }

    // Read before the turn starts, so it doesn't get them a second time with the chat's unread results.
    const note = resultsNote(ids);
    markResultsRead(chatId, ids);
    let runId: string;
    try {
      ({ runId } = await runLoop.send(chatId, { text: wakeText(ids) }, { auto: true, keepTitle: true, preamble: note }));
    } catch (err) {
      restore(chatId, ids);
      // Someone started a turn there just now: wait for it.
      if (err instanceof HttpError && err.status === 409) {
        await sleep(500);
        continue;
      }
      // The turn can't start (e.g. the chat's model isn't connected): the results wait for the user's next message.
      settle(chatId, ids);
      await deliver(chat, ids, "");
      throw err;
    }
    const end = await runEnd(runId);
    const tokens = (end?.message.usage?.inputTokens ?? 0) + (end?.message.usage?.outputTokens ?? 0);
    if (tokens) conversations.update(chatId, { wakeTokens: (conversations.get(chatId)?.wakeTokens ?? 0) + tokens });
    if (end?.status !== "complete") {
      // The turn didn't get through (an error, a stop, TOT stopping): its results stay unread for the chat's next turn.
      restore(chatId, ids);
      // Cut off by a shutdown: the wake is still pending, so it happens again after the restart.
      if (!started) return;
      settle(chatId, ids);
      return deliver(chat, ids, "");
    }
    settle(chatId, ids);
    return deliver(chat, ids, messageText(end.message));
  }
  // Gave up waiting for the chat to be free: what's unread waits for its next turn. (TOT stopping: after the restart.)
  if (!started) return;
  const chat = conversations.get(chatId);
  if (!chat) return;
  const ids = unread(chat);
  settle(chatId, ids);
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

  /** Starts waking chats, first those whose wake was pending when TOT stopped. */
  start(): void {
    if (started) return;
    started = true;
    for (const chat of conversations.wakePending()) schedule(chat.id);
  },

  /** TOT is stopping: no new wake turns; pending ones happen after the restart. */
  stop(): void {
    started = false;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
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
