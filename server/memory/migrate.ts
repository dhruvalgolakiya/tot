import { db, type Row } from "../db.ts";
import { memories } from "../data/memories.ts";
import { repoEntries } from "./index.ts";
import { afterChange, ENTRY_FILE_BUDGET, looksLikeSecret, OVERFLOW_FILE } from "./memory.ts";
import {
  commitAll,
  commitOutsideEdits,
  ENTRY_FILE,
  entryText,
  formatEntry,
  initRepo,
  insertEntry,
  linkFromEntry,
  newId,
  readFile,
  today,
  withRepo,
  writeFile,
  YOU,
} from "./repo.ts";

/**
 * The one-time import (roadmap module 10). Memories saved before memory became a git repo (the old `memories`
 * table, kept as `memories_legacy` by db.ts) become entries in the "you" repo: about the first 3500 characters in
 * MEMORY.md, the rest in notes.md (linked from it), as one commit "Imported N memories". Runs at startup and does
 * nothing once done; the old rows stay in `memories_legacy`, untouched.
 */

const DONE_KEY = "memoryImportedAt";

const done = () => Boolean(db.prepare(`SELECT 1 FROM settings WHERE key = ?`).get(DONE_KEY));
const markDone = () =>
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(DONE_KEY, String(Date.now()));

/** Imports the old memories, once. Returns how many it imported (0 when there were none, or it already ran). */
export async function migrateMemories(): Promise<number> {
  if (done()) return 0;
  const rows = db.prepare(`SELECT * FROM memories_legacy WHERE agent_id IS NULL ORDER BY created_at, rowid`).all() as Row[];
  return withRepo(YOU, async () => {
    if (done()) return 0;
    await initRepo(YOU);
    const outside = await commitOutsideEdits(YOU);
    // A crash after the commit but before it was marked done: what's already there isn't imported twice.
    const present = new Set(repoEntries(YOU).map((entry) => entry.text.toLowerCase()));
    const taken = new Set([...memories.ids(), ...repoEntries(YOU).map((entry) => entry.id)]);
    let main = readFile(YOU, ENTRY_FILE) ?? "";
    let notes: string | null = readFile(YOU, OVERFLOW_FILE);
    let imported = 0;
    let secrets = 0;
    for (const row of rows) {
      const text = entryText(String(row.content));
      if (text.length < 2 || present.has(text.toLowerCase())) continue;
      if (looksLikeSecret(text)) {
        secrets++;
        continue;
      }
      present.add(text.toLowerCase());
      const id = newId(taken);
      taken.add(id);
      const chat = row.conversation_id ? String(row.conversation_id) : null;
      const source = chat ? `tot://c/${chat}` : row.source === "user" ? "you" : "tot";
      const line = formatEntry({ text, id, source, added: today(new Date(Number(row.created_at))) });
      if (main.length + line.length + 1 <= ENTRY_FILE_BUDGET) main = insertEntry(ENTRY_FILE, main, line);
      else notes = insertEntry(OVERFLOW_FILE, notes, line);
      imported++;
    }
    let sha: string | null = null;
    if (imported) {
      if (notes !== null) {
        writeFile(YOU, OVERFLOW_FILE, notes);
        main = linkFromEntry(main, OVERFLOW_FILE);
      }
      writeFile(YOU, ENTRY_FILE, main);
      sha = await commitAll(YOU, {
        subject: `Imported ${imported} ${imported === 1 ? "memory" : "memories"}`,
        body: secrets ? `Left out ${secrets} that looked like ${secrets === 1 ? "a secret" : "secrets"}.` : "",
        actor: "TOT",
        kind: "import",
      });
    }
    markDone();
    afterChange(YOU, sha ?? outside);
    return imported;
  });
}
