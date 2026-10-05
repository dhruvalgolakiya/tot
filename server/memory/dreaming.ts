import type { MemoryDreamState } from "../../shared/types.ts";
import { defaultComplete, type Complete } from "../agent/wiki-keeper.ts";
import { db, parseJson, type Row } from "../db.ts";
import { settings } from "../data/settings.ts";
import { memories } from "../data/memories.ts";
import { knownRepos, repoEntries } from "./index.ts";
import { afterChange, assertNoSecret, ensureRepo, looksLikeSecret, projectOf } from "./memory.ts";
import {
  commitAll,
  commitOutsideEdits,
  ENTRY_FILE,
  entryText,
  formatEntry,
  head,
  initRepo,
  insertEntry,
  linkFromEntry,
  listFiles,
  markdownPath,
  MemoryError,
  newId,
  readFile,
  subjectText,
  today,
  withRepo,
  writeFile,
  type Entry,
} from "./repo.ts";

/**
 * Dreaming (roadmap module 10): a nightly pass over each memory repo that merges duplicates, drops stale entries,
 * settles contradictions and notes patterns, with the wiki keeper's light model. It runs at
 * `memory.dreaming.time` (03:30 local by default), only for repos that changed or had chats since their last
 * dream; "Dream now" runs it at once. The model answers with JSON operations, which are checked (known ids only,
 * no secrets, never more than 40% of the entries removed, nothing edited meanwhile) and applied as one commit, so
 * undoing a dream is one revert.
 */

export type DreamOp =
  | { op: "merge"; ids: string[]; text: string; file?: string }
  | { op: "update"; id: string; text: string }
  | { op: "delete"; id: string; reason: string }
  | { op: "add"; file: string; text: string; source?: string }
  | { op: "move"; id: string; file: string };

export interface DreamResult {
  /** "Merged 3, removed 2, added 1", or "Nothing to tidy". */
  summary: string;
  sha: string | null;
  applied: DreamOp[];
  refused: { op: unknown; reason: string }[];
}

const MAX_OPS = 30;
const FILES_BUDGET = 30_000;
const MESSAGES_BUDGET = 20_000;
const MAX_REMOVED_SHARE = 0.4;
const TICK_MS = 60_000;
/** A missed night (TOT was off at 03:30) still dreams if TOT starts within this long after. */
const CATCH_UP_MS = 6 * 60 * 60_000;
const STATE_KEY = "memoryDreams";

const SYSTEM = `You tidy the long-term memory of TOT, an AI agent app: a git repo of short markdown entries, one fact per line, that every agent reads at the start of a chat. You're given the repo's files and what the user said in chats since the last tidy-up. Propose a few careful operations, then reply with JSON only.`;

const INSTRUCTIONS = `Operations (use only ids shown above):
- {"op": "merge", "ids": ["<id>", "<id>"], "text": "...", "file": "<optional: where the merged entry goes>"} — entries that say the same thing, or two versions of one fact, become one.
- {"op": "update", "id": "<id>", "text": "..."} — an entry that's out of date, or contradicted by something the user said later.
- {"op": "delete", "id": "<id>", "reason": "..."} — an entry that's stale, wrong, a one-off detail, or a secret.
- {"op": "add", "file": "MEMORY.md", "text": "...", "source": "tot://c/<chat id>"} — a durable fact or pattern the user's messages show that memory lacks.
- {"op": "move", "id": "<id>", "file": "preferences.md"} — an entry that belongs in a topic file.

Rules:
- Be conservative: when in doubt, leave an entry alone. Never remove more than a third of the entries.
- One short fact per entry, written about the user (or, in a project's memory, about the project), not about a chat.
- Keep MEMORY.md short: it's loaded in every chat. Details belong in topic files (any name ending in .md).
- Never copy passwords, tokens, keys or other secrets; delete any entry that holds one.
- At most ${MAX_OPS} operations; usually far fewer. If memory is already tidy, return none.

Reply with JSON only:
{"ops": [...], "notes": "<one line: what you did and why>"}`;

