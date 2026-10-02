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

const MAX_TRANSCRIPT_CHARS = 14_000;

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

  /** A readable transcript of one chat, or null when it isn't in this agent's workspace. */
  transcript(agentId: string, conversationId: string): { title: string; text: string } | null {
    const chat = db.prepare(`SELECT title FROM conversations WHERE id = ? AND agent_id = ?`).get(conversationId, agentId) as
      | Row
      | undefined;
    if (!chat) return null;
    const lines = messages
      .listByConversation(conversationId)
      .map((m) => ({ role: m.role, text: messageText(m) }))
      .filter((t) => t.text)
      .map((t) => `${t.role === "user" ? "User" : "You"}: ${t.text}`);
    let text = lines.join("\n\n");
    // Keep the opening (what was asked) and the end (where it got to).
    if (text.length > MAX_TRANSCRIPT_CHARS) {
      const head = Math.floor(MAX_TRANSCRIPT_CHARS * 0.3);
      text = `${text.slice(0, head)}\n\n… ${text.length - MAX_TRANSCRIPT_CHARS} characters omitted …\n\n${text.slice(-(MAX_TRANSCRIPT_CHARS - head))}`;
    }
    return { title: String(chat.title), text };
  },
};
