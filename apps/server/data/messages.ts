import type { Message, MessagePart, MessageRole, MessageStatus, ProviderId, TurnChanges, Usage } from "@tot/shared/types";
import { db, parseJson, statement, type Row } from "../db.ts";

/**
 * Extras kept in the meta column: how a user message was sent (module 01), the chats attached to it (module 05), the
 * skill it invoked, the files it named, plan mode's messages, and what a reply's turn changed in the chat's workspace
 * (chats/checkpoints.ts).
 */
type MessageMeta = Pick<Message, "steered" | "steeredInto" | "auto" | "contextChats" | "skill" | "files" | "plan" | "changes">;

function metaOf(message: Message): string | null {
  const meta: MessageMeta = {
    ...(message.steered ? { steered: true } : {}),
    ...(message.steeredInto ? { steeredInto: message.steeredInto } : {}),
    ...(message.auto ? { auto: true } : {}),
    ...(message.contextChats?.length ? { contextChats: message.contextChats } : {}),
    ...(message.skill ? { skill: message.skill } : {}),
    ...(message.files?.length ? { files: message.files } : {}),
    ...(message.plan ? { plan: true } : {}),
    ...(message.changes ? { changes: message.changes } : {}),
  };
  return Object.keys(meta).length ? JSON.stringify(meta) : null;
}

/** The meta column's known extras (older rows can hold others, e.g. a dispatch decision from before it was removed). */
function metaFrom(value: unknown): MessageMeta {
  const { steered, steeredInto, auto, contextChats, skill, files, plan, changes } = parseJson<MessageMeta>(value, {});
  return {
    ...(steered ? { steered } : {}),
    ...(steeredInto ? { steeredInto } : {}),
    ...(auto ? { auto } : {}),
    ...(contextChats?.length ? { contextChats } : {}),
    ...(typeof skill === "string" && skill ? { skill } : {}),
    ...(Array.isArray(files) && files.length ? { files } : {}),
    ...(plan ? { plan: true } : {}),
    ...(changes?.files ? { changes } : {}),
  };
}

function toMessage(row: Row): Message {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    role: row.role as MessageRole,
    parts: parseJson<MessagePart[]>(row.parts, []),
    status: row.status as MessageStatus,
    provider: (row.provider as ProviderId | null) ?? undefined,
    ...(row.account ? { account: String(row.account) } : {}),
    model: (row.model as string | null) ?? undefined,
    routeReason: (row.route_reason as string | null) ?? undefined,
    error: (row.error as string | null) ?? undefined,
    usage: parseJson<Usage | undefined>(row.usage, undefined),
    ...metaFrom(row.meta),
    createdAt: Number(row.created_at),
  };
}

/** Keeps a finished message's text in the chat search index. */
function index(message: Message): void {
  if (message.status === "streaming") return;
  statement(`DELETE FROM message_search WHERE message_id = ?`).run(message.id);
  const text = messageText(message);
  if (text) {
    statement(`INSERT INTO message_search (text, message_id, conversation_id) VALUES (?, ?, ?)`).run(
      text,
      message.id,
      message.conversationId,
    );
  }
}

/**
 * Bumped whenever a chat's messages are written, for its ETag (GET /api/conversations/:id): a part's status can change
 * without its length changing (an approval going from pending to expired). Kept in memory: the ETag also names this
 * run of the server, so a restart changes every ETag anyway.
 */
const versions = new Map<string, number>();
const bump = (conversationId: string) => versions.set(conversationId, (versions.get(conversationId) ?? 0) + 1);

