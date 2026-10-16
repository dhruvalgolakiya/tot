import { conversations } from "../data/conversations.ts";
import { settings } from "../data/settings.ts";
import { emailTasks } from "../mail/tasks.ts";
import { slack } from "../slack.ts";
import { taskStore, type TaskRecord } from "./store.ts";
import { wakes } from "./wake.ts";

/**
 * Telling people when a task finishes or needs them. Every tab gets the "task" app event (the
 * UI shows a toast and, if allowed, a browser notification). Beyond TOT: a task started from
 * Slack or email (or from a chat that was) gets a reply in that thread; otherwise, when
 * Settings → Tasks names someone, they get a Slack DM.
 */

export interface TaskNotifiers {
  /** Posts in the Slack thread tied to the conversation; false when there's none. */
  slackThread(conversationId: string, markdown: string): Promise<boolean>;
  /** Replies in the email thread tied to the conversation; false when there's none. */
  emailThread(conversationId: string, text: string): Promise<boolean>;
  slackDm(userId: string, markdown: string): Promise<boolean>;
}

const real: TaskNotifiers = {
  slackThread: (conversationId, markdown) => slack.postToThread(conversationId, markdown),
  emailThread: (conversationId, text) => emailTasks.replyInThread(conversationId, text),
  slackDm: (userId, markdown) => slack.dm(userId, markdown),
};
let notifiers = real;
let unsubscribe: (() => void) | null = null;

function words(task: TaskRecord): { headline: string; body: string } {
  const { status, summary, question } = task.task;
  if (status === "needs-input") {
    return { headline: `“${task.title}” needs your input`, body: question ?? "It's waiting for your OK on an action in TOT." };
  }
  if (status === "stopped") return { headline: `“${task.title}” was stopped`, body: summary ?? "" };
  if (status === "interrupted") {
    return { headline: `“${task.title}” was cut off when TOT restarted`, body: "It's waiting for you to resume it in TOT." };
  }
  return { headline: `“${task.title}” ${status === "done" ? "is done" : "failed"}`, body: summary ?? "" };
}

async function notify(task: TaskRecord): Promise<void> {
  if (task.task.status !== "needs-input") {
    // Tasks whose results get combined into one answer don't each post their own (the combined answer goes out instead).
    if (task.task.then === "synthesize") return;
    // Nor do those of a chat from Slack or email that gets woken about them: its reply goes to the thread instead (wake.ts).
    if (wakes(task) && conversations.get(task.parentId!)?.origin) return;
  }
  await tell(task);
}

async function tell(task: TaskRecord): Promise<void> {
  const { headline, body } = words(task);
  const markdown = `*${headline}*${body ? `\n\n${body}` : ""}`;
  const text = `${headline}.${body ? `\n\n${body}` : ""}`;
  // The thread the request came from: the task's own, else the chat's that started it.
  for (const id of [task.id, task.parentId].filter((id): id is string => Boolean(id && conversations.get(id)))) {
    if (await notifiers.slackThread(id, markdown)) return;
    if (await notifiers.emailThread(id, text)) return;
  }
  const userId = settings.get().tasks.notifySlackUserId;
  if (userId) await notifiers.slackDm(userId, markdown);
}

export const taskNotifications = {
  start(): void {
    unsubscribe ??= taskStore.onChange((task) => {
      if (task.task.status !== "done" && task.task.status !== "failed" && task.task.status !== "needs-input") return;
      void notify(task).catch((err) => console.warn(`[tot] couldn't send the notice for task ${task.id}:`, err instanceof Error ? err.message : err));
    });
  },

  stop(): void {
    unsubscribe?.();
    unsubscribe = null;
  },

  /** Sends a reply TOT wrote on its own (a combined answer, a wake-up's reply) to the Slack or email thread the chat came from, if any. */
  async deliver(conversationId: string, markdown: string): Promise<boolean> {
    return (await notifiers.slackThread(conversationId, markdown)) || (await notifiers.emailThread(conversationId, markdown));
  },

  /** The task's own "done" / "failed" notice, for a wake-up that ended without a reply to send. */
  tell,

  /** Tests: fake Slack and email. */
  use(fake: TaskNotifiers): void {
    notifiers = fake;
  },
};