// --- State ------------------------------------------------------------------------------------------------------

interface RepoDream {
  lastAt: number | null;
  /** The repo's head after the last dream: a different head means it changed since. */
  head: string | null;
  summary: string | null;
  sha: string | null;
  error: string | null;
}

interface DreamsState {
  repos: Record<string, RepoDream>;
  /** The local day of the last nightly run, "YYYY-MM-DD". */
  night: string | null;
}

function readState(): DreamsState {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(STATE_KEY) as Row | undefined;
  const stored = parseJson<Partial<DreamsState>>(row?.value, {});
  return { repos: stored.repos ?? {}, night: stored.night ?? null };
}

function saveState(update: (state: DreamsState) => void): void {
  const state = readState();
  update(state);
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(STATE_KEY, JSON.stringify(state));
}

const running = new Set<string>();

export function dreamState(repo: string): MemoryDreamState {
  const saved = readState().repos[repo];
  return { running: running.has(repo), lastAt: saved?.lastAt ?? null, summary: saved?.summary ?? null, sha: saved?.sha ?? null, error: saved?.error ?? null };
}

// --- The prompt -------------------------------------------------------------------------------------------------

/** The repo's markdown files, with every entry's id visible (lines without one get theirs shown). */
function renderFiles(repo: string, entries: Entry[]): string {
  const derived = new Map(entries.filter((entry) => entry.derived).map((entry) => [`${entry.path}:${entry.line}`, entry.id]));
  const blocks: string[] = [];
  let used = 0;
  for (const path of listFiles(repo).filter((file) => /\.md$/i.test(file))) {
    const lines = (readFile(repo, path) ?? "").split("\n").map((line, index) => {
      const id = derived.get(`${path}:${index}`);
      return id ? `${line.trimEnd()} [id: ${id}]` : line;
    });
    const block = `<file path="${path}">\n${lines.join("\n").trim()}\n</file>`;
    if (used + block.length > FILES_BUDGET) {
      blocks.push(`<file path="${path}">(left out: memory is longer than this tidy-up can read)</file>`);
      continue;
    }
    used += block.length;
    blocks.push(block);
  }
  return blocks.join("\n\n");
}

/** What the user said since `since` (in the project's chats, for a project repo), newest kept within budget. */
function userMessages(repo: string, since: number): string {
  const project = projectOf(repo);
  const rows = db
    .prepare(
      `SELECT m.parts, m.created_at, m.conversation_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.role = 'user' AND m.created_at > ? ${project ? "AND c.project_id = ?" : ""}
       ORDER BY m.created_at DESC LIMIT 500`,
    )
    .all(...(project ? [since, project.id] : [since])) as Row[];
  const picked: string[] = [];
  let used = 0;
  for (const row of rows) {
    const text = parseJson<{ type: string; text?: string }[]>(row.parts, [])
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text!.trim())
      .join("\n")
      .slice(0, 2000);
    if (!text) continue;
    const line = `[${today(new Date(Number(row.created_at)))} · tot://c/${row.conversation_id}] ${text}`;
    if (used + line.length > MESSAGES_BUDGET) break;
    used += line.length;
    picked.push(line);
  }
  return picked.reverse().join("\n\n");
}

