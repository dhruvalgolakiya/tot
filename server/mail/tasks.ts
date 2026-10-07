import type { Agent, Persona, RunEvent } from "../../shared/types.ts";
import { HttpError, sendMessage } from "../agent/orchestrator.ts";
import { runRegistry } from "../agent/runs.ts";
import { appEvents } from "../app-events.ts";
import { agents } from "../data/agents.ts";
import { conversations, toPublicConversation } from "../data/conversations.ts";
import { mail, type StoredMail } from "../data/mail.ts";
import { messageText } from "../data/messages.ts";
import { personas } from "../data/personas.ts";
import { db, type Row } from "../db.ts";
import { intake } from "../projects/intake.ts";
import { pickAgent } from "../slack.ts";
import { isTask as isTaskConversation } from "../tasks/store.ts";
import { tasks } from "../tasks/tasks.ts";
import { mailboxes } from "./mailbox.ts";
import { stripQuoted } from "./parse.ts";

/**
 * Emailed tasks. A new email to a persona's mailbox becomes a turn in a TOT chat tied to its
 * email thread when it's from an allowed sender, provably so (the receiving provider's DKIM or
 * DMARC check, since a From header is trivial to forge), and written by a person (not an
 * auto-reply or bulk mail). The thread so far is passed as context, and the agent's answer goes
 * back as a reply from the persona in the same thread. Everything else is only stored.
 */

interface Thread {
  personaId: string;
  threadId: string;
  conversationId: string;
  sender: string;
  seenAt: number;
}

const CONTEXT_CHARS = 20_000;
/** Mail that was already this old when TOT first saw it (e.g. TOT was off for days) is only stored. */
const FRESH_MS = 24 * 60 * 60_000;

/** How a turn is started; tests swap in a fake. */
let send = sendMessage;
let unsubscribe: (() => void) | null = null;
const queues = new Map<string, Promise<void>>();

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Whether a new email is a task for the persona's agents. */
export function isTask(persona: Persona, email: StoredMail): boolean {
  return (
    email.folder === "inbox" &&
    !email.outgoing &&
    email.from.address !== persona.email &&
    persona.allowedSenders.includes(email.from.address) &&
    email.authenticated &&
    !email.automated &&
    Date.now() - email.date < FRESH_MS
  );
}

function getThread(personaId: string, threadId: string): Thread | null {
  const row = db.prepare(`SELECT * FROM mail_threads WHERE persona_id = ? AND thread_id = ?`).get(personaId, threadId) as Row | undefined;
  if (!row) return null;
  // The chat may have been deleted in TOT; then the thread starts a new one.
  if (!conversations.get(String(row.conversation_id))) {
    db.prepare(`DELETE FROM mail_threads WHERE persona_id = ? AND thread_id = ?`).run(personaId, threadId);
    return null;
  }
  return { personaId, threadId, conversationId: String(row.conversation_id), sender: String(row.sender), seenAt: Number(row.seen_at) };
}

function markSeen(thread: Thread, date: number): void {
  if (date > thread.seenAt) {
    db.prepare(`UPDATE mail_threads SET seen_at = ? WHERE persona_id = ? AND thread_id = ?`).run(date, thread.personaId, thread.threadId);
  }
}

/** Emails as "Name: text" (their own words, no quoted history), oldest first, within a budget (newest kept). */
function transcript(emails: StoredMail[]): string {
  let text = emails.map((e) => `${e.from.name || e.from.address}${e.outgoing ? " (you)" : ""}: ${stripQuoted(e.text)}`).join("\n\n");
  if (text.length > CONTEXT_CHARS) text = `…\n${text.slice(-CONTEXT_CHARS)}`;
  return text;
}

/** "Puddin: …" in the subject picks that agent; else the persona's default agent, else the first agent working as it. */
function chooseAgent(persona: Persona, subject: string): ReturnType<typeof pickAgent> {
  const pool: Agent[] = agents.list().filter((agent) => agent.personaId === persona.id);
  const fallback = persona.defaultAgentId ? agents.get(persona.defaultAgentId) : null;
  if (fallback && !pool.some((agent) => agent.id === fallback.id)) pool.push(fallback);
  return pickAgent(subject, pool.length ? pool : agents.list(), persona.defaultAgentId);
}

function follow(runId: string): Promise<Extract<RunEvent, { type: "run-end" }> | null> {
  const run = runRegistry.get(runId);
  if (!run) return Promise.resolve(null);
  return new Promise((resolve) => {
    run.subscribe((_seq, event) => {
      if (event.type === "run-end") resolve(event);
    });
  });
}

