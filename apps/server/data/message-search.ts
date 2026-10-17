import type { MessageRole, MessageSearchHit, SnippetPart } from "@tot/shared/types";
import { db, type Row } from "../db.ts";

/**
 * The user's search over what was said in every chat (the command palette), on the index messages.ts keeps:
 * each finished message's text, updated as replies are saved.
 */

const PER_CHAT = 3;
const MAX_HITS = 50;
/** Rows read from the index before the per-chat cap; enough for a page of hits from a handful of chats. */
const SCAN = 400;
const SNIPPET_TOKENS = 20;
// Marks around matched words in snippet(): control characters, so they can't clash with what a message says.
const OPEN = "\u0001";
const CLOSE = "\u0002";

/** Every word of the query, each as a prefix ("depl" finds "deploy"); null when it has none FTS can match on. */
export function toPaletteQuery(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!words?.length) return null;
  return [...new Set(words)].slice(0, 12).map((word) => `"${word}"*`).join(" ");
}

/** snippet()'s text, with its marks, as parts. */
export function snippetParts(marked: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  for (const [index, piece] of marked.split(OPEN).entries()) {
    const [matched, rest] = index === 0 ? [null, piece] : piece.split(CLOSE);
    if (matched) parts.push({ text: matched, match: true });
    if (rest) parts.push({ text: rest });
  }
  return parts.map((part) => ({ ...part, text: part.text.replace(/\s+/g, " ") }));
}

/** Around the first place `needle` occurs (no FTS words to go on, e.g. "→" or "#"): the same shape as snippet()'s. */
function likeSnippet(text: string, needle: string): SnippetPart[] {
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return [{ text: text.slice(0, 120) }];
  const start = Math.max(0, at - 50);
  const end = Math.min(text.length, at + needle.length + 70);
  return [
    { text: `${start > 0 ? "…" : ""}${text.slice(start, at)}` },
    { text: text.slice(at, at + needle.length), match: true },
    { text: `${text.slice(at + needle.length, end)}${end < text.length ? "…" : ""}` },
  ]
    .filter((part) => part.text)
    .map((part) => ({ ...part, text: part.text.replace(/\s+/g, " ") }) as SnippetPart);
}

function toHit(row: Row, snippet: SnippetPart[]): MessageSearchHit {
  return {
    conversationId: String(row.conversation_id),
    agentId: String(row.agent_id),
    title: String(row.title),
    messageId: String(row.message_id),
    role: row.role as MessageRole,
    snippet,
    createdAt: Number(row.created_at),
  };
}

/** At most PER_CHAT hits from any one chat, in the order they came. */
function capPerChat(hits: MessageSearchHit[], limit: number): MessageSearchHit[] {
  const counts = new Map<string, number>();
  return hits
    .filter((hit) => {
      const count = counts.get(hit.conversationId) ?? 0;
      counts.set(hit.conversationId, count + 1);
      return count < PER_CHAT;
    })
    .slice(0, limit);
}

export const messageSearch = {
  /** Messages whose text has every word of `query`, best first; optionally only one agent's chats. */
  search(query: string, opts: { agentId?: string; limit?: number } = {}): MessageSearchHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 20, MAX_HITS));
    const fts = toPaletteQuery(query);
    const agentFilter = opts.agentId ? "AND c.agent_id = ?" : "";
    const agentArgs = opts.agentId ? [opts.agentId] : [];
    if (fts) {
      try {
        const rows = db
          .prepare(
            `SELECT s.message_id, s.conversation_id, c.agent_id, c.title, m.role, m.created_at,
                    snippet(message_search, 0, char(1), char(2), ' … ', ${SNIPPET_TOKENS}) AS snippet
             FROM message_search s
             JOIN messages m ON m.id = s.message_id
             JOIN conversations c ON c.id = s.conversation_id
             WHERE message_search MATCH ? ${agentFilter}
             ORDER BY bm25(message_search), m.created_at DESC LIMIT ${SCAN}`,
          )
          .all(fts, ...agentArgs) as Row[];
        return capPerChat(rows.map((row) => toHit(row, snippetParts(String(row.snippet)))), limit);
      } catch (err) {
        // A query FTS can't parse falls through to a plain substring match.
        console.warn("[tot] message search fell back to LIKE:", err instanceof Error ? err.message : err);
      }
    }
    const needle = query.trim();
    if (!needle) return [];
    const rows = db
      .prepare(
        `SELECT s.message_id, s.conversation_id, s.text, c.agent_id, c.title, m.role, m.created_at
         FROM message_search s
         JOIN messages m ON m.id = s.message_id
         JOIN conversations c ON c.id = s.conversation_id
         WHERE s.text LIKE '%' || ? || '%' ESCAPE '\\' ${agentFilter}
         ORDER BY m.created_at DESC LIMIT ${SCAN}`,
      )
      .all(needle.replace(/[\\%_]/g, (c) => `\\${c}`), ...agentArgs) as Row[];
    return capPerChat(rows.map((row) => toHit(row, likeSnippet(String(row.text), needle))), limit);
  },
};
