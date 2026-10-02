import { randomUUID } from "node:crypto";
import type { Memory } from "../../shared/types.ts";
import { db, type Row } from "../db.ts";

/**
 * Long-term memory about the user (preferences, personal details, goals),
 * shared by every agent. What an agent knows about its own work lives in its
 * workspace wiki instead (wiki.ts).
 */

function toMemory(row: Row): Memory {
  return {
    id: String(row.id),
    content: String(row.content),
    source: row.source as Memory["source"],
    conversationId: (row.conversation_id as string | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Turns free text into a safe FTS5 query: any of the words, prefix-matched. */
export function toFtsQuery(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu);
  if (!words?.length) return null;
  return [...new Set(words)].slice(0, 24).map((word) => `"${word}"*`).join(" OR ");
}

/** Budget for memories placed in a new chat's system prompt. */
const PROMPT_BUDGET_CHARS = 5000;

export const memories = {
  list(limit = 500): Memory[] {
    const rows = db.prepare(`SELECT * FROM memories WHERE agent_id IS NULL ORDER BY updated_at DESC LIMIT ?`).all(limit) as Row[];
    return rows.map(toMemory);
  },

  search(query: string, limit = 20): Memory[] {
    const fts = toFtsQuery(query);
    if (!fts) return memories.list(limit);
    const rows = db
      .prepare(
        `SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ? AND m.agent_id IS NULL ORDER BY bm25(memories_fts) LIMIT ?`,
      )
      .all(fts, limit) as Row[];
    return rows.map(toMemory);
  },

  get(id: string): Memory | null {
    const row = db.prepare(`SELECT * FROM memories WHERE id = ? AND agent_id IS NULL`).get(id) as Row | undefined;
    return row ? toMemory(row) : null;
  },

  create(input: { content: string; source: Memory["source"]; conversationId?: string | null }): Memory {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (id, content, source, conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.content.trim(), input.source, input.conversationId ?? null, now, now);
    return memories.get(id)!;
  },

  /** An existing memory with the same text, if any. */
  findDuplicate(content: string): Memory | null {
    const text = content.trim().toLowerCase();
    return memories.list().find((m) => m.content.trim().toLowerCase() === text) ?? null;
  },

  update(id: string, content: string): Memory | null {
    db.prepare(`UPDATE memories SET content = ?, updated_at = ? WHERE id = ?`).run(content.trim(), Date.now(), id);
    return memories.get(id);
  },

  delete(id: string): boolean {
    return db.prepare(`DELETE FROM memories WHERE id = ? AND agent_id IS NULL`).run(id).changes > 0;
  },

  /** Memories for a new chat's system prompt, oldest first; the most relevant and recent when there are too many. */
  forPrompt(firstMessage: string): Memory[] {
    const all = memories.list();
    let picked = all;
    if (all.reduce((sum, m) => sum + m.content.length, 0) > PROMPT_BUDGET_CHARS) {
      const byId = new Map<string, Memory>();
      for (const m of [...memories.search(firstMessage, 25), ...all.slice(0, 25)]) byId.set(m.id, m);
      let used = 0;
      picked = [...byId.values()].filter((m) => (used += m.content.length) <= PROMPT_BUDGET_CHARS);
    }
    return picked.sort((a, b) => a.createdAt - b.createdAt);
  },
};
