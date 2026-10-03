import type { Message, MessagePart, MessageRole, MessageStatus, ProviderId, Usage } from "../../shared/types.ts";
import { db, parseJson, type Row } from "../db.ts";

/** Extras kept in the meta column: how a user message was sent (module 01) and handled (module 02). */
type MessageMeta = Pick<Message, "steered" | "steeredInto" | "auto" | "dispatch">;

function metaOf(message: Message): string | null {
  const meta: MessageMeta = {
    ...(message.steered ? { steered: true } : {}),
    ...(message.steeredInto ? { steeredInto: message.steeredInto } : {}),
    ...(message.auto ? { auto: true } : {}),
    ...(message.dispatch ? { dispatch: message.dispatch } : {}),
  };
  return Object.keys(meta).length ? JSON.stringify(meta) : null;
}

function toMessage(row: Row): Message {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    role: row.role as MessageRole,
    parts: parseJson<MessagePart[]>(row.parts, []),
    status: row.status as MessageStatus,
    provider: (row.provider as ProviderId | null) ?? undefined,
    model: (row.model as string | null) ?? undefined,
    routeReason: (row.route_reason as string | null) ?? undefined,
    error: (row.error as string | null) ?? undefined,
    usage: parseJson<Usage | undefined>(row.usage, undefined),
    ...parseJson<MessageMeta>(row.meta, {}),
    createdAt: Number(row.created_at),
  };
}

/** Keeps a finished message's text in the chat search index. */
function index(message: Message): void {
  if (message.status === "streaming") return;
  db.prepare(`DELETE FROM message_search WHERE message_id = ?`).run(message.id);
  const text = messageText(message);
  if (text) {
    db.prepare(`INSERT INTO message_search (text, message_id, conversation_id) VALUES (?, ?, ?)`).run(
      text,
      message.id,
      message.conversationId,
    );
  }
}

export const messages = {
  listByConversation(conversationId: string): Message[] {
    const rows = db
      .prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid`)
      .all(conversationId) as Row[];
    return rows.map(toMessage);
  },

  insert(message: Message): void {
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, parts, status, provider, model, route_reason, error, usage, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      message.id,
      message.conversationId,
      message.role,
      JSON.stringify(message.parts),
      message.status,
      message.provider ?? null,
      message.model ?? null,
      message.routeReason ?? null,
      message.error ?? null,
      message.usage ? JSON.stringify(message.usage) : null,
      metaOf(message),
      message.createdAt,
    );
    index(message);
  },

  /** Records how TOT handled a user message (its dispatch decision), once that's known. */
  setDispatch(id: string, dispatch: Message["dispatch"]): void {
    const message = messages.get(id);
    if (message) db.prepare(`UPDATE messages SET meta = ? WHERE id = ?`).run(metaOf({ ...message, dispatch }), id);
  },

  get(id: string): Message | null {
    const row = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as Row | undefined;
    return row ? toMessage(row) : null;
  },

  /** A reply's place in its provider session (the session, and the provider's ref for the turn), for forks. */
  setProviderRef(id: string, ref: { session: string; ref: string }): void {
    db.prepare(`UPDATE messages SET provider_ref = ? WHERE id = ?`).run(JSON.stringify(ref), id);
  },

  providerRef(id: string): { session: string; ref: string } | null {
    const row = db.prepare(`SELECT provider_ref FROM messages WHERE id = ?`).get(id) as Row | undefined;
    return parseJson<{ session: string; ref: string } | null>(row?.provider_ref, null);
  },

  /** Overwrites the mutable fields of an assistant message as it streams. */
  save(message: Message): void {
    const { changes } = db.prepare(
      `UPDATE messages SET parts = ?, status = ?, provider = ?, model = ?, route_reason = ?, error = ?, usage = ? WHERE id = ?`,
    ).run(
      JSON.stringify(message.parts),
      message.status,
      message.provider ?? null,
      message.model ?? null,
      message.routeReason ?? null,
      message.error ?? null,
      message.usage ? JSON.stringify(message.usage) : null,
      message.id,
    );
    // The chat may have been deleted meanwhile; don't leave a search entry behind.
    if (changes > 0) index(message);
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
