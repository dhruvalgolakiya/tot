import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { MemoryCommit, MemoryCommitKind } from "../../shared/types.ts";
import { DATA_DIR } from "../config.ts";

/**
 * Memory repos (roadmap module 10): memory is git repos of markdown, following the open Agent Memory Repo spec
 * (github.com/AgentMemoryRepo/agentmemoryrepo), so it has history, merges and undo, and any agent can read it.
 * This module is the git and file layer: where repos live, the entry format, files, commits, history and undo.
 * Git runs on this machine through execFile (never on an agent's computer), and changes to one repo run one at a
 * time (`withRepo`), so parallel tasks never step on each other.
 *
 * An entry is one line: `- Prefers pnpm over npm [id: 3f2a9c; source: tot://c/<chat>; added: 2026-10-06]`. Any
 * `- ` line counts and the metadata is optional: a line someone wrote without an id gets a derived one ("h" + 5
 * hex of its path and text), never written back. `.gitattributes` merges markdown by union, so two devices
 * adding lines both keep theirs.
 */

export const MEMORY_DIR = join(DATA_DIR, "memory");
export const YOU = "you";
/** The entry point of every repo, loaded at the start of every chat. */
export const ENTRY_FILE = "MEMORY.md";

const ATTRIBUTES = "*.md merge=union\n";
/**
 * Every device starts its repo with the same first commit (files, author, date and message), so two devices'
 * repos share history and merge three-way from the start. Never change these.
 */
const GENESIS_DATE = "2026-10-01T00:00:00+0000";
const GENESIS_MESSAGE = "Start memory";
const STARTERS = {
  you: "# About you\n\nShort facts about the user, one per line, shared by every agent. Loaded at the start of every chat. Longer topics live in their own files, linked from here.\n",
  project:
    "# Project memory\n\nWhat agents learned working on this project, one fact per line: how to build, test and ship it, conventions, gotchas. Loaded at the start of every chat and task in the project.\n",
};

export class MemoryError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

// --- Repos ----------------------------------------------------------------------------------------------------

export const projectRepoId = (slug: string) => `projects/${slug}`;

export function isRepoId(value: unknown): value is string {
  return typeof value === "string" && (value === YOU || /^projects\/[a-z0-9][a-z0-9._-]{0,80}$/.test(value));
}

export function repoDir(repo: string): string {
  if (!isRepoId(repo)) throw new MemoryError(`There's no memory repo called "${repo}".`, 404);
  return join(MEMORY_DIR, ...repo.split("/"));
}

export const repoKind = (repo: string): "you" | "project" => (repo === YOU ? "you" : "project");
export const repoExists = (repo: string) => existsSync(join(repoDir(repo), ".git"));

// --- Git ------------------------------------------------------------------------------------------------------

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** Settings for every call, whatever the user's own git config says (signing, hooks, line endings). */
const CONFIG = [
  ["user.name", "TOT"],
  ["user.email", "tot@localhost"],
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
  ["core.hooksPath", "/dev/null"],
  ["core.quotepath", "false"],
  ["core.autocrlf", "false"],
  ["init.defaultBranch", "main"],
].flatMap(([key, value]) => ["-c", `${key}=${value}`]);

/**
 * Runs git in a folder. Local calls ignore the user's git config entirely; `remote` calls (the backup remote)
 * keep it, for their SSH keys and credential helpers, but never prompt.
 */
export function git(cwd: string, args: string[], opts: { remote?: boolean; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // GIT_DIR and friends from whatever started TOT must not point these calls at another repo.
    if (!key.startsWith("GIT_") || (opts.remote && (key === "GIT_SSH" || key === "GIT_SSH_COMMAND"))) env[key] = value;
  }
  if (!opts.remote) {
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = "/dev/null";
  } else if (!env.GIT_SSH && !env.GIT_SSH_COMMAND) {
    env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  }
  env.GIT_TERMINAL_PROMPT = "0";
  Object.assign(env, opts.env);
  return new Promise((resolve, reject) => {
    execFile("git", [...CONFIG, ...args], { cwd, env, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const code = typeof err.code === "number" ? err.code : null;
      const detail = String(stderr || err.message).trim().split("\n").slice(-3).join(" ");
      reject(new GitError(`git ${args[0]} failed: ${detail}`, code));
    });
  });
}

/** Whether `a` is already part of `b`'s history. */
export async function isAncestor(dir: string, a: string, b: string): Promise<boolean> {
  try {
    await git(dir, ["merge-base", "--is-ancestor", a, b]);
    return true;
  } catch (err) {
    if (err instanceof GitError && err.code === 1) return false;
    throw err;
  }
}