/** One emailed task, start to finish: ties the thread to a chat, runs the agent, replies by email. */
async function handle(personaId: string, mailId: string): Promise<void> {
  const persona = personas.get(personaId);
  const email = persona ? mail.get(personaId, mailId) : null;
  if (!persona || !email) return;
  const sender = `${email.from.name ? `${email.from.name} ` : ""}<${email.from.address}>`;
  const subject = email.subject.replace(/^((re|fwd?|aw|sv)\s*:\s*)+/i, "").trim();
  let request = stripQuoted(email.text);
  let thread = getThread(personaId, email.threadId);
  let context = "";
  if (!thread) {
    // Module 12: work for a project with a Lead goes to the Lead as a ticket, not a chat of its own.
    const earlier = mail.thread(personaId, email.threadId).filter((e) => e.id !== email.id && e.date <= email.date);
    const led = intake.toLead({
      text: `${email.subject}\n${request}${earlier.length ? `\n\nThe email thread so far:\n${transcript(earlier)}` : ""}`,
      who: sender,
      where: `by email to ${persona.email}`,
      key: `email:${personaId}:${email.id}`,
    });
    if (led) {
      await mailboxes.reply(personaId, email, `Thanks, I've passed this on to ${led.name}'s Lead in TOT.`);
      return;
    }
    const picked = chooseAgent(persona, subject);
    const origin = { kind: "email" as const, label: `Email from ${email.from.name || email.from.address}`, url: null };
    const conversation = conversations.create({
      agentId: picked.agent.id,
      modelId: picked.agent.modelId,
      title: (picked.text || subject).slice(0, 120) || "Emailed task",
      origin,
    });
    appEvents.publish({ type: "conversation", conversation: toPublicConversation(conversation) });
    appEvents.agentChanged(picked.agent.id);
    db.prepare(`INSERT INTO mail_threads (persona_id, thread_id, conversation_id, sender, seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      personaId,
      email.threadId,
      conversation.id,
      email.from.address,
      0,
      Date.now(),
    );
    thread = getThread(personaId, email.threadId)!;
    // The thread had earlier mail before it reached TOT: the agent gets it as context.
    if (earlier.length) context = `The email thread so far:\n<email_thread>\n${transcript(earlier)}\n</email_thread>\n`;
    // Its project, when a ticket in the email is one project's intake (module 06).
    intake.fileNew(conversation.id, { text: `${email.subject}\n${request}\n${context}` });
  } else {
    const since = thread.seenAt;
    const fresh = mail.thread(personaId, email.threadId).filter((e) => e.id !== email.id && !e.outgoing && e.date > since && e.date <= email.date);
    if (fresh.length) context = `New in the email thread since your last reply:\n<email_thread>\n${transcript(fresh)}\n</email_thread>\n`;
  }
  markSeen(thread, email.date);
  mail.setConversation(email.id, thread.conversationId);
  if (!request) request = subject || "(empty email)";

  // A reply in a task's thread: a note for it while it runs, else it picks the task up again.
  const existing = conversations.get(thread.conversationId);
  if (isTaskConversation(existing)) {
    const result = await tasks.message(existing.id, { text: context ? `${request}\n\n${context}` : request });
    if (!("steered" in result)) await mailboxes.reply(personaId, email, "Picked the task up again. I'll reply here with the result.");
    return;
  }

  const files = email.attachments.length ? ` It came with attachments TOT doesn't pass on yet: ${email.attachments.map((a) => a.name).join(", ")}.` : "";
  const preamble = `[This message came by email to your mailbox (${persona.email}) from ${sender}, an allowed sender whose address was verified. Subject: “${email.subject}”.${files} ${context}Your reply is emailed back to them in the same thread as plain text, so write it as an email body.]`;

  let started: { runId: string } | null = null;
  for (let attempt = 0; attempt < 30 && !started; attempt++) {
    try {
      started = await send(thread.conversationId, { text: request }, { preamble, keepTitle: true });
    } catch (err) {
      // The chat is busy (e.g. someone is also using it in TOT): wait for it to finish.
      if (!(err instanceof HttpError && err.status === 409)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  if (!started) throw new Error("The chat stayed busy; try again in a moment.");

  const end = await follow(started.runId);
  const text = end ? messageText(end.message) : "";
  let body: string;
  if (!end || end.status === "error") body = `Sorry, that didn't work: ${end?.message.error ?? "the run ended unexpectedly."}`;
  else if (end.status === "stopped") body = text || "The task was stopped in TOT before I finished.";
  else body = text || "(Done; nothing to add.)";
  // No approval needed: this answers the allowed sender who asked, in their own thread.
  await mailboxes.reply(personaId, email, body);
}

function enqueue(persona: Persona, email: StoredMail): void {
  const key = `${persona.id}:${email.threadId}`;
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous
    .then(() => handle(persona.id, email.id))
    .catch(async (err) => {
      console.warn("[tot] emailed task failed:", errorText(err));
      await mailboxes.reply(persona.id, email, `Sorry, something went wrong: ${errorText(err)}`).catch(() => {});
    })
    .finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  queues.set(key, next);
}

export const emailTasks = {
  /** Replies in the email thread a conversation belongs to (e.g. a task's result); false when it has none. */
  async replyInThread(conversationId: string, text: string): Promise<boolean> {
    const row = db.prepare(`SELECT persona_id, thread_id FROM mail_threads WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1`).get(conversationId) as
      | Row
      | undefined;
    if (!row) return false;
    const personaId = String(row.persona_id);
    const persona = personas.get(personaId);
    const latest = mail.thread(personaId, String(row.thread_id)).findLast((e) => !e.outgoing && e.from.address !== persona?.email);
    if (!latest) return false;
    await mailboxes.reply(personaId, latest, text);
    return true;
  },

  /** Starts turning qualifying new mail into tasks. */
  start(): void {
    unsubscribe ??= mailboxes.onIncoming((snapshot, email) => {
      const persona = personas.get(snapshot.id);
      if (persona && isTask(persona, email)) enqueue(persona, email);
    });
  },

  stop(): void {
    unsubscribe?.();
    unsubscribe = null;
  },

  /** Tests: start turns with a fake instead of the real models. */
  useSender(fake: typeof sendMessage): void {
    send = fake;
  },
};
