import type { Memory, MemoryCommit, MemoryFile, MemoryFileContent, Project } from "../../shared/types.ts";
import { appEvents } from "../app-events.ts";
import { getSecret, secretValues } from "../config.ts";
import { memories } from "../data/memories.ts";
import { redactGitHubTokens } from "../github.ts";
import { projects } from "../projects/projects.ts";
import { SECRET_SHAPES } from "../trust/secrets.ts";
import { reindex, repoEntries } from "./index.ts";
import {
  commitAll,
  commitOutsideEdits,
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
  readFile,
  repoExists,
  revertCommit,
  today,
  withRepo,
  writeFile,
  YOU,
  type CommitMessage,
  type Entry,
} from "./repo.ts";

/**
 * Reading and changing memory (roadmap module 10). Every change waits its repo's turn, is refused when it looks
 * like a secret, and lands as one commit; then the index is rebuilt and a `memory` event goes out (screens
 * refresh; paired devices pull "you" when they hear it, see sync.ts). Agents and the user change memory the same
 * way, so the history says who did what.
 */

export const SECRET_REFUSAL = "That looks like a secret; memory never stores secrets.";
/** MEMORY.md is loaded whole into every chat: past this size new entries go to notes.md instead. */
export const ENTRY_FILE_BUDGET = 3500;
export const OVERFLOW_FILE = "notes.md";
const MAX_ENTRY_CHARS = 1000;

/** "My password is …" and the like, which no key shape catches. */
const PASSWORD_LIKE = /\b(password|passwd|passcode|pin code|api[ _-]?key|secret key|access token|private key)\s*(is|:|=)\s*\S{4,}/i;

/** Anything shaped like a key, or holding one of TOT's own secrets (GitHub tokens, API keys, mailbox passwords, device tokens). */
export function looksLikeSecret(text: string): boolean {
  if (redactGitHubTokens(text) !== text || PASSWORD_LIKE.test(text)) return true;
  if (SECRET_SHAPES.some((shape) => new RegExp(shape.source).test(text))) return true;
  return [...secretValues(""), getSecret("anthropicApiKey"), getSecret("boatApiKey")].some((secret) => secret && secret.length >= 8 && text.includes(secret));
}

export function assertNoSecret(text: string): void {
  if (looksLikeSecret(text)) throw new MemoryError(SECRET_REFUSAL);
}

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

/** Rebuilds the index and tells everyone the repo moved on. */
export function afterChange(repo: string, sha: string | null): void {
  reindex(repo);
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
    try {
      result = await run();
    } catch (err) {
      // Refused (a secret, an unknown id): nothing of ours changed, but hand edits were committed.
      if (outside || !existed) afterChange(repo, outside);
      throw err;
    }
    const msg = message(result);
    const sha = msg ? await commitAll(repo, msg) : null;
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

/** Where a new entry goes when no file was named: MEMORY.md while it's short, else notes.md. */
function defaultFile(repo: string, line: string): string {
  const current = readFile(repo, ENTRY_FILE) ?? "";
  return current.length + line.length + 1 <= ENTRY_FILE_BUDGET ? ENTRY_FILE : OVERFLOW_FILE;
}

const sameText = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

function cleanEntryText(text: string): string {
  const clean = entryText(text ?? "");
  if (clean.length < 2) throw new MemoryError("Memory can't be empty.");
  if (clean.length > MAX_ENTRY_CHARS) throw new MemoryError(`Keep an entry under ${MAX_ENTRY_CHARS} characters; put longer notes in a topic file.`);
  assertNoSecret(clean);
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
}

/** Adds an entry (one commit). An entry with the same text already in the repo comes back instead. */
export async function remember(input: RememberInput): Promise<{ memory: Memory; duplicate: boolean }> {
  const text = cleanEntryText(input.text);
  const requested = input.file?.trim() ? markdownPath(input.file) : null;
  const { result } = await change(
    input.repo,
    () => {
      const existing = repoEntries(input.repo).find((entry) => sameText(entry.text, text));
      if (existing) return { id: existing.id, created: false };
      const id = newId(takenIds(input.repo));
      const line = formatEntry({ text, id, source: input.source, added: today() });
      const path = requested ?? defaultFile(input.repo, line);
      writeFile(input.repo, path, insertEntry(path, readFile(input.repo, path), line));
      if (path !== ENTRY_FILE) writeFile(input.repo, ENTRY_FILE, linkFromEntry(readFile(input.repo, ENTRY_FILE) ?? "", path));
      return { id, created: true };
    },
    (made) => (made.created ? { subject: `${input.actor}: remember ${text}`, actor: input.actor, kind: "remember" } : null),
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

/** The repo (of those given, in order) whose index has this id. */
function repoWith(id: string, repos: string[]): string {
  const found = memories.get(id, repos);
  if (!found) throw new MemoryError(`No memory with id ${id}.`, 404);
  return found.repo;
}

/**
 * Rewrites an entry. The same id on several lines (two devices edited it) collapses into this one. A line
 * someone wrote without an id gets one now.
 */
export async function edit(input: { repos: string[]; id: string; text: string; actor: string }): Promise<Memory> {
  const text = cleanEntryText(input.text);
  const repo = repoWith(input.id, input.repos);
  const { result } = await change(
    repo,
    () => {
      const lines = repoEntries(repo).filter((entry) => entry.id === input.id);
      const last = lines.at(-1);
      if (!last) throw new MemoryError(`No memory with id ${input.id}.`, 404);
      if (lines.length === 1 && last.text === text) return { id: last.id, changed: false };
      const id = last.derived ? newId(takenIds(repo)) : last.id;
      const content = (readFile(repo, last.path) ?? "").split("\n");
      content[last.line] = formatEntry({ ...last, text, id, added: last.added ?? today() });
      writeFile(repo, last.path, content.join("\n"));
      removeLines(repo, lines.slice(0, -1));
      return { id, changed: true };
    },
    (made) => (made.changed ? { subject: `${input.actor}: edit ${text}`, actor: input.actor, kind: "edit" } : null),
  );
  const memory = memories.get(result.id, [repo]);
  if (!memory) throw new MemoryError(`No memory with id ${input.id}.`, 404);
  return memory;
}

/** Removes an entry (every line with its id). Returns what it said. */
export async function forget(input: { repos: string[]; id: string; actor: string }): Promise<{ repo: string; text: string }> {
  const repo = repoWith(input.id, input.repos);
  const { result } = await change(
    repo,
    () => {
      const lines = repoEntries(repo).filter((entry) => entry.id === input.id);
      if (!lines.length) throw new MemoryError(`No memory with id ${input.id}.`, 404);
      removeLines(repo, lines);
      return lines.at(-1)!.text;
    },
    (text) => ({ subject: `${input.actor}: forget ${text}`, actor: input.actor, kind: "forget" }),
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
  await withRepo(repo, async () => {
    await initRepo(repo);
    const outside = await commitOutsideEdits(repo);
    const made = await revertCommit(repo, target.sha, { subject: `${actor}: undo “${target.subject}”`, actor, kind: "undo" }).catch((err) => {
      if (outside) afterChange(repo, outside);
      throw err;
    });
    afterChange(repo, made);
  });
  return (await log(repo, 1))[0]!;
}
