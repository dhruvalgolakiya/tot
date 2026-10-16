import type { Memory, MemoryCommit, MemoryFile, MemoryFileContent, Project } from "../../shared/types.ts";
import { appEvents } from "../app-events.ts";
import { memories } from "../data/memories.ts";
import { projects } from "../projects/projects.ts";
import { hideSecrets, secretKind } from "../trust/secrets.ts";
import { reindex, repoEntries } from "./index.ts";
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
  listFiles,
  log,
  markdownPath,
  MemoryError,
  newId,
  projectRepoId,
  promptSize,
  readFile,
  repoChanged,
  repoExists,
  revertCommit,
  subjectText,
  today,
  withRepo,
  writeFile,
  YOU,
  type CommitMessage,
  type Entry,
} from "./repo.ts";

/**
 * Reading and changing memory (roadmap module 10). Every change waits its repo's turn, is refused when it looks
 * like a secret, and lands as one commit, or not at all (a refused change leaves nothing behind); then the index
 * is rebuilt and a `memory` event goes out (screens refresh; paired devices pull "you" when they hear it, see
 * sync.ts). Agents and the user change memory the same way, so the history says who did what.
 */

export const SECRET_REFUSAL = "That looks like a secret; memory never stores secrets.";
/**
 * MEMORY.md is loaded whole into every chat: past this size (as the prompt shows it, entries without their
 * metadata) new entries go to notes.md instead.
 */
export const ENTRY_FILE_BUDGET = 3500;
export const OVERFLOW_FILE = "notes.md";
const MAX_ENTRY_CHARS = 1000;

/**
 * Anything shaped like a key, holding one of TOT's own secrets (GitHub tokens, API keys, mailbox passwords, device
 * tokens), or a password written out after "password is" (trust/secrets.ts).
 */
export const looksLikeSecret = (text: string) => secretKind(text) !== null;

/** Refuses a secret. `allowPassword`: the user said to keep this one (a key is refused anyway). */
export function assertNoSecret(text: string, { allowPassword = false } = {}): void {
  const kind = secretKind(text);
  if (kind === "key" || (kind && !allowPassword)) throw new MemoryError(SECRET_REFUSAL);
}

/** Entry text for a commit subject: quoted and short, or hidden when it looks like a secret. */
export const quoted = (text: string, max = 72) => (looksLikeSecret(text) ? "(text hidden)" : `“${subjectText(hideSecrets(text), max)}”`);

/** The project a "projects/<slug>" repo belongs to. */
export function projectOf(repo: string): Project | null {
  if (!repo.startsWith("projects/")) return null;
  const slug = repo.slice("projects/".length);
  return [...projects.list(), ...projects.list({ archived: true })].find((project) => project.slug === slug) ?? null;
}

/** A repo id from the outside (a route, a tool): "you", or a project's repo by id, slug or "projects/<slug>". */
export function resolveRepo(value: string | null | undefined): string {
  const ref = (value ?? "").trim();
  if (!ref || ref === YOU) return YOU;
  const project = projectOf(ref) ?? projects.get(ref) ?? projects.resolve(ref);
  if (!project) throw new MemoryError(`There's no memory repo "${ref}".`, 404);
  return projectRepoId(project.slug);
}

/** Rebuilds the index (and, module 11, the wiki pages' index) and tells everyone the repo moved on. */
export function afterChange(repo: string, sha: string | null): void {
  reindex(repo);
  repoChanged(repo, sha);
  appEvents.publish({ type: "memory", repo, sha });
}

/**
 * One change: in the repo's turn, on a repo that exists, after committing anything edited by hand; then one
 * commit (unless `message` returns null) and the index. Everything that changes a repo goes through here or
 * through sync/dreaming, which hold the same turn.
 */
export async function change<T>(repo: string, run: () => T | Promise<T>, message: (result: T) => CommitMessage | null): Promise<{ result: T; sha: string | null }> {
  return withRepo(repo, async () => {
    const existed = repoExists(repo);
    await initRepo(repo);
    const outside = await commitOutsideEdits(repo);
    if (outside || !existed) reindex(repo);
    let result: T;
    let sha: string | null;
    try {
      result = await run();
      const msg = message(result);
      sha = msg ? await commitAll(repo, msg) : null;
    } catch (err) {
      // Refused (a secret, an unknown id, a file it can't write), maybe halfway: whatever it wrote goes, so a
      // change that reports failure never lands later. Hand edits were committed before it started.
      await discardChanges(repo).catch(() => {});
      if (outside || !existed) afterChange(repo, outside);
      throw err;
    }
    if (sha || outside || !existed) afterChange(repo, sha ?? outside);
    return { result, sha };
  });
}

