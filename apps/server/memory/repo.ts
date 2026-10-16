import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import type { MemoryCommit, MemoryCommitKind } from "@tot/shared/types";
import { DATA_DIR } from "../config.ts";
import { mergeEntries } from "./merge.ts";

/**
 * Memory repos (roadmap module 10): memory is git repos of markdown, following the open Agent Memory Repo spec
 * (github.com/AgentMemoryRepo/agentmemoryrepo), so it has history, merges and undo, and any agent can read it.
 * This module is the git and file layer: where repos live, the entry format, files, commits, history and undo.
 * Git runs on this machine through execFile (never on an agent's computer), and changes to one repo run one at a
 * time (`withRepo`), so parallel tasks never step on each other.
 *
 * An entry is one line: `- Prefers pnpm over npm [id: 3f2a9c1b; source: tot://c/<chat>; added: 2026-10-06]`. Any
 * `- ` line counts and the metadata is optional: a line someone wrote without an id gets a derived one ("h" + 10
 * hex of its path and text), never written back. Copies of a repo merge entry by entry, in this process (merge.ts):
 * a delete on one device survives the other's additions. Git's own merge machinery only runs for undo.
 */

export const MEMORY_DIR = join(DATA_DIR, "memory");
export const YOU = "you";
/** The entry point of every repo, loaded at the start of every chat. */
export const ENTRY_FILE = "MEMORY.md";

/** The committed `.gitattributes` (part of the first commit, so it can't change). TOT merges in process instead. */
const ATTRIBUTES = "*.md merge=union\n";
/**
 * `.git/info/attributes`, which outranks any `.gitattributes` (a synced one included): files are stored and
 * checked out byte for byte, and undo's revert merges as plain text, so a revert that collides is refused.
 */
const LOCAL_ATTRIBUTES = "* -text -filter -ident -working-tree-encoding merge=text\n";
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
  // Module 11: a brain that isn't a project's (an agent's notebook, a shared brain) keeps its wiki in a repo of its own.
  brain: "# Brain\n\nThis brain's wiki, kept by TOT: one markdown page per file in pages/, a repo's docs in repos/<name>/.\n",
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
/** Module 11: the repo of a brain that isn't a project's (its wiki pages only; memory never lists it). */
export const brainRepoId = (brainId: string) => `brains/${brainId}`;

export function isRepoId(value: unknown): value is string {
  return typeof value === "string" && (value === YOU || /^(projects|brains)\/[a-z0-9][a-z0-9._-]{0,80}$/.test(value));
}

export function repoDir(repo: string): string {
  if (!isRepoId(repo)) throw new MemoryError(`There's no memory repo called "${repo}".`, 404);
  return join(MEMORY_DIR, ...repo.split("/"));
}

export const repoKind = (repo: string): "you" | "project" | "brain" => (repo === YOU ? "you" : repo.startsWith("brains/") ? "brain" : "project");

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}
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
  // The user's own ignore file must not hide topic files.
  ["core.excludesFile", "/dev/null"],
  // Objects from another device or the remote are checked before they're kept.
  ["transfer.fsckObjects", "true"],
].flatMap(([key, value]) => ["-c", `${key}=${value}`]);

/** How many git processes TOT has running now (a lock file is only stale when none is). */
let running = 0;

/**
 * Runs git in a folder. Local calls ignore the user's git config entirely; `remote` calls (the backup remote)
 * keep it, for their SSH keys and credential helpers, but never prompt.
 */
function gitEnv(opts: { remote?: boolean; env?: Record<string, string> }): NodeJS.ProcessEnv {
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
  return env;
}

/**
 * Module 11: git for a quick read that has to answer synchronously (a wiki page's history, behind the synchronous
 * `wiki.*` API). Reads only: changes always go through `git` inside `withRepo`.
 */
