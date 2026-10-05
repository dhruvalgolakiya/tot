import type { Memory } from "../../shared/types.ts";
import { db, type Row } from "../db.ts";
import { secretKind } from "../trust/secrets.ts";

/**
 * The memories from before memory became a git repo (`memories_legacy`, db.ts) and the one-time import's state
 * (roadmap module 10). Until the import commit lands, prompts and /api/memories read these rows, read-only, so a
 * failed import never leaves memory empty; the import is tried again at the next start.
 */

const DONE_KEY = "memoryImportedAt";
const ERROR_KEY = "memoryImportError";
/** Where an old memory shows while it isn't in the repo yet. */
export const LEGACY_PATH = "(not imported yet)";

const setting = (key: string) => (db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as Row | undefined)?.value ?? null;

function put(key: string, value: string | null): void {
  if (value === null) db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
  else db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export const importDone = () => Boolean(setting(DONE_KEY));
export const importError = () => (setting(ERROR_KEY) as string | null) ?? null;

export function markImportDone(): void {
  put(DONE_KEY, String(Date.now()));
  put(ERROR_KEY, null);
}

export const setImportError = (message: string) => put(ERROR_KEY, message);

/** The user's old memories (not an agent workspace's), oldest first. */
export const legacyRows = () => db.prepare(`SELECT * FROM memories_legacy WHERE agent_id IS NULL ORDER BY created_at, rowid`).all() as Row[];

export const legacyRow = (id: string) => db.prepare(`SELECT * FROM memories_legacy WHERE id = ? AND agent_id IS NULL`).get(id) as Row | undefined;

export function markRows(ids: string[], state: "imported" | "secret"): void {
  const update = db.prepare(`UPDATE memories_legacy SET import_state = ? WHERE id = ?`);
  for (const id of ids) update.run(state, id);
}

/** An old row as a memory, in the "you" repo but not in a file yet. */
export function legacyMemory(row: Row): Memory {
  return {
    id: String(row.id),
    content: String(row.content),
    source: row.source === "user" ? "user" : "agent",
    conversationId: (row.conversation_id as string | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    repo: "you",
    path: LEGACY_PATH,
  };
}

/** The old memories, newest first and read-only, while the import hasn't landed (none that look like a secret). */
export function legacyMemories(): Memory[] {
  return legacyRows()
    .filter((row) => row.import_state !== "secret" && !secretKind(String(row.content)))
    .map(legacyMemory)
    .reverse();
}