/** Makes the repo if it isn't there yet. */
export async function ensureRepo(repo: string): Promise<void> {
  if (repoExists(repo)) return;
  await change(repo, () => null, () => null);
}

/** Every id in use (the index, plus this repo's lines with derived ids), so a new one is unique. */
const takenIds = (repo: string) => new Set([...memories.ids(), ...repoEntries(repo).map((entry) => entry.id)]);

/** Whether MEMORY.md (as the prompt shows it) has room for one more line. */
export const entryFileFits = (content: string, line: string) => promptSize(ENTRY_FILE, insertEntry(ENTRY_FILE, content, line)) <= ENTRY_FILE_BUDGET;

/** Where a new entry goes when no file was named: MEMORY.md while it's short, else notes.md. */
function defaultFile(repo: string, line: string): string {
  return entryFileFits(readFile(repo, ENTRY_FILE) ?? "", line) ? ENTRY_FILE : OVERFLOW_FILE;
}

const sameText = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

function cleanEntryText(text: string, opts: { allowPassword?: boolean } = {}): string {
  const clean = entryText(text ?? "");
  if (clean.length < 2) throw new MemoryError("Memory can't be empty.");
  if (clean.length > MAX_ENTRY_CHARS) throw new MemoryError(`Keep an entry under ${MAX_ENTRY_CHARS} characters; put longer notes in a topic file.`);
  assertNoSecret(clean, opts);
  return clean;
}

export interface RememberInput {
  repo: string;
  text: string;
  /** A topic file ("preferences.md"); defaults to MEMORY.md, or notes.md once MEMORY.md is full. */
  file?: string | null;
  /** "tot://c/<chat>", "you", "dreaming". */
  source: string;
  /** Who's remembering: an agent's name, or "you". */
  actor: string;
  /** When it was first said (an old memory imported late); today by default. */
  added?: string;
  /** The user chose to keep this one although it reads like a password (never a key). */
  allowPassword?: boolean;
}

/** Adds an entry (one commit). An entry with the same text already in the repo comes back instead. */
export async function remember(input: RememberInput): Promise<{ memory: Memory; duplicate: boolean }> {
  const text = cleanEntryText(input.text, { allowPassword: input.allowPassword });
  const requested = input.file?.trim() ? markdownPath(input.file) : null;
  const { result } = await change(
    input.repo,
    () => {
      const existing = repoEntries(input.repo).find((entry) => sameText(entry.text, text));
      if (existing) return { id: existing.key, created: false };
      const id = newId(takenIds(input.repo));
      const line = formatEntry({ text, id, source: input.source, added: input.added ?? today() });
      const path = requested ?? defaultFile(input.repo, line);
      writeFile(input.repo, path, insertEntry(path, readFile(input.repo, path), line));
      if (path !== ENTRY_FILE) writeFile(input.repo, ENTRY_FILE, linkFromEntry(readFile(input.repo, ENTRY_FILE) ?? "", path));
      return { id, created: true };
    },
    (made) => (made.created ? { subject: `${input.actor}: remember ${quoted(text)}`, actor: input.actor, kind: "remember" } : null),
  );
  const memory = memories.get(result.id, [input.repo]);
  if (!memory) throw new MemoryError("Couldn't save that to memory.");
  return { memory, duplicate: !result.created };
}

/** Removes lines from files (by path and line index), bottom up so the indexes stay right. */
function removeLines(repo: string, entries: Entry[]): void {
  const byPath = new Map<string, number[]>();
  for (const entry of entries) byPath.set(entry.path, [...(byPath.get(entry.path) ?? []), entry.line]);
  for (const [path, indexes] of byPath) {
    const lines = (readFile(repo, path) ?? "").split("\n");
    for (const index of [...indexes].sort((a, b) => b - a)) lines.splice(index, 1);
    writeFile(repo, path, lines.join("\n").replace(/\n+$/, "\n"));
  }
}

/** The index's entry for a key, in the first of the repos given that has it. */
function indexed(key: string, repos: string[]): Memory {
  const found = memories.get(key, repos);
  if (!found) throw new MemoryError(`No memory with id ${key}.`, 404);
  return found;
}

