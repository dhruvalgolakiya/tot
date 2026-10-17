import { randomUUID } from "node:crypto";
import type { MessageStatus, QueuedMessage, SendMessageRequest, SendNowResult } from "@tot/shared/types";
import { runsWaiting } from "../agent/approvals.ts";
import { HttpError, sendMessage } from "../agent/orchestrator.ts";
import { runRegistry, steerNote, type Run } from "../agent/runs.ts";
import { appEvents } from "../app-events.ts";
import { parseJson, statement, type Row } from "../db.ts";
import { conversations, toPublicConversation } from "../data/conversations.ts";
import { messages } from "../data/messages.ts";

/**
 * A chat's queue: what the user sends while a turn runs waits here and goes out, in order, once the turn ends with its
 * reply complete. A turn the user stopped, or one that failed, holds the queue until they send one on (so a stop isn't
 * followed by more work they didn't see coming). "Send now" hands a message to the running turn when the provider can
 * take input mid-turn (the same way a task is steered), and otherwise stops the turn at its next step and sends it right
 * after. Never while the turn waits on the user's approval: they answer that first. Tasks are steered instead.
 */

const MAX_QUEUED = 20;
/** Longer notes go as their own turn, as steering a task allows. */
const MAX_STEER = 4000;

/** Notes handed to a turn that couldn't take them (the turn ended first): they go as one turn of their own, before the queue. */
const unheard = new Map<string, string[]>();

function toItem(row: Row): QueuedMessage {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    request: parseJson<SendMessageRequest>(row.request, { text: "" }),
    createdAt: Number(row.created_at),
  };
}

function rows(conversationId: string): QueuedMessage[] {
  return (statement(`SELECT * FROM chat_queue WHERE conversation_id = ? ORDER BY position, created_at`).all(conversationId) as Row[]).map(toItem);
}

function publish(conversationId: string): void {
  appEvents.publish({ type: "queue", conversationId, queue: rows(conversationId) });
}