export const messages = {
  listByConversation(conversationId: string): Message[] {
    const rows = statement(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid`).all(conversationId) as Row[];
    return rows.map(toMessage);
  },

  insert(message: Message): void {
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, parts, status, provider, account, model, route_reason, error, usage, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      message.id,
      message.conversationId,
      message.role,
      JSON.stringify(message.parts),
      message.status,
      message.provider ?? null,
      message.account ?? null,
      message.model ?? null,
      message.routeReason ?? null,
      message.error ?? null,
      message.usage ? JSON.stringify(message.usage) : null,
      metaOf(message),
      message.createdAt,
    );
    bump(message.conversationId);
    index(message);
  },

  /** The skills a chat's messages invoked, oldest first (their folders are the ones its agent may read). */
  skillsUsed(conversationId: string): string[] {
    const rows = statement(
      `SELECT json_extract(meta, '$.skill') AS skill FROM messages
       WHERE conversation_id = ? AND role = 'user' AND json_valid(meta) AND json_extract(meta, '$.skill') IS NOT NULL
       GROUP BY skill ORDER BY min(created_at)`,
    ).all(conversationId) as Row[];
    return rows.map((row) => String(row.skill));
  },

  /** Records how TOT handled a user message (its dispatch decision), once that's known. */
  get(id: string): Message | null {
    const row = statement(`SELECT * FROM messages WHERE id = ?`).get(id) as Row | undefined;
    return row ? toMessage(row) : null;
  },

  /**
   * What a chat's messages are right now, without reading them: how many, the newest row, their size, and how often
   * they were written in this server's run. Equal stamps mean an unchanged chat (its ETag).
   */
  stamp(conversationId: string): string {
    const row = statement(
      `SELECT count(*) AS n, coalesce(max(rowid), 0) AS last, coalesce(sum(length(parts)), 0) AS bytes FROM messages WHERE conversation_id = ?`,
    ).get(conversationId) as Row;
    return `${row.n}:${row.last}:${row.bytes}:${versions.get(conversationId) ?? 0}`;
  },

  /** One part of a chat's message, whole (a clipped chat's tool call, opened); null when there's no such part. */
  part(conversationId: string, messageId: string, partId: string): MessagePart | null {
    const row = statement(
      `SELECT part.value AS value FROM messages, json_each(messages.parts) AS part
       WHERE messages.id = ? AND messages.conversation_id = ? AND json_extract(part.value, '$.id') = ?`,
    ).get(messageId, conversationId, partId) as Row | undefined;
    return parseJson<MessagePart | null>(row?.value, null);
  },

  /** What a reply's turn changed in the chat's workspace, kept with the reply. */
  setChanges(id: string, changes: TurnChanges): void {
    const row = statement(`SELECT conversation_id, meta FROM messages WHERE id = ?`).get(id) as Row | undefined;
    if (!row) return;
    statement(`UPDATE messages SET meta = ? WHERE id = ?`).run(JSON.stringify({ ...parseJson<MessageMeta>(row.meta, {}), changes }), id);
    bump(String(row.conversation_id));
  },

  /** Deletes some of a chat's messages (a rewind), with their search entries. */
  remove(conversationId: string, ids: string[]): void {
    db.exec("BEGIN");
    try {
      for (const id of ids) {
        statement(`DELETE FROM message_search WHERE message_id = ?`).run(id);
        statement(`DELETE FROM messages WHERE id = ? AND conversation_id = ?`).run(id, conversationId);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    bump(conversationId);
  },

  /** A reply's place in its provider session (the session, and the provider's ref for the turn), for forks. */
  setProviderRef(id: string, ref: { session: string; ref: string }): void {
    db.prepare(`UPDATE messages SET provider_ref = ? WHERE id = ?`).run(JSON.stringify(ref), id);
  },

  providerRef(id: string): { session: string; ref: string } | null {
    const row = db.prepare(`SELECT provider_ref FROM messages WHERE id = ?`).get(id) as Row | undefined;
    return parseJson<{ session: string; ref: string } | null>(row?.provider_ref, null);
  },

  /** Overwrites the mutable fields of an assistant message as it streams; returns the size of its parts' JSON. */
  save(message: Message): number {
    const parts = JSON.stringify(message.parts);
    const { changes } = statement(
      `UPDATE messages SET parts = ?, status = ?, provider = ?, account = ?, model = ?, route_reason = ?, error = ?, usage = ? WHERE id = ?`,
    ).run(
      parts,
      message.status,
      message.provider ?? null,
      message.account ?? null,
      message.model ?? null,
      message.routeReason ?? null,
      message.error ?? null,
      message.usage ? JSON.stringify(message.usage) : null,
      message.id,
    );
    bump(message.conversationId);
    // The chat may have been deleted meanwhile; don't leave a search entry behind.
    if (changes > 0) index(message);
    return parts.length;
  },
};

/** Plain-text rendering of a message, used for transcripts and titles. */
export function messageText(message: Message): string {
  return message.parts
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

// Backfill the search index for chats from before it existed.
if (!(db.prepare(`SELECT 1 FROM message_search LIMIT 1`).get())) {
  for (const row of db.prepare(`SELECT * FROM messages WHERE status != 'streaming'`).all() as Row[]) index(toMessage(row));
}