const hasChatsSince = (repo: string, since: number) => {
  const project = projectOf(repo);
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.role = 'user' AND m.created_at > ? ${project ? "AND c.project_id = ?" : ""} LIMIT 1`,
      )
      .get(...(project ? [since, project.id] : [since])),
  );
};

export function buildDreamPrompt(repo: string, entries: Entry[], since: number): string {
  const project = projectOf(repo);
  const what = project ? `the memory of the project "${project.name}" (what agents learned working on it)` : "the memory about the user (what they told their agents)";
  const said = userMessages(repo, since);
  return `This is ${what}, ${entries.length} entries.

<memory>
${renderFiles(repo, entries) || "(empty)"}
</memory>

<user-messages since="${since ? today(new Date(since)) : "the start"}">
${said || "(none)"}
</user-messages>

${INSTRUCTIONS}`;
}

// --- Checking and applying ---------------------------------------------------------------------------------------

/** Pulls the operations out of the model's reply (tolerates code fences and stray prose). */
export function parseOps(raw: string): unknown[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Dreaming's reply had no JSON.");
  const parsed = JSON.parse(raw.slice(start, end + 1)) as { ops?: unknown };
  if (!Array.isArray(parsed.ops)) throw new Error("Dreaming's reply had no list of operations.");
  return parsed.ops;
}

const str = (value: unknown) => (typeof value === "string" ? value : "");
const SOURCE = /^(tot:\/\/c\/[\w-]+|you|dreaming)$/;

/**
 * Checks proposed operations against the repo's entries now. Each bad operation is refused on its own (an
 * unknown id, a secret, an entry edited since the model read it, an id used twice); a plan that would remove
 * more than 40% of the entries is refused whole.
 */
export function checkOps(entries: Entry[], raw: unknown[], seen?: Map<string, string>): { ops: DreamOp[]; refused: DreamResult["refused"]; problem: string | null } {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const used = new Set<string>();
  const ops: DreamOp[] = [];
  const refused: DreamResult["refused"] = [];
  const texts = new Set(entries.map((entry) => entry.text.toLowerCase()));
  const refuse = (op: unknown, reason: string) => refused.push({ op, reason });
  for (const item of raw.slice(0, MAX_OPS)) {
    const v = (item ?? {}) as Record<string, unknown>;
    try {
      const ids = v.op === "merge" ? (Array.isArray(v.ids) ? v.ids.map(str) : []) : v.op === "add" ? [] : [str(v.id)];
      for (const id of ids) {
        if (!byId.has(id)) throw new MemoryError(`Unknown id "${id}".`);
        if (used.has(id)) throw new MemoryError(`Id ${id} is in two operations.`);
        // Edited (by the user, a chat or a sync) while the model was thinking: never overwrite that.
        if (seen && seen.get(id) !== byId.get(id)!.text) throw new MemoryError(`Entry ${id} changed meanwhile.`);
      }
      const text = () => {
        const clean = entryText(str(v.text));
        if (clean.length < 2) throw new MemoryError("No text.");
        if (clean.length > 1000) throw new MemoryError("Text too long.");
        assertNoSecret(clean);
        return clean;
      };
      let op: DreamOp;
      if (v.op === "merge") {
        if (new Set(ids).size < 2 || new Set(ids).size !== ids.length) throw new MemoryError("A merge needs two or more different ids.");
        op = { op: "merge", ids, text: text(), ...(str(v.file) ? { file: markdownPath(str(v.file)) } : {}) };
      } else if (v.op === "update") {
        op = { op: "update", id: ids[0]!, text: text() };
      } else if (v.op === "delete") {
        op = { op: "delete", id: ids[0]!, reason: entryText(str(v.reason)).slice(0, 200) || "stale" };
      } else if (v.op === "add") {
        const added = text();
        if (texts.has(added.toLowerCase())) throw new MemoryError("Already in memory.");
        texts.add(added.toLowerCase());
        op = { op: "add", file: markdownPath(str(v.file) || ENTRY_FILE), text: added, source: SOURCE.test(str(v.source)) ? str(v.source) : "dreaming" };
      } else if (v.op === "move") {
        const file = markdownPath(str(v.file));
        if (file === byId.get(ids[0]!)!.path) throw new MemoryError("It's already there.");
        op = { op: "move", id: ids[0]!, file };
      } else {
        throw new MemoryError(`Unknown operation "${str(v.op)}".`);
      }
      for (const id of ids) used.add(id);
      ops.push(op);
    } catch (err) {
      refuse(item, err instanceof Error ? err.message : String(err));
    }
  }
  const removed = ops.reduce((sum, op) => sum + (op.op === "delete" ? 1 : op.op === "merge" ? op.ids.length - 1 : 0), 0);
  const allowed = Math.max(1, Math.floor(entries.length * MAX_REMOVED_SHARE));
  const problem =
    removed > allowed ? `That would remove ${removed} of ${entries.length} entries; Dreaming never removes more than ${MAX_REMOVED_SHARE * 100}%.` : null;
  return { ops, refused, problem };
}

const phrase = (n: number, verb: string) => `${verb} ${n}`;

/** "Merged 3, removed 2, added 1". */
export function summarize(ops: DreamOp[]): string {
  const count = (kind: DreamOp["op"]) => ops.filter((op) => op.op === kind).length;
  const parts = [
    count("merge") && phrase(count("merge"), "merged"),
    count("delete") && phrase(count("delete"), "removed"),
    count("update") && phrase(count("update"), "updated"),
    count("add") && phrase(count("add"), "added"),
    count("move") && phrase(count("move"), "moved"),
  ].filter(Boolean) as string[];
  if (!parts.length) return "Nothing to tidy";
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const quote = (text: string) => (looksLikeSecret(text) ? "(text hidden)" : `“${subjectText(text, 90)}”`);

/** Applies checked operations to the files (inside the repo's turn); returns the commit body's lines. */
function applyOps(repo: string, entries: Entry[], ops: DreamOp[]): string[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const taken = new Set([...memories.ids(), ...entries.map((entry) => entry.id)]);
  /** Per file: lines to replace (or remove, with null), and new lines to add. */
  const edits = new Map<string, Map<number, string | null>>();
  const adds = new Map<string, string[]>();
  const replace = (entry: Entry, line: string | null) => {
    if (!edits.has(entry.path)) edits.set(entry.path, new Map());
    edits.get(entry.path)!.set(entry.line, line);
  };
  const add = (path: string, line: string) => adds.set(path, [...(adds.get(path) ?? []), line]);
  /** The entry as a line again: its own id kept, a derived one swapped for a real one. */
  const rewrite = (entry: Entry, text: string) => {
    const id = entry.derived ? newId(taken) : entry.id;
    taken.add(id);
    return formatEntry({ text, id, source: entry.source, added: entry.added ?? today(), indent: entry.indent, bullet: entry.bullet });
  };
  const details: string[] = [];
  for (const op of ops) {
    if (op.op === "delete") {
      const entry = byId.get(op.id)!;
      replace(entry, null);
      details.push(`- removed ${op.id}: ${quote(entry.text)} (${op.reason})`);
    } else if (op.op === "update") {
      const entry = byId.get(op.id)!;
      replace(entry, rewrite(entry, op.text));
      details.push(`- updated ${op.id}: ${quote(entry.text)} → ${quote(op.text)}`);
    } else if (op.op === "merge") {
      const [first, ...rest] = op.ids.map((id) => byId.get(id)!);
      if (op.file && op.file !== first!.path) {
        replace(first!, null);
        add(op.file, rewrite({ ...first!, indent: "", bullet: "-" }, op.text));
      } else {
        replace(first!, rewrite(first!, op.text));
      }
      for (const entry of rest) replace(entry, null);
      details.push(`- merged ${op.ids.join(", ")} → ${quote(op.text)}`);
    } else if (op.op === "move") {
      const entry = byId.get(op.id)!;
      replace(entry, null);
      add(op.file, rewrite({ ...entry, indent: "", bullet: "-" }, entry.text));
      details.push(`- moved ${op.id} to ${op.file}`);
    } else {
      const id = newId(taken);
      taken.add(id);
      add(op.file, formatEntry({ text: op.text, id, source: op.source ?? "dreaming", added: today() }));
      details.push(`- added to ${op.file}: ${quote(op.text)}`);
    }
  }
  for (const [path, changes] of edits) {
    const lines = (readFile(repo, path) ?? "").split("\n");
    writeFile(repo, path, lines.flatMap((line, index) => (changes.has(index) ? (changes.get(index) === null ? [] : [changes.get(index)!]) : [line])).join("\n"));
  }
  for (const [path, lines] of adds) {
    let content = readFile(repo, path);
    for (const line of lines) content = insertEntry(path, content, line);
    writeFile(repo, path, content!);
    if (path !== ENTRY_FILE) writeFile(repo, ENTRY_FILE, linkFromEntry(readFile(repo, ENTRY_FILE) ?? "", path));
  }
  return details;
}

/** One dream over one repo. `complete` is the model (the keeper's light one by default; tests pass a fake). */
export async function dream(repo: string, complete: Complete = defaultComplete): Promise<DreamResult> {
  if (running.has(repo)) throw new MemoryError("Already dreaming about this memory.", 409);
  running.add(repo);
  try {
    await ensureRepo(repo);
    const since = readState().repos[repo]?.lastAt ?? 0;
    const entries = repoEntries(repo);
    const seen = new Map(entries.map((entry) => [entry.id, entry.text]));
    const raw = entries.length || hasChatsSince(repo, since) ? parseOps(await complete(buildDreamPrompt(repo, entries, since), SYSTEM)) : [];

    const result = await withRepo(repo, async (): Promise<DreamResult> => {
      await initRepo(repo);
      const outside = await commitOutsideEdits(repo);
      const now = repoEntries(repo);
      const { ops, refused, problem } = checkOps(now, raw, seen);
      if (problem) {
        if (outside) afterChange(repo, outside);
        throw new MemoryError(problem);
      }
      const details = ops.length ? applyOps(repo, now, ops) : [];
      const summary = summarize(ops);
      const body = [...details, refused.length ? `Skipped ${refused.length} that didn't check out: ${refused.map((r) => r.reason).join(" ")}` : ""].filter(Boolean).join("\n");
      const sha = ops.length ? await commitAll(repo, { subject: `Dreaming: ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`, body, actor: "Dreaming", kind: "dream" }) : null;
      if (sha || outside) afterChange(repo, sha ?? outside);
      return { summary, sha, applied: ops, refused };
    });
    const after = await head(repo);
    saveState((state) => (state.repos[repo] = { lastAt: Date.now(), head: after, summary: result.summary, sha: result.sha, error: null }));
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    saveState((state) => (state.repos[repo] = { ...(state.repos[repo] ?? { lastAt: null, head: null, summary: null, sha: null }), error }));
    throw err;
  } finally {
    running.delete(repo);
  }
}

