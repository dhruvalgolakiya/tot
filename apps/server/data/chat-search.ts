import { db, type Row } from "../db.ts";
import { messageText, messages } from "./messages.ts";
import { toFtsQuery } from "./memories.ts";

/** Lets an agent look back through the earlier chats in its own workspace. */

export interface ChatHit {
  conversationId: string;
  title: string;
  updatedAt: number;
  snippet: string;
}

export interface RecentChat {
  id: string;
  title: string;
  updatedAt: number;
}

/** chat_read pages: messages per page by default and at most, and characters per message. */
const PAGE = 20;
const MAX_PAGE = 50;
const MAX_MESSAGE_CHARS = 4000;

export const chatSearch = {
  /** Best matches in the agent's chats (other than `exclude`), one hit per chat. */
  search(agentId: string, query: string, opts: { exclude?: string; limit?: number } = {}): ChatHit[] {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const rows = db
      .prepare(
        `SELECT s.conversation_id, c.title, c.updated_at,
                snippet(message_search, 0, '«', '»', ' … ', 18) AS snippet
         FROM message_search s JOIN conversations c ON c.id = s.conversation_id
         WHERE message_search MATCH ? AND c.agent_id = ? AND c.id != ?
         ORDER BY bm25(message_search) LIMIT 60`,
      )
      .all(fts, agentId, opts.exclude ?? "") as Row[];
    const hits = new Map<string, ChatHit>();
    for (const row of rows) {
      const id = String(row.conversation_id);
      if (hits.has(id)) continue;
      hits.set(id, { conversationId: id, title: String(row.title), updatedAt: Number(row.updated_at), snippet: String(row.snippet) });
    }
    return [...hits.values()].slice(0, opts.limit ?? 8);
  },

  recent(agentId: string, opts: { exclude?: string; limit?: number } = {}): RecentChat[] {
    const rows = db
      .prepare(`SELECT id, title, updated_at FROM conversations WHERE agent_id = ? AND id != ? ORDER BY updated_at DESC LIMIT ?`)
      .all(agentId, opts.exclude ?? "", opts.limit ?? 8) as Row[];
    return rows.map((row) => ({ id: String(row.id), title: String(row.title), updatedAt: Number(row.updated_at) }));
  },

  /**
   * A page of one chat's messages, oldest first: the newest `limit`, or the `limit` before message
   * `before`. Null when the chat isn't in this agent's workspace (or `before` isn't in it).
   */
  transcript(
    agentId: string,
    conversationId: string,
    opts: { before?: string; limit?: number } = {},
  ): { title: string; messages: { id: string; role: "user" | "assistant"; text: string }[]; earlier: number; total: number } | null {
    const chat = db.prepare(`SELECT title FROM conversations WHERE id = ? AND agent_id = ?`).get(conversationId, agentId) as
      | Row
      | undefined;
    if (!chat) return null;
    const all = messages
      .listByConversation(conversationId)
      .map((m) => ({ id: m.id, role: m.role, text: messageText(m) }))
      .filter((m) => m.text);
    const end = opts.before ? all.findIndex((m) => m.id === opts.before) : all.length;
    if (end < 0) return null;
    const start = Math.max(0, end - Math.min(opts.limit ?? PAGE, MAX_PAGE));
    const clipped = (text: string) => (text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS).trimEnd()}… [cut at 4,000 characters]` : text);
    const page = all.slice(start, end).map((m) => ({ ...m, text: clipped(m.text) }));
    return { title: String(chat.title), messages: page, earlier: start, total: all.length };
  },
};
