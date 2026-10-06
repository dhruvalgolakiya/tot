import { randomUUID } from "node:crypto";
import type { MessagePart } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { runRegistry } from "../agent/runs.ts";
import { appEvents } from "../app-events.ts";
import { conversations, toPublicConversation } from "../data/conversations.ts";
import { messages } from "../data/messages.ts";
import { db, type Row } from "../db.ts";
import { landing } from "../landing/land.ts";
import { taskStore } from "../tasks/store.ts";

/**
 * A project Lead's land and discard requests (roadmap module 11). The card sits in the Lead's reply and waits
 * for the user as long as it takes (days, not the minute an MCP tool call can wait on an approval): the tool
 * posts it and returns, and the user's answer comes here. On yes TOT lands (or discards) exactly the commit the
 * card showed, and says what happened in the Lead's chat; on no, nothing happens. A card is answered once.
 */

type ApprovalPart = Extract<MessagePart, { type: "approval" }>;
export type LeadAction = "land" | "discard";

/** How long a request stays open. */
const OPEN_MS = 7 * 24 * 60 * 60_000;

export interface LeadAsk {
  id: string;
  conversationId: string;
  messageId: string;
  taskId: string;
  action: LeadAction;
  method: "merge" | "pr" | null;
  headSha: string | null;
  createdAt: number;
  expiresAt: number;
  answeredAt: number | null;
  decision: "accept" | "decline" | "expired" | null;
}

function toAsk(row: Row): LeadAsk {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    messageId: String(row.message_id),
    taskId: String(row.task_id),
    action: row.action === "discard" ? "discard" : "land",
    method: row.method === "merge" || row.method === "pr" ? row.method : null,
    headSha: (row.head_sha as string | null) ?? null,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    answeredAt: row.answered_at === null ? null : Number(row.answered_at),
    decision: row.decision === "accept" || row.decision === "decline" || row.decision === "expired" ? row.decision : null,
  };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Sets the card's status where it lives: in the reply still being written, or in the saved message. */
function setStatus(ask: LeadAsk, status: ApprovalPart["status"]): void {
  const run = runRegistry.activeFor(ask.conversationId);
  if (run && run.messageId === ask.messageId && run.reply && run.replacePart) {
    const part = run.reply().parts.find((p) => p.id === ask.id);
    if (part?.type === "approval") run.replacePart({ ...part, status });
  } else {
    const message = messages.get(ask.messageId);
    if (message) messages.save({ ...message, parts: message.parts.map((p) => (p.id === ask.id && p.type === "approval" ? { ...p, status } : p)) });
  }
  const chat = conversations.get(ask.conversationId);
  if (chat) appEvents.publish({ type: "approval", agentId: chat.agentId, conversationId: chat.id, runId: run?.id ?? "", partId: ask.id, message: "", pending: false });
}

/** What happened, as a note in the Lead's chat (the user sees it, and so does the Lead on its next turn). */
function note(conversationId: string, text: string, ok: boolean): void {
  messages.insert({
    id: randomUUID(),
    conversationId,
    role: "assistant",
    parts: [{ type: "notice", id: `n_${randomUUID().slice(0, 12)}`, kind: ok ? "info" : "warning", text }],
    status: "complete",
    createdAt: Date.now(),
  });
  const record = conversations.update(conversationId, {}, true);
  if (record) appEvents.publish({ type: "conversation", conversation: toPublicConversation(record) });
}