/** Whether a repo changed, or had chats, since its last dream. */
async function due(repo: string): Promise<boolean> {
  const saved = readState().repos[repo];
  if (!saved?.lastAt) return memories.count(repo) > 0 || hasChatsSince(repo, 0);
  return (await head(repo)) !== saved.head || hasChatsSince(repo, saved.lastAt);
}

/** Dreams over one repo, or every repo that's due, one after another. Errors are kept in each repo's state. */
export async function dreamAll(repos?: string[], complete?: Complete): Promise<void> {
  const list = repos ?? knownRepos();
  for (const repo of list) {
    if (!repos && !(await due(repo).catch(() => false))) continue;
    await dream(repo, complete).catch((err) => console.warn(`[tot] dreaming about ${repo} failed:`, err instanceof Error ? err.message : err));
  }
}

let timer: NodeJS.Timeout | null = null;

/** Every minute: past tonight's time (and within the catch-up window), dream once. */
async function tick(now = new Date()): Promise<void> {
  const { enabled, dreaming } = settings.get().memory;
  if (!enabled || !dreaming.enabled) return;
  const [hours, minutes] = dreaming.time.split(":").map(Number);
  const at = new Date(now);
  at.setHours(hours ?? 3, minutes ?? 30, 0, 0);
  const night = today(now);
  if (now < at || now.getTime() - at.getTime() > CATCH_UP_MS || readState().night === night) return;
  saveState((state) => (state.night = night));
  await dreamAll();
}

export const dreaming = {
  start(): void {
    if (timer) return;
    timer = setInterval(() => void tick().catch(() => {}), TICK_MS);
    timer.unref();
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },

  /** "Dream now": in the background; a `memory` event follows when it changed something. */
  now(repo?: string): void {
    if (repo && running.has(repo)) throw new MemoryError("Already dreaming about this memory.", 409);
    void dreamAll(repo ? [repo] : undefined);
  },
};