const queues = new Map<string, Promise<unknown>>();

/** Runs `fn` once every earlier change to the repo has finished: one writer per repo at a time. */
export function withRepo<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const before = queues.get(repo) ?? Promise.resolve();
  const run = before.then(fn, fn);
  const settled = run.catch(() => {});
  queues.set(repo, settled);
  void settled.then(() => {
    if (queues.get(repo) === settled) queues.delete(repo);
  });
  return run;
}

/** Makes the repo if it isn't there yet. Call inside `withRepo`. */
export async function initRepo(repo: string): Promise<void> {
  const dir = repoDir(repo);
  if (existsSync(join(dir, ".git"))) return;
  const genesis = { GIT_AUTHOR_DATE: GENESIS_DATE, GIT_COMMITTER_DATE: GENESIS_DATE };
  if (existsSync(dir)) {
    // A folder someone made by hand: it becomes a repo in place, their files kept (and committed next).
    await git(dir, ["init", "-q", "-b", "main"]);
    if (!existsSync(join(dir, ENTRY_FILE))) writeFileSync(join(dir, ENTRY_FILE), STARTERS[repoKind(repo)]);
    writeFileSync(join(dir, ".gitattributes"), ATTRIBUTES);
    await git(dir, ["add", ".gitattributes", ENTRY_FILE]);
    await git(dir, ["commit", "-q", "-m", GENESIS_MESSAGE, "-m", trailers("TOT", "start")], { env: genesis });
    return;
  }
  // Made beside it and moved into place, so a half-made repo never counts as one.
  const temp = `${dir}.init-${randomBytes(3).toString("hex")}`;
  mkdirSync(temp, { recursive: true });
  try {
    await git(temp, ["init", "-q", "-b", "main"]);
    writeFileSync(join(temp, ".gitattributes"), ATTRIBUTES);
    writeFileSync(join(temp, ENTRY_FILE), STARTERS[repoKind(repo)]);
    await git(temp, ["add", "-A"]);
    await git(temp, ["commit", "-q", "-m", GENESIS_MESSAGE, "-m", trailers("TOT", "start")], { env: genesis });
    mkdirSync(dirname(dir), { recursive: true });
    renameSync(temp, dir);
  } catch (err) {
    rmSync(temp, { recursive: true, force: true });
    throw err;
  }
}

export async function head(repo: string): Promise<string | null> {
  if (!repoExists(repo)) return null;
  return (await git(repoDir(repo), ["rev-parse", "HEAD"]).catch(() => "")).trim() || null;
}

export interface CommitMessage {
  subject: string;
  body?: string;
  /** Who made it: an agent's name, "you", "Dreaming"… */
  actor: string;
  kind: MemoryCommitKind;
}

const trailers = (actor: string, kind: MemoryCommitKind) => `TOT-Actor: ${actor.replace(/\s+/g, " ").trim() || "TOT"}\nTOT-Kind: ${kind}`;

/** One line, short enough for a commit subject. */
export const subjectText = (text: string, max = 72) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

export const messageArgs = (message: CommitMessage) => [
  "-m",
  subjectText(message.subject, 100),
  ...(message.body?.trim() ? ["-m", message.body.trim()] : []),
  "-m",
  trailers(message.actor, message.kind),
];

