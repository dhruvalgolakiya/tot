import type { Memory } from "../../shared/types.ts";
import { db, type Row } from "../db.ts";

/**
 * The memory index (roadmap module 10). Memory itself is git repos of markdown (server/memory/); this table
 * holds their entries, rebuilt from the files after every commit (memory/index.ts), so lookups and full-text
 * search stay fast. Ids are unique within a repo only: lookups name the repos they may see.
 */

/** One entry as stored in the index. */
export interface IndexRow {
  id: string;
  repo: string;
  path: string;
  line: number;
  content: string;
  source: Memory["source"];
  sourceRef: string | null;
  conversationId: string | null;
  derived: boolean;
  createdAt: number;
}

function toMemory(row: Row): Memory {
  return {
    id: String(row.id),
    content: String(row.content),
    source: row.source as Memory["source"],
    conversationId: (row.conversation_id as string | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    repo: String(row.repo),
    path: String(row.path),
  };
}

/** Turns free text into a safe FTS5 query: any of the words, prefix-matched. */
export function toFtsQuery(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu);
  if (!words?.length) return null;
  return [...new Set(words)].slice(0, 24).map((word) => `"${word}"*`).join(" OR ");
}

export const memories = {
  /** A repo's entries in file order (MEMORY.md first). */
  list(repo = "you", limit = 2000): Memory[] {
    const rows = db
      .prepare(`SELECT * FROM memories WHERE repo = ? ORDER BY path != 'MEMORY.md', path, line LIMIT ?`)
      .all(repo, limit) as Row[];
    return rows.map(toMemory);
  },

  /** Best matches first, in the given repos (all of them when omitted); files can be left out. */
  search(query: string, opts: { repos?: string[]; limit?: number; excludePaths?: string[] } = {}): Memory[] {
    const fts = toFtsQuery(query);
    const limit = opts.limit ?? 20;
    if (!fts) return [];
    const rows = db
      .prepare(
        `SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ? ${opts.repos ? "AND m.repo IN (SELECT value FROM json_each(?))" : ""}
           AND m.path NOT IN (SELECT value FROM json_each(?))
         ORDER BY bm25(memories_fts) LIMIT ?`,
      )
      .all(...[fts, ...(opts.repos ? [JSON.stringify(opts.repos)] : []), JSON.stringify(opts.excludePaths ?? []), limit]) as Row[];
    return rows.map(toMemory);
  },

  /** Newest first, in the given repos; files can be left out. */
  recent(opts: { repos: string[]; limit?: number; excludePaths?: string[] }): Memory[] {
    const rows = db
      .prepare(
        `SELECT * FROM memories WHERE repo IN (SELECT value FROM json_each(?)) AND path NOT IN (SELECT value FROM json_each(?))
         ORDER BY created_at DESC, line DESC LIMIT ?`,
      )
      .all(JSON.stringify(opts.repos), JSON.stringify(opts.excludePaths ?? []), opts.limit ?? 20) as Row[];
    return rows.map(toMemory);
  },

  /** An entry by id (its key, see memory/repo.ts), in the first of `repos` that has it (any repo when omitted). */
  get(id: string, repos?: string[]): Memory | null {
    const rows = db.prepare(`SELECT * FROM memories WHERE id = ? ORDER BY rowid DESC`).all(id) as Row[];
    const found = rows.map(toMemory);
    if (!repos) return found[0] ?? null;
    for (const repo of repos) {
      const hit = found.find((m) => m.repo === repo);
      if (hit) return hit;
    }
    return null;
  },

  count(repo: string): number {
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE repo = ?`).get(repo) as Row).n);
  },

  /** Every id in use, in any repo: new ids avoid them all. */
  ids(): Set<string> {
    return new Set((db.prepare(`SELECT id FROM memories`).all() as Row[]).map((row) => String(row.id)));
  },

  /** Drops rows of repos that aren't there anymore. */
  pruneRepos(keep: string[]): void {
    db.prepare(`DELETE FROM memories WHERE repo NOT IN (SELECT value FROM json_each(?))`).run(JSON.stringify(keep));
  },

  /** Replaces a repo's rows with what its files hold now. */
  replaceRepo(repo: string, rows: IndexRow[], now = Date.now()): void {
    db.exec("BEGIN");
    try {
      db.prepare(`DELETE FROM memories WHERE repo = ?`).run(repo);
      const insert = db.prepare(
        `INSERT INTO memories (id, repo, path, line, content, source, source_ref, conversation_id, derived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        insert.run(row.id, repo, row.path, row.line, row.content, row.source, row.sourceRef, row.conversationId, row.derived ? 1 : 0, row.createdAt || now, row.createdAt || now);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  },
};