export function gitSync(cwd: string, args: string[], opts: { input?: string } = {}): Buffer {
  try {
    return execFileSync("git", [...CONFIG, ...args], { cwd, env: gitEnv({}), timeout: 30_000, maxBuffer: 256 * 1024 * 1024, input: opts.input ?? "", stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
    const code = (err as { status?: number | null }).status ?? null;
    throw new GitError(`git ${args[0]} failed: ${(stderr || (err instanceof Error ? err.message : String(err))).trim().split("\n").slice(-3).join(" ")}`, code);
  }
}

export function git(cwd: string, args: string[], opts: { remote?: boolean; env?: Record<string, string>; timeoutMs?: number; input?: string } = {}): Promise<string> {
  const env = gitEnv(opts);
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile("git", [...CONFIG, ...args], { cwd, env, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        running--;
        if (!err) return resolve(stdout);
        const code = typeof err.code === "number" ? err.code : null;
        const detail = String(stderr || err.message).trim().split("\n").slice(-3).join(" ");
        reject(new GitError(`git ${args[0]} failed: ${detail}`, code));
      });
    } catch (err) {
      // Some spawn failures (a folder that's a file) throw rather than call back.
      return reject(new GitError(`git ${args[0]} failed: ${err instanceof Error ? err.message : String(err)}`, null));
    }
    running++;
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input ?? "");
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

/** Puts back this device's own git settings for a repo (`.git/info/attributes`), whatever was there. */
function ensureLocalSettings(dir: string): void {
  const info = join(dir, ".git", "info", "attributes");
  if (existsSync(info) && readFileSync(info, "utf8") === LOCAL_ATTRIBUTES) return;
  mkdirSync(dirname(info), { recursive: true });
  rmSync(info, { force: true });
  writeFileSync(info, LOCAL_ATTRIBUTES);
}

/** Makes the repo if it isn't there yet. Call inside `withRepo`. */
export async function initRepo(repo: string): Promise<void> {
  const dir = repoDir(repo);
  if (existsSync(join(dir, ".git"))) return ensureLocalSettings(dir);
  const genesis = { GIT_AUTHOR_DATE: GENESIS_DATE, GIT_COMMITTER_DATE: GENESIS_DATE };
  if (existsSync(dir)) {
    // A folder someone made by hand: it becomes a repo in place, their files kept (and committed next).
    await git(dir, ["init", "-q", "-b", "main"]);
    ensureLocalSettings(dir);
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
    ensureLocalSettings(temp);
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

/** Called after a repo changed (a commit, a merge, an undo), once memory reindexed it: module 11's wiki reindexes its pages. */
type RepoChangeHook = (repo: string, sha: string | null) => void;
const changeHooks: RepoChangeHook[] = [];

export function onRepoChange(hook: RepoChangeHook): void {
  changeHooks.push(hook);
}

export function repoChanged(repo: string, sha: string | null): void {
  for (const hook of changeHooks) {
    try {
      hook(repo, sha);
    } catch (err) {
      console.warn(`[tot] after a change to ${repo}:`, err instanceof Error ? err.message : err);
    }
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
  /** More `TOT-…: …` trailer lines (module 11's wiki pages record which pages a commit changed). */
  trailers?: string[];
}

const trailers = (actor: string, kind: MemoryCommitKind, more: string[] = []) =>
  [`TOT-Actor: ${actor.replace(/\s+/g, " ").trim() || "TOT"}`, `TOT-Kind: ${kind}`, ...more.map((line) => line.replace(/[\r\n]+/g, " "))].join("\n");

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
  trailers(message.actor, message.kind, message.trailers),
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

/**
 * Puts the working tree back as the last commit has it, after a change failed halfway: nothing of a refused change
 * stays behind to be committed later. Safe because every change commits hand edits first. Call inside `withRepo`.
 */
export async function discardChanges(repo: string): Promise<void> {
  const dir = repoDir(repo);
  await git(dir, ["reset", "-q", "--hard", "HEAD"]);
  await git(dir, ["clean", "-q", "-f", "-d"]);
}

/** A lock file older than this, with no git of TOT's running, was left by a crash. */
const LOCK_STALE_MS = 60_000;

/** Every repo folder on this device: "you", each project's, and (module 11) each other brain's. */
function repoDirsOnDisk(): string[] {
  const dirs = [join(MEMORY_DIR, YOU)];
  for (const group of ["projects", "brains"]) {
    const groupDir = join(MEMORY_DIR, group);
    if (!existsSync(groupDir)) continue;
    for (const item of readdirSync(groupDir, { withFileTypes: true })) if (item.isDirectory()) dirs.push(join(groupDir, item.name));
  }
  return dirs.filter((dir) => existsSync(join(dir, ".git")));
}

/**
 * At startup, before any change: what a crash left behind. A stale `.git/index.lock` would refuse every commit
 * from then on; an interrupted undo leaves a half-done revert; and this device's git settings are put back.
 * Returns what it fixed.
 */
export async function recoverRepos(now = Date.now()): Promise<string[]> {
  const fixed: string[] = [];
  for (const dir of repoDirsOnDisk()) {
    const meta = join(dir, ".git");
    const lock = lstatOrNull(join(meta, "index.lock"));
    if (lock && now - lock.mtimeMs > LOCK_STALE_MS && running === 0) {
      rmSync(join(meta, "index.lock"), { force: true });
      fixed.push(`${dir}: a stale index.lock`);
    }
    rmSync(join(meta, MERGE_INDEX), { force: true });
    if (["REVERT_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD"].some((name) => existsSync(join(meta, name)))) {
      await git(dir, ["reset", "-q", "--merge"]).catch(() => git(dir, ["reset", "-q", "--hard", "HEAD"]));
      rmSync(join(meta, "sequencer"), { recursive: true, force: true });
      fixed.push(`${dir}: an interrupted undo`);
    }
    ensureLocalSettings(dir);
  }
  return fixed;
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
    // Module 11: a commit that can't be undone on its own (moving a wiki into git) says so.
    let locked = false;
    const body: string[] = [];
    for (const line of (rawBody ?? "").split("\n")) {
      const trailer = /^TOT-(Actor|Kind):\s*(.*)$/.exec(line);
      // Other TOT trailers (module 11's TOT-Page, TOT-Change…) are for TOT, not for reading.
      if (!trailer) {
        if (/^TOT-Undo:\s*no\s*$/.test(line)) locked = true;
        else if (!/^TOT-[\w-]+:/.test(line)) body.push(line);
      } else if (trailer[1] === "Actor") actor = trailer[2]!.trim() || actor;
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
      // Not the first commit, and not a merge: undoing a sync would drop what the other device brought in.
      revertible: !locked && (parents?.trim().split(" ").filter(Boolean).length ?? 0) === 1,
    });
  }
  return commits;
}

/**
 * Undoes one commit with a new commit. Markdown merges as plain text here (`.git/info/attributes`), so an undo
 * that would collide with later changes is refused instead of quietly keeping both versions. A merge (a sync, the
 * backup) can't be undone: it would take out what the other device brought in. Call inside `withRepo`.
 */
export async function revertCommit(repo: string, sha: string, message: CommitMessage): Promise<string> {
  const dir = repoDir(repo);
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new MemoryError("That isn't a commit.");
  const line = await git(dir, ["rev-list", "--parents", "-n1", sha]).catch(() => {
    throw new MemoryError("There's no such change in this memory.", 404);
  });
  const parents = line.trim().split(" ").slice(1);
  if (!parents.length) throw new MemoryError("That's where this memory starts; it can't be undone.");
  if (parents.length > 1) throw new MemoryError("A sync brings in another device's changes; it can't be undone. Undo those changes one by one instead.");
  ensureLocalSettings(dir);
  try {
    await git(dir, ["revert", "--no-commit", sha]);
  } catch {
    await git(dir, ["revert", "--abort"]).catch(() => git(dir, ["reset", "--hard", "-q", "HEAD"]));
    throw new MemoryError("Later changes touched the same lines, so this can't be undone on its own.", 409);
  }
  const committed = await commitAll(repo, message);
  if (!committed) throw new MemoryError("Nothing to undo: those changes are already gone.", 409);
  return committed;
}

/** A file in a commit's tree. */
interface TreeItem {
  mode: string;
  sha: string;
}

/** The temporary index a merge builds its tree in (inside .git, so it's never part of the repo). */
const MERGE_INDEX = "tot-merge.index";

async function treeOf(dir: string, rev: string | null): Promise<Map<string, TreeItem>> {
  const items = new Map<string, TreeItem>();
  if (!rev) return items;
  for (const record of (await git(dir, ["ls-tree", "-r", "-z", "--full-tree", rev])).split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, , sha] = record.slice(0, tab).split(" ");
    items.set(record.slice(tab + 1), { mode: mode!, sha: sha! });
  }
  return items;
}

/** What a memory repo holds: markdown, SQL and plain text, as regular files (no links, scripts or submodules). */
const MEMORY_FILE = /\.(md|markdown|sql|txt)$/i;
const MARKDOWN = /\.(md|markdown)$/i;

function isMemoryFile(path: string, item: TreeItem): boolean {
  if ((item.mode !== "100644" && item.mode !== "100755") || !MEMORY_FILE.test(path)) return false;
  try {
    return safePath(path) === path;
  } catch {
    return false;
  }
}

const sameItem = (a: TreeItem | undefined, b: TreeItem | undefined) => a?.sha === b?.sha && a?.mode === b?.mode;

/**
 * Brings another copy's history in (a paired device's, the backup remote's), merging in this process: markdown
 * entry by entry against the merge base (merge.ts); any other file both changed keeps this device's version.
 * Nothing but memory files comes in: links, scripts, submodules and dotfiles (`.gitattributes`, `.gitignore`)
 * from the other side are left out. A fast-forward when this side has nothing new and nothing was left out;
 * else a merge commit (unless `fastForwardOnly`: then it waits, `diverged`). Call inside `withRepo`, on a clean
 * working tree.
 */
export async function mergeRef(
  repo: string,
  ref: string,
  message: CommitMessage,
  { fastForwardOnly = false } = {},
): Promise<{ changed: boolean; kept: string[]; dropped: string[]; diverged: boolean }> {
  const dir = repoDir(repo);
  const ours = (await git(dir, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  const theirs = (await git(dir, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
  if (await isAncestor(dir, theirs, ours)) return { changed: false, kept: [], dropped: [], diverged: false };
  const forward = await isAncestor(dir, ours, theirs);
  if (!forward && fastForwardOnly) return { changed: false, kept: [], dropped: [], diverged: true };
  const base = forward ? ours : (await git(dir, ["merge-base", ours, theirs]).catch(() => "")).trim() || null;
  const [was, mine, other] = await Promise.all([treeOf(dir, base), treeOf(dir, ours), treeOf(dir, theirs)]);

  const result = new Map<string, TreeItem>();
  const kept: string[] = [];
  const dropped: string[] = [];
  const blob = (sha: string) => git(dir, ["cat-file", "blob", sha]);
  for (const path of new Set([...was.keys(), ...mine.keys(), ...other.keys()])) {
    const b = was.get(path);
    const o = mine.get(path);
    const t = other.get(path);
    let pick: TreeItem | undefined;
    if ((t && !isMemoryFile(path, t)) || (!t && b && !isMemoryFile(path, b))) {
      // Never taken from another copy: this device's stays as it is.
      if (t && !sameItem(t, o) && !sameItem(t, b)) dropped.push(path);
      pick = o;
    } else if (sameItem(o, t) || sameItem(t, b)) {
      pick = o;
    } else if (sameItem(o, b)) {
      pick = t;
    } else if (!o || !t) {
      // Deleted on one side, changed on the other: the change wins.
      pick = o ?? t;
    } else if (MARKDOWN.test(path)) {
      const [baseText, oursText, theirsText] = await Promise.all([b ? blob(b.sha) : "", blob(o.sha), blob(t.sha)]);
      const merged = mergeEntries(baseText, oursText, theirsText, (content) => parseEntries(path, content));
      pick = { mode: o.mode, sha: (await git(dir, ["hash-object", "-w", "--no-filters", "--stdin"], { input: merged })).trim() };
    } else {
      kept.push(path);
      pick = o;
    }
    if (pick) result.set(path, pick);
  }

  const sameAsTheirs = result.size === other.size && [...result].every(([path, item]) => sameItem(item, other.get(path)));
  if (forward && sameAsTheirs) {
    await git(dir, ["merge", "--ff-only", "-q", theirs]);
    return { changed: true, kept, dropped, diverged: false };
  }
  const notes = [
    message.body,
    kept.length ? `Kept this device's version of: ${kept.join(", ")}` : "",
    dropped.length ? `Left out what isn't memory: ${dropped.join(", ")}` : "",
  ].filter(Boolean);
  const index = join(dir, ".git", MERGE_INDEX);
  try {
    const env = { GIT_INDEX_FILE: index };
    await git(dir, ["read-tree", "--empty"], { env });
    const info = [...result].map(([path, item]) => `${item.mode} blob ${item.sha}\t${path}\0`).join("");
    if (info) await git(dir, ["update-index", "-z", "--index-info"], { env, input: info });
    const tree = (await git(dir, ["write-tree"], { env })).trim();
    const commit = (await git(dir, ["commit-tree", tree, "-p", ours, "-p", theirs, ...messageArgs({ ...message, body: notes.join("\n") })])).trim();
    // The merge's first parent is this head, so moving to it is a fast-forward that updates the files.
    await git(dir, ["merge", "--ff-only", "-q", commit]);
  } finally {
    rmSync(index, { force: true });
  }
  if (kept.length || dropped.length) console.warn(`[tot] memory merge in ${repo} kept this device's version of ${kept.length} file(s) and left out ${dropped.length}`);
  return { changed: true, kept, dropped, diverged: false };
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

/**
 * Module 11: a project's knowledge repo also holds its wiki, pages in pages/ and each repo's docs in repos/<name>/.
 * Those are documents, not facts: memory's entries, files list and Dreaming leave them out.
 */
export const DOCUMENT_DIRS = ["pages", "repos"];
export const isDocumentPath = (path: string) => DOCUMENT_DIRS.includes(path.split("/")[0]!.toLowerCase());

/** A file to write entries to: markdown, with ".md" added when it's missing; plain names only. */
export function markdownPath(path: string): string {
  const clean = safePath(path.replace(/^\[\[|\]\]$/g, ""));
  if (isDocumentPath(clean)) throw new MemoryError(`"${path}" is where the wiki's pages live; put facts in another file, like "notes.md".`);
  const name = clean.split("/").at(-1)!;
  if (!/\.md$/i.test(name) && /\.[a-z]{1,5}$/i.test(name)) {
    throw new MemoryError(`"${path}" isn't a markdown file. Memory topics are markdown, like "preferences.md".`);
  }
  const named = /\.md$/i.test(clean) ? clean : `${clean}.md`;
  if (named.length > 120 || named.split("/").some((part) => !/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,79}$/u.test(part))) {
    throw new MemoryError(`"${path}" isn't a file name memory can use. Use letters, digits, spaces, "-" and "_", like "work/clients.md".`);
  }
  return named;
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

/**
 * Where a file in a repo is, checked step by step: every folder below the repo must be a real folder (a link to
 * somewhere else is refused), made one at a time when `create`. Null when a folder is missing and not `create`.
 */
function placeIn(repo: string, path: string, create: boolean): string | null {
  const dir = repoDir(repo);
  const parts = safePath(path).split("/");
  let current = dir;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    let info = lstatOrNull(current);
    if (!info) {
      if (!create) return null;
      mkdirSync(current);
      info = lstatSync(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new MemoryError(`"${path}" isn't a file memory can write: "${part}" isn't a folder in this memory.`);
  }
  if (!within(dir, current)) throw new MemoryError(`"${path}" isn't a file memory can write.`);
  return join(current, parts.at(-1)!);
}

/**
 * Writes a file in the working tree (commit it after), never through a link: an existing file must be a plain
 * file of its own, and a new one is made with O_EXCL, neither following a link. Call inside `withRepo`.
 */
export function writeFile(repo: string, path: string, content: string): void {
  const full = placeIn(repo, path, true)!;
  const info = lstatOrNull(full);
  if (info && (!info.isFile() || info.nlink > 1)) throw new MemoryError(`"${path}" isn't a file memory can write: it's a link or a folder.`);
  const flags = info ? constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const fd = openSync(full, flags, 0o644);
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

export function removeFile(repo: string, path: string): void {
  const full = placeIn(repo, path, false);
  if (full && lstatOrNull(full)?.isFile()) unlinkSync(full);
}

/**
 * Every file in the repo, MEMORY.md first, then by path. Hidden files and links are skipped, and so are the wiki's
 * pages (pages/, repos/; module 11) unless `documents`.
 */
export function listFiles(repo: string, { documents = false }: { documents?: boolean } = {}): string[] {
  const dir = repoDir(repo);
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (folder: string, prefix: string, depth: number) => {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      if (item.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (!documents && !prefix && item.isDirectory() && isDocumentPath(rel)) continue;
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
  /**
   * How tools and screens name this line: its id, or "<id>.2", "<id>.3"… for later lines with the same id (two
   * devices edited one entry), so each can still be edited or forgotten on its own. Set by `assignKeys`.
   */
  key: string;
  path: string;
  /** Index of its line in the file. */
  line: number;
  indent: string;
  bullet: string;
}

const ENTRY_LINE = /^(\s*)([-*])\s+(.*\S)\s*$/;
const META = /\s*\[([^[\]]*)\]\s*$/;
const META_KEYS = new Set(["id", "source", "added"]);
/** Ids TOT writes: 8 hex (6 before; still read). */
export const ENTRY_ID = /^[0-9a-f]{6}(?:[0-9a-f]{2})?$/;

export const derivedId = (path: string, text: string) => `h${createHash("sha1").update(`${path}\n${text}`).digest("hex").slice(0, 10)}`;

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
    const id = own ?? derivedId(path, text);
    entries.push({
      id,
      key: id,
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

/** Names each line of a repo's entries (in file order) for tools and screens: see `Entry.key`. */
export function assignKeys(entries: Entry[]): Entry[] {
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const n = (seen.get(entry.id) ?? 0) + 1;
    seen.set(entry.id, n);
    entry.key = n === 1 ? entry.id : `${entry.id}.${n}`;
  }
  return entries;
}

/** A file as an agent's prompt shows it: each entry "- text (key)", without the rest of its metadata. */
export function promptView(content: string, entries: Pick<Entry, "line" | "indent" | "text" | "key">[]): string {
  const lines = content.split("\n");
  for (const entry of entries) lines[entry.line] = `${entry.indent}- ${entry.text} (${entry.key})`;
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** How many characters a markdown file takes in a prompt (entries without their metadata). */
export const promptSize = (path: string, content: string) => promptView(content, parseEntries(path, content)).length;

/** One line of text, as an entry holds it. */
export const entryText = (text: string) => text.replace(/\s+/g, " ").trim();

export function formatEntry(entry: Pick<Entry, "text" | "id" | "source" | "added"> & { indent?: string; bullet?: string }): string {
  const meta = [`id: ${entry.id}`, entry.source && `source: ${entry.source}`, entry.added && `added: ${entry.added}`].filter(Boolean).join("; ");
  return `${entry.indent ?? ""}${entry.bullet ?? "-"} ${entryText(entry.text)} [${meta}]`;
}

/** A fresh id (8 hex), unused by `taken`. */
export function newId(taken: Set<string>): string {
  for (;;) {
    const id = randomBytes(4).toString("hex");
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