/** Commits everything in the working tree; returns the new head, or null when nothing changed. Call inside `withRepo`. */
export async function commitAll(repo: string, message: CommitMessage): Promise<string | null> {
  const dir = repoDir(repo);
  await git(dir, ["add", "-A"]);
  if (!(await git(dir, ["diff", "--cached", "--name-only"])).trim()) return null;
  await git(dir, ["commit", "-q", ...messageArgs(message)]);
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

/** Files someone changed by hand (or another agent through the spec) get their own commit before TOT's next one. */
export async function commitOutsideEdits(repo: string): Promise<string | null> {
  if (!(await git(repoDir(repo), ["status", "--porcelain"])).trim()) return null;
  return commitAll(repo, { subject: "Edited outside TOT", actor: "Outside TOT", kind: "outside" });
}

const KINDS = new Set<MemoryCommitKind>(["start", "import", "remember", "edit", "forget", "undo", "dream", "sync", "backup", "outside"]);
const RS = "\x1e";
const US = "\x1f";

/** Newest first. Merges show what they brought in (their diff against this device's side). */
export async function log(repo: string, limit = 50, skip = 0): Promise<MemoryCommit[]> {
  if (!repoExists(repo)) return [];
  const out = await git(repoDir(repo), [
    "log",
    `-n${limit}`,
    `--skip=${skip}`,
    `--format=${RS}%H${US}%P${US}%ct${US}%an${US}%s${US}%b${US}`,
    "--numstat",
    "--no-renames",
    "--diff-merges=first-parent",
  ]).catch(() => "");
  const commits: MemoryCommit[] = [];
  for (const record of out.split(RS).slice(1)) {
    const [sha, parents, time, author, subject, rawBody, stats = ""] = record.split(US);
    let actor = author || "TOT";
    let kind: MemoryCommitKind = "outside";
    const body: string[] = [];
    for (const line of (rawBody ?? "").split("\n")) {
      const trailer = /^TOT-(Actor|Kind):\s*(.*)$/.exec(line);
      if (!trailer) body.push(line);
      else if (trailer[1] === "Actor") actor = trailer[2]!.trim() || actor;
      else if (KINDS.has(trailer[2]!.trim() as MemoryCommitKind)) kind = trailer[2]!.trim() as MemoryCommitKind;
    }
    let added = 0;
    let removed = 0;
    for (const line of stats.split("\n")) {
      const [plus, minus] = line.split("\t");
      if (/^\d+$/.test(plus ?? "")) added += Number(plus);
      if (/^\d+$/.test(minus ?? "")) removed += Number(minus);
    }
    commits.push({
      sha: sha!,
      actor,
      kind,
      subject: subject ?? "",
      body: body.join("\n").trim(),
      at: Number(time) * 1000,
      added,
      removed,
      revertible: Boolean(parents?.trim()),
    });
  }
  return commits;
}

/**
 * Undoes one commit with a new commit. Markdown merges as plain text here (not by union), so an undo that
 * would collide with later changes is refused instead of quietly keeping both versions. Call inside `withRepo`.
 */
export async function revertCommit(repo: string, sha: string, message: CommitMessage): Promise<string> {
  const dir = repoDir(repo);
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new MemoryError("That isn't a commit.");
  const line = await git(dir, ["rev-list", "--parents", "-n1", sha]).catch(() => {
    throw new MemoryError("There's no such change in this memory.", 404);
  });
  const parents = line.trim().split(" ").slice(1);
  if (!parents.length) throw new MemoryError("That's where this memory starts; it can't be undone.");
  const info = join(dir, ".git", "info", "attributes");
  mkdirSync(dirname(info), { recursive: true });
  writeFileSync(info, "*.md merge=text\n");
  try {
    await git(dir, ["revert", "--no-commit", ...(parents.length > 1 ? ["-m", "1"] : []), sha]);
  } catch {
    await git(dir, ["revert", "--abort"]).catch(() => git(dir, ["reset", "--hard", "-q", "HEAD"]));
    throw new MemoryError("Later changes touched the same lines, so this can't be undone on its own.", 409);
  } finally {
    rmSync(info, { force: true });
  }
  const committed = await commitAll(repo, message);
  if (!committed) throw new MemoryError("Nothing to undo: those changes are already gone.", 409);
  return committed;
}

/**
 * Brings another copy's history in (a paired device's, the backup remote's): a fast-forward when this side has
 * nothing new, else a merge (unless `fastForwardOnly`: then it waits, `diverged`). Markdown merges by union; any
 * other file that conflicts keeps this device's version. Returns whether the head moved, and the files kept.
 * Call inside `withRepo`.
 */
export async function mergeRef(
  repo: string,
  ref: string,
  message: CommitMessage,
  { fastForwardOnly = false } = {},
): Promise<{ changed: boolean; kept: string[]; diverged: boolean }> {
  const dir = repoDir(repo);
  if (await isAncestor(dir, ref, "HEAD")) return { changed: false, kept: [], diverged: false };
  if (await isAncestor(dir, "HEAD", ref)) {
    await git(dir, ["merge", "--ff-only", "-q", ref]);
    return { changed: true, kept: [], diverged: false };
  }
  if (fastForwardOnly) return { changed: false, kept: [], diverged: true };
  try {
    await git(dir, ["merge", "--no-ff", "--no-edit", "-q", "--allow-unrelated-histories", "-X", "ours", ...messageArgs(message), ref]);
    return { changed: true, kept: [], diverged: false };
  } catch {
    const kept = (await git(dir, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
    if (!kept.length) {
      await git(dir, ["merge", "--abort"]).catch(() => {});
      throw new GitError("The merge failed.", null);
    }
    for (const file of kept) await git(dir, ["checkout", "--ours", "--", file]).catch(() => git(dir, ["rm", "-q", "-f", "--", file]));
    await git(dir, ["add", "-A"]);
    const body = [message.body, `Kept this device's version of: ${kept.join(", ")}`].filter(Boolean).join("\n");
    await git(dir, ["commit", "-q", ...messageArgs({ ...message, body })]);
    console.warn(`[tot] memory merge in ${repo} kept this device's version of ${kept.length} file(s)`);
    return { changed: true, kept, diverged: false };
  }
}

// --- Files ----------------------------------------------------------------------------------------------------

/** A file path inside a repo, normalized ("notes/work.md"); refuses anything that could leave it. */
export function safePath(path: string): string {
  const clean = path.trim().replace(/^\.\//, "");
  const parts = clean.split("/");
  if (
    !clean ||
    clean.length > 200 ||
    clean.includes("\\") ||
    clean.includes("\0") ||
    parts.length > 5 ||
    parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))
  ) {
    throw new MemoryError(`"${path}" isn't a file name memory can use. Use something like "preferences.md" or "work/clients.md".`);
  }
  return parts.join("/");
}

/** A file to write entries to: markdown, with ".md" added when it's missing. */
export function markdownPath(path: string): string {
  const clean = safePath(path.replace(/^\[\[|\]\]$/g, ""));
  return /\.md$/i.test(clean) ? clean : `${clean}.md`;
}

function within(dir: string, full: string): boolean {
  try {
    const root = realpathSync(dir);
    const real = realpathSync(full);
    return real === root || real.startsWith(root + sep);
  } catch {
    return false;
  }
}

export function readFile(repo: string, path: string): string | null {
  const dir = repoDir(repo);
  const full = join(dir, ...safePath(path).split("/"));
  if (!existsSync(full) || !within(dir, full) || !lstatSync(full).isFile()) return null;
  return readFileSync(full, "utf8");
}

/** Writes a file in the working tree (commit it after). Call inside `withRepo`. */
export function writeFile(repo: string, path: string, content: string): void {
  const dir = repoDir(repo);
  const full = join(dir, ...safePath(path).split("/"));
  mkdirSync(dirname(full), { recursive: true });
  if (existsSync(full) && !within(dir, full)) throw new MemoryError(`"${path}" isn't a file memory can write.`);
  writeFileSync(full, content);
}

export function removeFile(repo: string, path: string): void {
  const dir = repoDir(repo);
  const full = join(dir, ...safePath(path).split("/"));
  if (existsSync(full) && within(dir, full)) rmSync(full);
}

/** Every file in the repo, MEMORY.md first, then by path. Hidden files and links are skipped. */
export function listFiles(repo: string): string[] {
  const dir = repoDir(repo);
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (folder: string, prefix: string, depth: number) => {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      if (item.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory() && depth < 4) walk(join(folder, item.name), rel, depth + 1);
      else if (item.isFile()) found.push(rel);
    }
  };
  walk(dir, "", 0);
  return found.sort((a, b) => (a === ENTRY_FILE ? -1 : b === ENTRY_FILE ? 1 : a.localeCompare(b)));
}

/** "[[preferences]]", "preferences", "billing/q.sql" → the file it names, or null. */
export function resolveLink(repo: string, link: string): string | null {
  const name = link.trim().replace(/^\[\[|\]\]$/g, "").replace(/\|.*$/, "").trim();
  if (!name) return null;
  const files = listFiles(repo);
  const lower = name.toLowerCase();
  const candidates = /\.[a-z0-9]+$/i.test(name) ? [lower] : [lower, `${lower}.md`];
  return (
    files.find((file) => candidates.includes(file.toLowerCase())) ??
    files.find((file) => candidates.some((c) => file.toLowerCase().endsWith(`/${c}`))) ??
    null
  );
}

/** The `[[links]]` in some markdown. */
export const linksIn = (content: string) => [...new Set([...content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((m) => m[1]!.trim()))];

// --- Entries --------------------------------------------------------------------------------------------------

export interface Entry {
  id: string;
  text: string;
  /** "tot://c/<chat>" (an agent in that chat or task), "you", "dreaming", "tot"; null when the line has none. */
  source: string | null;
  /** YYYY-MM-DD. */
  added: string | null;
  /** The line has no id of its own: `id` is derived from its path and text. */
  derived: boolean;
  path: string;
  /** Index of its line in the file. */
  line: number;
  indent: string;
  bullet: string;
}

const ENTRY_LINE = /^(\s*)([-*])\s+(.*\S)\s*$/;
const META = /\s*\[([^[\]]*)\]\s*$/;
const META_KEYS = new Set(["id", "source", "added"]);
export const ENTRY_ID = /^[0-9a-f]{6}$/;

export const derivedId = (path: string, text: string) => `h${createHash("sha1").update(`${path}\n${text}`).digest("hex").slice(0, 5)}`;

export const today = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/** Splits the trailing `[id: …; source: …; added: …]` off a line, when it has one. */
function splitMeta(rest: string): { text: string; meta: Record<string, string> | null } {
  const match = META.exec(rest);
  if (!match) return { text: rest, meta: null };
  const meta: Record<string, string> = {};
  for (const part of match[1]!.split(";")) {
    const colon = part.indexOf(":");
    if (colon <= 0) continue;
    const key = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (META_KEYS.has(key) && value) meta[key] = value;
  }
  if (!Object.keys(meta).length) return { text: rest, meta: null };
  return { text: rest.slice(0, match.index).trimEnd(), meta };
}

/** Every entry in a markdown file. Front matter and fenced code are skipped. */
export function parseEntries(path: string, content: string): Entry[] {
  const lines = content.split("\n");
  let skipUntil = -1;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && index < 60 && line.trim() === "---");
    if (end > 0) skipUntil = end;
  }
  const entries: Entry[] = [];
  let fence = false;
  lines.forEach((raw, index) => {
    if (index <= skipUntil) return;
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      return;
    }
    if (fence) return;
    const match = ENTRY_LINE.exec(raw);
    if (!match) return;
    const { text, meta } = splitMeta(match[3]!);
    if (!text) return;
    const own = meta?.id && ENTRY_ID.test(meta.id) ? meta.id : null;
    entries.push({
      id: own ?? derivedId(path, text),
      derived: !own,
      text,
      source: meta?.source ?? null,
      added: meta?.added && /^\d{4}-\d{2}-\d{2}$/.test(meta.added) ? meta.added : null,
      path,
      line: index,
      indent: match[1]!,
      bullet: match[2]!,
    });
  });
  return entries;
}