/**
 * The line a key names now. A line without an id of its own (its id derived from its text) must still say what
 * the index said, so a key never reaches some other line that happens to share it.
 */
function entryFor(repo: string, key: string, seen: string): Entry {
  const entry = repoEntries(repo).find((candidate) => candidate.key === key);
  if (!entry || (entry.derived && entry.text !== seen)) throw new MemoryError(`No memory with id ${key}.`, 404);
  return entry;
}

/**
 * Rewrites one entry's line (by its key: with the same id on two lines, each is edited on its own). A line
 * someone wrote without an id gets one now. `expected`: the text the editor started from; when the entry says
 * something else by now (a sync, an agent), the edit is refused (409) rather than overwriting it.
 */
export async function edit(input: { repos: string[]; id: string; text: string; actor: string; expected?: string }): Promise<Memory> {
  const text = cleanEntryText(input.text);
  const found = indexed(input.id, input.repos);
  const repo = found.repo;
  const { result } = await change(
    repo,
    () => {
      const entry = entryFor(repo, input.id, found.content);
      if (input.expected !== undefined && entry.text !== entryText(input.expected)) {
        throw new MemoryError(`This memory changed meanwhile; it now says “${subjectText(hideSecrets(entry.text), 120)}”. Edit it again.`, 409);
      }
      if (entry.text === text) return { key: entry.key, changed: false };
      const id = entry.derived ? newId(takenIds(repo)) : entry.id;
      const content = (readFile(repo, entry.path) ?? "").split("\n");
      content[entry.line] = formatEntry({ ...entry, text, id, added: entry.added ?? today() });
      writeFile(repo, entry.path, content.join("\n"));
      return { key: entry.derived ? id : entry.key, changed: true };
    },
    (made) => (made.changed ? { subject: `${input.actor}: edit ${quoted(text)}`, actor: input.actor, kind: "edit" } : null),
  );
  const memory = memories.get(result.key, [repo]);
  if (!memory) throw new MemoryError(`No memory with id ${input.id}.`, 404);
  return memory;
}

/** Removes one entry's line (by its key). Returns what it said. */
export async function forget(input: { repos: string[]; id: string; actor: string }): Promise<{ repo: string; text: string }> {
  const found = indexed(input.id, input.repos);
  const repo = found.repo;
  const { result } = await change(
    repo,
    () => {
      const entry = entryFor(repo, input.id, found.content);
      removeLines(repo, [entry]);
      return entry.text;
    },
    (text) => ({ subject: `${input.actor}: forget ${quoted(text)}`, actor: input.actor, kind: "forget" }),
  );
  return { repo, text: result };
}

/** A file's text. */
export function readMemoryFile(repo: string, path: string): MemoryFileContent | null {
  const content = repoExists(repo) ? readFile(repo, path) : null;
  return content === null ? null : { path, content };
}

/** The repo's files with their entries, MEMORY.md first. */
export function repoFiles(repo: string): MemoryFile[] {
  const byPath = new Map<string, Memory[]>();
  for (const memory of memories.list(repo)) byPath.set(memory.path, [...(byPath.get(memory.path) ?? []), memory]);
  return listFiles(repo).map((path) => {
    const markdown = /\.md$/i.test(path);
    return { path, markdown, chars: readFile(repo, path)?.length ?? 0, entries: byPath.get(path) ?? [] };
  });
}

export const history = (repo: string, limit = 50, skip = 0): Promise<MemoryCommit[]> => log(repo, limit, skip);

/** Undoes one change with a new commit. */
export async function undo(repo: string, sha: string, actor = "you"): Promise<MemoryCommit> {
  const target = (await log(repo, 500)).find((commit) => commit.sha.startsWith(sha));
  if (!target) throw new MemoryError("There's no such change in this memory.", 404);
  // Module 11: moving a wiki into git (its pages imported in one commit) isn't undone wholesale.
  if (!target.revertible && target.kind === "import") {
    throw new MemoryError("Moving the wiki into git can't be undone; restore a page's earlier version from its history instead.");
  }
  await withRepo(repo, async () => {
    await initRepo(repo);
    const outside = await commitOutsideEdits(repo);
    const made = await revertCommit(repo, target.sha, { subject: `${actor}: undo ${quoted(target.subject, 90)}`, actor, kind: "undo" }).catch((err) => {
      if (outside) afterChange(repo, outside);
      throw err;
    });
    afterChange(repo, made);
  });
  return (await log(repo, 1))[0]!;
}
