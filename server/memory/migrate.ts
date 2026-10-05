import type { Memory, MemoryImportStatus } from "../../shared/types.ts";
import { db } from "../db.ts";
import { memories } from "../data/memories.ts";
import { hideSecrets, secretKind } from "../trust/secrets.ts";
import { repoEntries } from "./index.ts";
import { importDone, importError, legacyRow, legacyRows, markImportDone, markRows, setImportError } from "./legacy.ts";
import { afterChange, ENTRY_FILE_BUDGET, OVERFLOW_FILE, remember } from "./memory.ts";
import {
  commitAll,
  commitOutsideEdits,
  discardChanges,
  ENTRY_FILE,
  entryText,
  formatEntry,
  initRepo,
  insertEntry,
  linkFromEntry,
  MemoryError,
  newId,
  promptSize,
  readFile,
  today,
  withRepo,
  writeFile,
  YOU,
} from "./repo.ts";

/**
 * The one-time import (roadmap module 10). Memories saved before memory became a git repo (the old `memories`
 * table, kept as `memories_legacy` by db.ts) become entries in the "you" repo: the newest in MEMORY.md, up to
 * its size as a prompt shows it (about 3500 characters), the rest in notes.md (linked from it), as one commit
 * "Imported N memories". Runs at startup until it lands (a failure is kept for Settings → Memory, and memory
 * reads the old rows meanwhile, legacy.ts); then does nothing. The old rows stay in `memories_legacy`. Rows that
 * look like secrets are left out and listed in Settings → Memory, to import anyway or drop.
 */

const sourceOf = (row: { conversation_id?: unknown; source?: unknown }) =>
  row.conversation_id ? `tot://c/${String(row.conversation_id)}` : row.source === "user" ? "you" : "tot";

/** Imports the old memories, once. Returns how many it imported (0 when there were none, or it already ran). */
export async function migrateMemories(): Promise<number> {
  if (importDone()) return 0;
  try {
    return await withRepo(YOU, async () => {
      if (importDone()) return 0;
      await initRepo(YOU);
      const outside = await commitOutsideEdits(YOU);
      try {
        const imported = await importRows();
        afterChange(YOU, imported.sha ?? outside);
        return imported.count;
      } catch (err) {
        // Nothing half-imported stays behind for the next commit to pick up; the next start tries again.
        await discardChanges(YOU).catch(() => {});
        if (outside) afterChange(YOU, outside);
        throw err;
      }
    });
  } catch (err) {
    setImportError(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/** The import itself, inside the "you" repo's turn. */
async function importRows(): Promise<{ count: number; sha: string | null }> {
  // A crash after the commit but before it was marked done: what's already there isn't imported twice.
  const entries = repoEntries(YOU);
  const present = new Set(entries.map((entry) => entry.text.toLowerCase()));
  const taken = new Set([...memories.ids(), ...entries.map((entry) => entry.id)]);
  const fresh: { row: string; id: string; text: string; line: string }[] = [];
  const already: string[] = [];
  const secrets: string[] = [];
  for (const row of legacyRows()) {
    if (row.import_state === "secret") continue;
    const text = entryText(String(row.content));
    if (text.length < 2) continue;
    if (present.has(text.toLowerCase())) {
      already.push(String(row.id));
      continue;
    }
    if (secretKind(text)) {
      secrets.push(String(row.id));
      continue;
    }
    present.add(text.toLowerCase());
    const id = newId(taken);
    taken.add(id);
    fresh.push({ row: String(row.id), id, text, line: formatEntry({ text, id, source: sourceOf(row), added: today(new Date(Number(row.created_at))) }) });
  }

  // The newest that fit go to MEMORY.md, the rest to notes.md; each file keeps them oldest first.
  const start = readFile(YOU, ENTRY_FILE) ?? "";
  const build = (items: typeof fresh) => items.reduce((content, item) => insertEntry(ENTRY_FILE, content, item.line), start);
  let cut = fresh.length;
  while (cut > 0 && promptSize(ENTRY_FILE, build(fresh.slice(cut - 1))) <= ENTRY_FILE_BUDGET) cut--;
  let main = build(fresh.slice(cut));
  let sha: string | null = null;
  if (fresh.length) {
    if (cut > 0) {
      writeFile(YOU, OVERFLOW_FILE, fresh.slice(0, cut).reduce<string | null>((content, item) => insertEntry(OVERFLOW_FILE, content, item.line), readFile(YOU, OVERFLOW_FILE)) ?? "");
      main = linkFromEntry(main, OVERFLOW_FILE);
    }
    writeFile(YOU, ENTRY_FILE, main);
    const left = secrets.length;
    sha = await commitAll(YOU, {
      subject: `Imported ${fresh.length} ${fresh.length === 1 ? "memory" : "memories"}`,
      body: left ? `Left out ${left} that looked like ${left === 1 ? "a secret" : "secrets"}; Settings → Memory lists ${left === 1 ? "it" : "them"}.` : "",
      actor: "TOT",
      kind: "import",
    });
  }
  db.exec("BEGIN");
  try {
    markRows([...fresh.map((item) => item.row), ...already], "imported");
    markRows(secrets, "secret");
    markImportDone();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { count: fresh.length, sha };
}

/** For Settings → Memory: whether the import landed, its last error, and the rows it left out. */
export function importStatus(): MemoryImportStatus {
  return {
    done: importDone(),
    error: importError(),
    skipped: legacyRows()
      .filter((row) => row.import_state === "secret")
      .map((row) => ({
        id: String(row.id),
        text: hideSecrets(String(row.content)),
        createdAt: Number(row.created_at),
        importable: secretKind(String(row.content)) !== "key",
      })),
  };
}

function skippedRow(id: string) {
  const row = legacyRow(id);
  if (!row || row.import_state !== "secret") throw new MemoryError("That memory isn't waiting to be imported.", 404);
  return row;
}

/** "Import anyway": the user says a left-out row isn't a secret. A key is still refused. */
export async function importSkipped(id: string): Promise<Memory> {
  const row = skippedRow(id);
  const text = entryText(String(row.content));
  if (secretKind(text) === "key") throw new MemoryError("That holds a key, and memory never stores keys. Drop it instead.");
  const { memory } = await remember({
    repo: YOU,
    text,
    source: sourceOf(row),
    actor: "you",
    added: today(new Date(Number(row.created_at))),
    allowPassword: true,
  });
  markRows([id], "imported");
  return memory;
}

/** "Drop": a left-out row is deleted for good (it looked like a secret, so it isn't kept anywhere). */
export function dropSkipped(id: string): void {
  skippedRow(id);
  db.prepare(`DELETE FROM memories_legacy WHERE id = ?`).run(id);
}