function insert(item: QueuedMessage, position: number): void {
  statement(`INSERT INTO chat_queue (id, conversation_id, request, position, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    item.id,
    item.conversationId,
    JSON.stringify(item.request),
    position,
    item.createdAt,
  );
}

/** Takes the item out of the queue; false when another call already did (so it's sent once). */
function claim(itemId: string): boolean {
  return Number(statement(`DELETE FROM chat_queue WHERE id = ?`).run(itemId).changes) > 0;
}

function frontPosition(conversationId: string): number {
  const row = statement(`SELECT MIN(position) AS low FROM chat_queue WHERE conversation_id = ?`).get(conversationId) as Row | undefined;
  return row?.low === null || row?.low === undefined ? 0 : Number(row.low) - 1;
}

function requireChat(conversationId: string) {
  const chat = conversations.get(conversationId);
  if (!chat) throw new HttpError(404, "Chat not found.");
  if (chat.kind === "task") throw new HttpError(400, "A task takes notes while it works instead (POST /api/conversations/:id/steer).");
  return chat;
}

function requireItem(conversationId: string, itemId: string): QueuedMessage {
  const item = rows(conversationId).find((entry) => entry.id === itemId);
  if (!item) throw new HttpError(404, "That message isn't queued any more.");
  return item;
}

/** What's worth keeping of a request: the same fields sendMessage takes, checked for shape here and for content when it goes. */
function cleanRequest(request: Partial<SendMessageRequest> | null | undefined): SendMessageRequest {
  if (!request || typeof request !== "object") throw new HttpError(400, "Expected a message.");
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
  const text = typeof request.text === "string" ? request.text.trim() : "";
  const attachments = strings(request.attachments);
  const contextChats = strings(request.contextChats);
  const skill = typeof request.skill === "string" ? request.skill.trim() : "";
  const files = strings(request.files);
  if (!text && !attachments.length && !skill) throw new HttpError(400, "Message is empty.");
  return {
    text,
    ...(attachments.length ? { attachments } : {}),
    ...(typeof request.modelId === "string" && request.modelId ? { modelId: request.modelId } : {}),
    ...(request.thinkHarder ? { thinkHarder: true } : {}),
    ...(contextChats.length ? { contextChats } : {}),
    ...(skill ? { skill } : {}),
    ...(files.length ? { files } : {}),
  };
}

/** A message the running turn can take as it is: words only, nothing that changes how the turn runs. */
function steerable(request: SendMessageRequest): boolean {
  return (
    Boolean(request.text) &&
    request.text.length <= MAX_STEER &&
    !request.attachments?.length &&
    !request.contextChats?.length &&
    !request.skill &&
    !request.files?.length &&
    !request.thinkHarder
  );
}

/** Sends the item as the chat's next turn; on failure it goes back to the front, held until the next turn ends or "send now". */
async function send(item: QueuedMessage): Promise<string | null> {
  if (!claim(item.id)) return null;
  publish(item.conversationId);
  try {
    const { runId } = await sendMessage(item.conversationId, item.request);
    return runId;
  } catch (err) {
    if (conversations.get(item.conversationId)) {
      insert(item, frontPosition(item.conversationId));
      publish(item.conversationId);
    }
    throw err;
  }
}

/** The notes a turn couldn't take, as one turn of TOT's own (shown as a quiet divider), with the notes for the model. */
async function sendUnheard(conversationId: string): Promise<boolean> {
  const notes = unheard.get(conversationId);
  if (!notes?.length) return false;
  unheard.delete(conversationId);
  try {
    await sendMessage(
      conversationId,
      { text: "Carry on with the note above." },
      { auto: true, preamble: `[While you were working, the user added:\n${notes.join("\n\n")}]` },
    );
    return true;
  } catch (err) {
    console.warn(`[tot] couldn't send chat ${conversationId} its notes:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** The next turn, when nothing runs: the notes a turn missed first, then the front of the queue. */
async function drain(conversationId: string): Promise<void> {
  if (runRegistry.activeFor(conversationId)) return;
  if (await sendUnheard(conversationId)) return;
  const next = rows(conversationId)[0];
  if (!next) return;
  await send(next).catch((err) => console.warn(`[tot] queued message for chat ${conversationId} didn't go:`, err instanceof Error ? err.message : err));
}

/** Hands a note to the running turn; if it can't take it, the turn stops at its next step and the note goes right after. */
async function deliver(run: Run, text: string): Promise<void> {
  const delivered = run.steer ? await run.steer(text).catch(() => false) : false;
  if (delivered) return;
  unheard.set(run.conversationId, [...(unheard.get(run.conversationId) ?? []), text]);
  if (!run.done) run.stopAfterStep();
  // The turn ended before the note could reach it, and its end already looked at the queue.
  else void drain(run.conversationId);
}

export const chatQueue = {
  list(conversationId: string): QueuedMessage[] {
    requireChat(conversationId);
    return rows(conversationId);
  },

  /** Queues a message; with no turn running it goes at once (the turn may have ended while it was on its way). */
  add(conversationId: string, request: Partial<SendMessageRequest>): QueuedMessage {
    requireChat(conversationId);
    if (rows(conversationId).length >= MAX_QUEUED) throw new HttpError(409, `Up to ${MAX_QUEUED} messages can wait at once.`);
    const now = Date.now();
    const item: QueuedMessage = { id: randomUUID(), conversationId, request: cleanRequest(request), createdAt: now };
    insert(item, now);
    publish(conversationId);
    if (!runRegistry.activeFor(conversationId)) void drain(conversationId);
    return item;
  },

  remove(conversationId: string, itemId: string): void {
    requireChat(conversationId);
    if (claim(itemId)) publish(conversationId);
  },

  /** "Send now": into the running turn, or right after it (stopping it at its next step), or at once when nothing runs. */
  async sendNow(conversationId: string, itemId: string): Promise<SendNowResult> {
    requireChat(conversationId);
    const item = requireItem(conversationId, itemId);
    const run = runRegistry.activeFor(conversationId);
    if (!run) {
      const runId = await send(item);
      if (!runId) throw new HttpError(409, "That message is already on its way.");
      return { outcome: "sent", runId };
    }
    if (runsWaiting().has(run.id)) throw new HttpError(409, "Answer the request in the reply first.");
    if (steerable(item.request) && run.steer) {
      if (!claim(item.id)) throw new HttpError(409, "That message is already on its way.");
      const message = steerNote(conversationId, item.request.text, run);
      messages.insert(message);
      const touched = conversations.update(conversationId, {}, true);
      if (touched) appEvents.publish({ type: "conversation", conversation: toPublicConversation(touched) });
      publish(conversationId);
      void deliver(run, item.request.text);
      return { outcome: "steered", message };
    }
    // The turn can't take it as it runs: it goes first, once the turn stops at its next step.
    statement(`UPDATE chat_queue SET position = ? WHERE id = ?`).run(frontPosition(conversationId), item.id);
    publish(conversationId);
    run.stopAfterStep();
    return { outcome: "interrupting" };
  },

  /** A chat's turn ended: its next queued message goes when the reply completed (a turn stopped to take a note counts). */
  afterTurn(conversationId: string, status: MessageStatus): void {
    if (conversations.get(conversationId)?.kind !== "chat") return;
    if (status !== "complete") {
      unheard.delete(conversationId);
      return;
    }
    // After this turn's end has gone out to its listeners.
    setImmediate(() => void drain(conversationId));
  },
};