/** One line of text, as an entry holds it. */
export const entryText = (text: string) => text.replace(/\s+/g, " ").trim();

export function formatEntry(entry: Pick<Entry, "text" | "id" | "source" | "added"> & { indent?: string; bullet?: string }): string {
  const meta = [`id: ${entry.id}`, entry.source && `source: ${entry.source}`, entry.added && `added: ${entry.added}`].filter(Boolean).join("; ");
  return `${entry.indent ?? ""}${entry.bullet ?? "-"} ${entryText(entry.text)} [${meta}]`;
}

/** A fresh id, unused by `taken`. */
export function newId(taken: Set<string>): string {
  for (;;) {
    const id = randomBytes(3).toString("hex");
    if (!taken.has(id)) return id;
  }
}

/** A heading for a new topic file: "work/clients.md" → "# Clients". */
export function titleFor(path: string): string {
  const base = path.split("/").pop()!.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim();
  return `# ${base.charAt(0).toUpperCase()}${base.slice(1)}`;
}

/** Adds an entry's line after the file's last entry, else before a "See also:" line, else at the end (a new file starts with a heading). */
export function insertEntry(path: string, content: string | null, line: string): string {
  if (content === null || !content.trim()) return `${titleFor(path)}\n\n${line}\n`;
  const lines = content.replace(/\s*$/, "").split("\n");
  const last = parseEntries(path, content).at(-1);
  if (last) {
    lines.splice(last.line + 1, 0, line);
  } else {
    const seeAlso = lines.findIndex((text) => /^See also:/i.test(text.trim()));
    if (seeAlso >= 0) lines.splice(seeAlso, 0, line, "");
    else lines.push("", line);
  }
  return `${lines.join("\n")}\n`;
}

/** MEMORY.md links every topic file: adds `[[name]]` to its "See also:" line when it isn't linked yet. */
export function linkFromEntry(entryContent: string, path: string): string {
  const name = path.replace(/\.md$/i, "");
  if (path === ENTRY_FILE || linksIn(entryContent).some((link) => link.toLowerCase() === name.toLowerCase() || link.toLowerCase() === path.toLowerCase())) {
    return entryContent;
  }
  const lines = entryContent.replace(/\s*$/, "").split("\n");
  const at = lines.findIndex((line) => /^See also:/i.test(line.trim()));
  if (at >= 0) lines[at] = `${lines[at]!.trimEnd()} · [[${name}]]`;
  else lines.push("", `See also: [[${name}]]`);
  return `${lines.join("\n")}\n`;
}