export const leadAsks = {
  /** Puts a request on a card in the Lead's running reply; its id, or null when no reply is running there. */
  post(
    conversationId: string,
    input: { taskId: string; action: LeadAction; method?: "merge" | "pr" | null; headSha: string | null; message: string },
  ): string | null {
    const run = runRegistry.activeFor(conversationId);
    const chat = conversations.get(conversationId);
    if (!run?.addPart || !chat) return null;
    const now = Date.now();
    const part: ApprovalPart = {
      type: "approval",
      id: `a_${randomUUID().slice(0, 12)}`,
      source: "Lead",
      message: input.message,
      kind: "confirm",
      status: "pending",
      expiresAt: now + OPEN_MS,
      lead: { action: input.action, taskId: input.taskId },
    };
    run.addPart(part);
    db.prepare(
      `INSERT INTO lead_asks (id, conversation_id, message_id, task_id, action, method, head_sha, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(part.id, conversationId, run.messageId, input.taskId, input.action, input.method ?? null, input.headSha, now, part.expiresAt);
    appEvents.publish({ type: "approval", agentId: chat.agentId, conversationId, runId: run.id, partId: part.id, message: part.message, pending: true });
    return part.id;
  },

  get(id: string): LeadAsk | null {
    const row = db.prepare(`SELECT * FROM lead_asks WHERE id = ?`).get(id) as Row | undefined;
    return row ? toAsk(row) : null;
  },

  /** The request for this task (and commit) still waiting for the user, if there is one. */
  openFor(taskId: string, action: LeadAction, headSha: string | null): LeadAsk | null {
    const row = db
      .prepare(`SELECT * FROM lead_asks WHERE task_id = ? AND action = ? AND answered_at IS NULL AND expires_at > ? AND (head_sha IS ? OR head_sha = ?) ORDER BY created_at DESC LIMIT 1`)
      .get(taskId, action, Date.now(), headSha, headSha) as Row | undefined;
    return row ? toAsk(row) : null;
  },

  /**
   * The user's answer (POST /api/lead/asks/:id). Yes lands (or discards) the task at the commit the card showed;
   * no does nothing. Either way the card shows the answer and the Lead's chat gets a note of what happened.
   */
  async answer(id: string, decision: "accept" | "decline"): Promise<{ status: "accepted" | "declined"; ok: boolean; text: string }> {
    const ask = leadAsks.get(id);
    if (!ask) throw new HttpError(404, "This request isn't here any more.");
    if (ask.answeredAt !== null) throw new HttpError(409, "This request was answered already.");
    if (ask.expiresAt <= Date.now()) {
      db.prepare(`UPDATE lead_asks SET answered_at = ?, decision = 'expired' WHERE id = ? AND answered_at IS NULL`).run(Date.now(), id);
      setStatus(ask, "expired");
      throw new HttpError(409, "This request expired. Ask the Lead again.");
    }
    // Claimed first, so a second click (or a second tab) can't land it twice.
    const claimed = db.prepare(`UPDATE lead_asks SET answered_at = ?, decision = ? WHERE id = ? AND answered_at IS NULL`).run(Date.now(), decision, id);
    if (Number(claimed.changes) === 0) throw new HttpError(409, "This request was answered already.");
    const title = taskStore.get(ask.taskId)?.title ?? "the task";
    let ok = true;
    let text: string;
    if (decision === "decline") {
      text = ask.action === "land" ? `You said no: “${title}” wasn't landed.` : `You said no: “${title}” wasn't discarded.`;
    } else if (ask.action === "discard") {
      try {
        await landing.discard(ask.taskId);
        text = `Discarded “${title}”, as you approved.`;
      } catch (err) {
        ok = false;
        text = `You approved, but “${title}” wasn't discarded: ${errorText(err)}`;
      }
    } else {
      try {
        const landed = (await landing.land(ask.taskId, { ...(ask.method ? { method: ask.method } : {}), ...(ask.headSha ? { headSha: ask.headSha } : {}) })).task.landing;
        text =
          landed?.kind === "pr"
            ? `Opened draft PR #${landed.pr?.number ?? "?"} for “${title}”${landed.target ? ` against ${landed.target}` : ""}, as you approved.`
            : `Merged “${title}” into ${landed?.target ?? "its base"}${landed?.sha ? ` (${landed.sha.slice(0, 7)})` : ""}, as you approved.`;
      } catch (err) {
        ok = false;
        text = `You approved, but “${title}” didn't land: ${errorText(err)} Nothing changed.`;
      }
    }
    db.prepare(`UPDATE lead_asks SET outcome = ? WHERE id = ?`).run(text, id);
    const status = decision === "accept" ? "accepted" : "declined";
    setStatus(ask, status);
    note(ask.conversationId, text, ok);
    return { status, ok, text };
  },
};
