import { randomUUID } from "node:crypto";
import type { MemoryCommitKind, WikiAuthor, WikiRevision } from "../../shared/types.ts";
import { db, parseJson, type Row } from "../db.ts";
import {
  brainRepoId,
  commitAll,
  commitOutsideEdits,
  discardChanges,
  gitSync,
  head,
  initRepo,
  listFiles,
  onRepoChange,
  projectRepoId,
  readFile,
  removeFile,
  repoDir,
  repoExists,
  subjectText,
  withRepo,
  writeFile,
  type CommitMessage,
} from "../memory/repo.ts";
import {
  derivedPageId,
  folderOf,
  isPageId,
  isPagePath,
  OVERVIEW_PATH,
  PAGES_DIR,
  parsePage,
  renderPage,
  REPO_HEAD_FILE,
  repoFolder,
  REPOS_DIR,
  slugify,
  titleFromPath,
  type PageFields,
} from "./files.ts";

/**
 * Where the wiki's pages live (roadmap module 11, lane B): each brain's pages are markdown files in a git repo — a
 * project's brain in the project's knowledge repo (`memory/projects/<slug>`, beside its memory), every other brain
 * in `memory/brains/<id>` — and `wiki_pages` is their index, rebuilt from the files at startup and after anything
 * else changed them (an undo, a hand edit). Brains from before move in once (`migrateBrain`); until that lands
 * (or when it failed) a brain works from the database exactly as before.
 *
 * `wiki.*` stays synchronous: a write updates the index at once and records the change in `wiki_changes` (in the
 * same transaction, so a crash loses nothing); the change is then written and committed in the repo's turn
 * (module 10's `withRepo`), one commit per change, by its author, saying which pages it touched (`TOT-Page`
 * trailers). A page's history is read back from those commits, plus what's still waiting, plus the rows from
 * before git (`wiki_revisions_legacy`).
 */

export type StoreMode = "git" | "database";

/**
 * What the store needs from modules that can't be imported here: they import data/agents.ts, which uses the wiki
 * while it loads, so importing them from the wiki would leave it half-made. knowledge/link.ts fills these in.
 */
export const linked = {
  /** trust/secrets.ts: what kind of secret some text holds, if any. */
  secretKind: (_text: string): "key" | "password" | null => null,
  /** trust/secrets.ts: TOT's own secrets and anything key-shaped, hidden. */
  scrub: (text: string) => text,
  /** trust/secrets.ts: `scrub`, and passwords written out. */
  hideSecrets: (text: string) => text,
  /** app-events: a brain's pages changed (`structure`: pages came or went). */
  brainChanged: (_brainId: string, _structure: boolean) => {},
  /** memory.ts `afterChange` for a project's repo, else a `memory` event: the repo moved on. */
  announce: (_repo: string, _sha: string | null) => {},
  /** Filled in: until then nothing moves into git (its secrets couldn't be hidden). */
  ready: false,
};

/** Same author, same chat, still editing: one revision covers the burst (as before git). */
const REVISION_COALESCE_MS = 15 * 60_000;
const MAX_GIT_REVISIONS = 50;
/** How far back a page's history is read. */
const LOG_LIMIT = 4000;

// --- Brains, their repos and modes -------------------------------------------------------------------------------

interface StoreRow {
  state: StoreMode;
  repo: string | null;
  earlier: string[];
  error: string | null;
  movedAt: number | null;
}

function storeRow(brainId: string): StoreRow | null {
  const row = db.prepare(`SELECT * FROM wiki_stores WHERE brain_id = ?`).get(brainId) as Row | undefined;
  if (!row) return null;
  return {
    state: row.state === "git" ? "git" : "database",
    repo: (row.repo as string | null) ?? null,
    earlier: parseJson<string[]>(row.earlier, []),
    error: (row.error as string | null) ?? null,
    movedAt: (row.moved_at as number | null) ?? null,
  };
}

function putStore(brainId: string, patch: Partial<StoreRow>): void {
  const now = Date.now();
  const current = storeRow(brainId);
  const next = { state: "database" as StoreMode, repo: null, earlier: [], error: null, movedAt: null, ...current, ...patch };
  db.prepare(
    `INSERT INTO wiki_stores (brain_id, state, repo, earlier, error, moved_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(brain_id) DO UPDATE SET state = excluded.state, repo = excluded.repo, earlier = excluded.earlier,
       error = excluded.error, moved_at = excluded.moved_at, updated_at = excluded.updated_at`,
  ).run(brainId, next.state, next.repo, JSON.stringify(next.earlier), next.error, next.movedAt, now);
}

/** The repo a brain's pages belong in: its project's knowledge repo, else a repo of its own. */
export function targetRepo(brainId: string): string {
  const project = db.prepare(`SELECT slug FROM projects WHERE brain_id = ? ORDER BY created_at LIMIT 1`).get(brainId) as Row | undefined;
  return project ? projectRepoId(String(project.slug)) : brainRepoId(brainId);
}

/** The repo a brain's pages are in now (they follow it to `targetRepo` at its next write or start). */
export function repoOf(brainId: string): string {
  return storeRow(brainId)?.repo ?? targetRepo(brainId);
}

/**
 * Whether a brain's pages are in git. A brain with no pages yet starts there; one from before module 11 is in the
 * database until its move lands.
 */
export function modeOf(brainId: string): StoreMode {
  const row = storeRow(brainId);
  if (row) return row.state;
  const any = db.prepare(`SELECT 1 FROM wiki_pages WHERE brain_id = ? LIMIT 1`).get(brainId);
  if (any) return "database";
  putStore(brainId, { state: "git", repo: targetRepo(brainId), movedAt: Date.now() });
  return "git";
}

export const storeError = (brainId: string) => storeRow(brainId)?.error ?? null;

/** Brains whose move into git is running right now. */
export const moving = new Set<string>();

// --- The index ---------------------------------------------------------------------------------------------------

interface IndexRow extends PageFields {
  brainId: string;
  path: string | null;
  updatedBy: WikiAuthor;
  updatedAt: number;
  createdAt: number;
  conversationId: string | null;
  deletedAt: number | null;
}

function toIndexRow(row: Row): IndexRow {
  return {
    id: String(row.id),
    brainId: String(row.brain_id),
    parentId: (row.parent_id as string | null) ?? null,
    title: String(row.title),
    summary: String(row.summary),
    content: String(row.content),
    pinned: Boolean(row.pinned),
    position: Number(row.position),
    repo: (row.repo as string | null) ?? null,
    path: (row.path as string | null) ?? null,
    updatedBy: row.updated_by as WikiAuthor,
    updatedAt: Number(row.updated_at),
    createdAt: Number(row.created_at),
    conversationId: (row.conversation_id as string | null) ?? null,
    deletedAt: (row.deleted_at as number | null) ?? null,
  };
}

const liveRows = (brainId: string) =>
  (db.prepare(`SELECT * FROM wiki_pages WHERE brain_id = ? AND deleted_at IS NULL`).all(brainId) as Row[]).map(toIndexRow);

/** The brain's Overview (its oldest pinned page), whose file is always pages/overview.md. */
function overviewId(rows: IndexRow[]): string | null {
  return rows.filter((row) => row.pinned).sort((a, b) => a.createdAt - b.createdAt)[0]?.id ?? null;
}

/** The repo whose docs a page is part of: its own `repo`, or its nearest ancestor's. */
function repoContext(row: IndexRow, byId: Map<string, IndexRow>): string | null {
  const seen = new Set<string>();
  for (let at: IndexRow | undefined = row; at && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) {
    seen.add(at.id);
    if (at.repo) return at.repo;
  }
  return null;
}

/**
 * Where each of `ids` should be: the Overview at pages/overview.md, a repo's head page at repos/<name>/README.md,
 * the rest of its subtree beside it, and everything else in pages/. A page keeps its file name while it stays in
 * its folder (renaming a page doesn't move it); a page that changes folder keeps its name there when it's free.
 */
function place(rows: IndexRow[], ids: Set<string>, onDisk: (path: string) => boolean = () => false): Map<string, string> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const overview = overviewId(rows);
  const taken = new Set(rows.filter((row) => !ids.has(row.id) && row.path).map((row) => row.path!.toLowerCase()));
  const placed = new Map<string, string>();
  const claim = (path: string) => {
    taken.add(path.toLowerCase());
    return path;
  };
  const free = (folder: string, base: string, reserved: string[] = []) => {
    for (let n = 1; ; n++) {
      const path = `${folder}/${n === 1 ? base : `${base}-${n}`}.md`;
      if (!taken.has(path.toLowerCase()) && !reserved.includes(path.toLowerCase()) && !onDisk(path)) return claim(path);
    }
  };
  // The fixed places first, so a page that merely moved never takes them.
  const order = [...ids].map((id) => byId.get(id)).filter((row): row is IndexRow => Boolean(row));
  order.sort((a, b) => Number(b.id === overview) - Number(a.id === overview) || Number(Boolean(b.repo)) - Number(Boolean(a.repo)));
  for (const row of order) {
    if (row.id === overview) {
      placed.set(row.id, claim(OVERVIEW_PATH));
      continue;
    }
    const repo = repoContext(row, byId);
    const folder = repo ? `${REPOS_DIR}/${repoFolder(repo)}` : PAGES_DIR;
    if (row.repo) {
      const headPath = `${folder}/${REPO_HEAD_FILE}`;
      placed.set(row.id, taken.has(headPath.toLowerCase()) ? free(folder, "readme") : claim(headPath));
      continue;
    }
    const reserved = folder === PAGES_DIR ? [OVERVIEW_PATH] : [`${folder}/${REPO_HEAD_FILE}`.toLowerCase()];
    if (row.path && folderOf(row.path) === folder && !taken.has(row.path.toLowerCase()) && !reserved.includes(row.path.toLowerCase())) {
      placed.set(row.id, claim(row.path));
      continue;
    }
    const kept = row.path ? row.path.split("/").at(-1)!.replace(/\.md$/i, "") : "";
    const base = kept && !/^(readme|overview)$/i.test(kept) ? kept : slugify(row.title);
    placed.set(row.id, free(folder, base, reserved));
  }
  return placed;
}

/** Every page below `ids` (not including them). */
function descendants(rows: IndexRow[], ids: Iterable<string>): Set<string> {
  const children = new Map<string, string[]>();
  for (const row of rows) if (row.parentId) children.set(row.parentId, [...(children.get(row.parentId) ?? []), row.id]);
  const found = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    for (const child of children.get(stack.pop()!) ?? []) {
      if (!found.has(child)) {
        found.add(child);
        stack.push(child);
      }
    }
  }
  return found;
}

/** Whether a path holds a file that isn't one of these pages (made by hand, not indexed yet): new pages go elsewhere. */
function foreignFile(repo: string, ids: Set<string>): (path: string) => boolean {
  return (path) => {
    try {
      const text = repoExists(repo) ? readFile(repo, path) : null;
      if (text === null) return false;
      const id = parsePage(text).id;
      return !(id && ids.has(id));
    } catch {
      return true;
    }
  };
}

/** Front matter lines someone added by hand to a page's file, kept when TOT rewrites it. */
function extraLines(repo: string, path: string | null): string[] {
  if (!path || !repoExists(repo)) return [];
  try {
    const text = readFile(repo, path);
    return text === null ? [] : parsePage(text).extra;
  } catch {
    return [];
  }
}

// --- Recording a change ------------------------------------------------------------------------------------------

export type PageOp = "create" | "edit" | "move" | "delete" | "restore" | "import";
const KIND: Record<PageOp, MemoryCommitKind> = { create: "remember", edit: "edit", move: "edit", delete: "forget", restore: "edit", import: "import" };
const VERB: Record<PageOp, string> = { create: "write page", edit: "edit page", move: "move page", delete: "delete page", restore: "restore page", import: "import page" };

/** Who a change is by, as history shows it: "you", the agent's name, or the wiki keeper. */
export function actorName(author: WikiAuthor, conversationId: string | null): string {
  if (author === "user") return "you";
  if (author === "keeper") return "Wiki keeper";
  const row = conversationId
    ? (db.prepare(`SELECT a.name FROM conversations c JOIN agents a ON a.id = c.agent_id WHERE c.id = ?`).get(conversationId) as Row | undefined)
    : undefined;
  // Written by TOT itself, outside any chat (a background job).
  return row ? String(row.name) : "TOT";
}

interface Batch {
  id: string;
  brainId: string;
  subject: string;
  actor: string;
}
let batch: Batch | null = null;

/** Runs `fn`; the changes it makes to `brainId`'s pages become one commit with this subject (inside one, it joins it). */
export function inBatch<T>(brainId: string, message: { subject: string; actor: string }, fn: () => T): { result: T; id: string } {
  if (batch) {
    if (batch.brainId !== brainId) throw new Error("A wiki batch changes one brain.");
    return { result: fn(), id: batch.id };
  }
  batch = { id: randomUUID(), brainId, subject: message.subject, actor: message.actor };
  const id = batch.id;
  try {
    return { result: fn(), id };
  } finally {
    batch = null;
  }
}

/** Runs `fn` as one database transaction (a savepoint, so it also works inside another). */
export function atomically<T>(fn: () => T): T {
  const name = `wiki_${randomUUID().replace(/-/g, "")}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (err) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw err;
  }
}

/**
 * After `wiki.*` changed the index (inside `atomically`): places the pages it touched (and, when pages moved, their
 * subtrees) in files, and records the change to be committed. `delete`: the page's file goes.
 */
export function record(brainId: string, ops: { id: string; op: PageOp }[], author: WikiAuthor, conversationId: string | null): string {
  const repo = repoOf(brainId);
  const rows = liveRows(brainId);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const deleted = ops.filter((o) => o.op === "delete").map((o) => o.id);
  const moved = ops.filter((o) => o.op === "move" || o.op === "delete").map((o) => o.id);
  const affected = new Set([...ops.filter((o) => o.op !== "delete").map((o) => o.id), ...descendants(rows, moved)]);
  const files: Record<string, string | null> = {};
  const pages: { id: string; op: PageOp; path: string }[] = [];
  for (const id of deleted) {
    const row = db.prepare(`SELECT path FROM wiki_pages WHERE id = ?`).get(id) as Row | undefined;
    const path = (row?.path as string | null) ?? null;
    if (path) files[path] = null;
    pages.push({ id, op: "delete", path: path ?? "-" });
  }
  const known = new Set((db.prepare(`SELECT id FROM wiki_pages WHERE brain_id = ?`).all(brainId) as Row[]).map((row) => String(row.id)));
  const paths = place(rows, affected, foreignFile(repo, known));
  const setPath = db.prepare(`UPDATE wiki_pages SET path = ? WHERE id = ?`);
  for (const id of affected) {
    const row = byId.get(id);
    const path = paths.get(id);
    if (!row || !path) continue;
    if (row.path && row.path !== path && files[row.path] === undefined) files[row.path] = null;
    files[path] = renderPage(row, extraLines(repo, row.path ?? path));
    if (row.path !== path) setPath.run(path, id);
    pages.push({ id, op: ops.find((o) => o.id === id)?.op ?? "move", path });
  }
  const main = ops[0]!;
  const title = byId.get(main.id)?.title ?? (db.prepare(`SELECT title FROM wiki_pages WHERE id = ?`).get(main.id) as Row | undefined)?.title ?? "";
  const actor = actorName(author, conversationId);
  const inBatchNow = batch && batch.brainId === brainId ? batch : null;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO wiki_changes (id, brain_id, files, pages, subject, actor, kind, author, conversation_id, batch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    brainId,
    JSON.stringify(files),
    JSON.stringify(pages),
    inBatchNow?.subject ?? `${actor}: ${VERB[main.op]} “${subjectText(linked.hideSecrets(String(title)), 72)}”`,
    inBatchNow?.actor ?? actor,
    KIND[main.op],
    author,
    conversationId,
    inBatchNow?.id ?? null,
    Date.now(),
  );
  void scheduleFlush(brainId);
  return id;
}

// --- Writing changes into the repo -------------------------------------------------------------------------------

interface ChangeRow {
  seq: number;
  id: string;
  brainId: string;
  files: Record<string, string | null>;
  pages: { id: string; op: PageOp; path: string }[];
  subject: string;
  actor: string;
  kind: MemoryCommitKind;
  author: WikiAuthor;
  conversationId: string | null;
  batch: string | null;
  error: string | null;
  createdAt: number;
}

function toChange(row: Row): ChangeRow {
  return {
    seq: Number(row.seq),
    id: String(row.id),
    brainId: String(row.brain_id),
    files: parseJson<Record<string, string | null>>(row.files, {}),
    pages: parseJson<ChangeRow["pages"]>(row.pages, []),
    subject: String(row.subject),
    actor: String(row.actor),
    kind: row.kind as MemoryCommitKind,
    author: row.author as WikiAuthor,
    conversationId: (row.conversation_id as string | null) ?? null,
    batch: (row.batch as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    createdAt: Number(row.created_at),
  };
}

export const pendingChanges = (brainId: string) =>
  (db.prepare(`SELECT * FROM wiki_changes WHERE brain_id = ? ORDER BY seq`).all(brainId) as Row[]).map(toChange);

/** Pages with a change still waiting to be committed: the index is ahead of their files. */
function pendingPageIds(brainId: string): Set<string> {
  return new Set(pendingChanges(brainId).flatMap((change) => change.pages.map((page) => page.id)));
}

/** Brain ids whose flush is already waiting in their repo's queue (it picks up every change recorded until it starts). */
const queued = new Set<string>();
const retryTimers = new Map<string, NodeJS.Timeout>();
const failures = new Map<string, number>();
/** The commit each change (or batch) landed in, for `flush` callers; kept briefly. */
const landed = new Map<string, string>();
/** Repos whose own commit is being announced: their pages' index is already right. */
const announcing = new Set<string>();

/**
 * Queues a flush of the brain's waiting changes in its repo's turn (one is enough: it takes every change recorded
 * until it starts). Resolves after it. Never await this from inside a repo's turn: it may wait for that turn.
 */
export function scheduleFlush(brainId: string): Promise<string | null> {
  const repo = repoOf(brainId);
  if (queued.has(brainId)) return withRepo(repo, async () => head(repo)).catch(() => null);
  queued.add(brainId);
  return withRepo(repo, () => flushNow(brainId, repo)).catch((err) => {
    console.warn(`[tot] couldn't write the wiki's pages into ${repo}:`, err instanceof Error ? err.message : err);
    return null;
  });
}

/** Retries a flush that failed, backing off from 30 seconds to 10 minutes. */
function retryLater(brainId: string): void {
  if (retryTimers.has(brainId)) return;
  const n = (failures.get(brainId) ?? 0) + 1;
  failures.set(brainId, n);
  const timer = setTimeout(() => {
    retryTimers.delete(brainId);
    void scheduleFlush(brainId);
  }, Math.min(30_000 * 2 ** (n - 1), 10 * 60_000));
  timer.unref?.();
  retryTimers.set(brainId, timer);
}

/** Tells memory (and every screen) the repo moved on; the pages' index is already right. */
function announce(repo: string, sha: string | null): void {
  announcing.add(repo);
  try {
    linked.announce(repo, sha);
  } finally {
    announcing.delete(repo);
  }
}

/** Groups waiting changes into commits: one each, but a batch's changes together. */
function commitGroups(changes: ChangeRow[]): ChangeRow[][] {
  const groups: ChangeRow[][] = [];
  for (const change of changes) {
    const last = groups.at(-1);
    if (last && change.batch && last[0]!.batch === change.batch) last.push(change);
    else groups.push([change]);
  }
  return groups;
}

function groupMessage(group: ChangeRow[]): CommitMessage {
  const last = group.at(-1)!;
  const pageLines = group.flatMap((change) => change.pages.map((page) => `TOT-Page: ${page.id} ${page.op} ${change.id} ${page.path}`));
  return {
    subject: group[0]!.subject,
    actor: last.actor,
    kind: group.length === 1 ? last.kind : "edit",
    trailers: [
      `TOT-Author: ${last.author}`,
      ...(last.conversationId ? [`TOT-Chat: ${last.conversationId}`] : []),
      `TOT-At: ${last.createdAt}`,
      ...pageLines,
    ],
  };
}

/** Writes and commits every change waiting for a brain, in its repo's turn. */
async function flushNow(brainId: string, queuedRepo: string): Promise<string | null> {
  queued.delete(brainId);
  if (repoOf(brainId) !== queuedRepo) {
    void scheduleFlush(brainId);
    return null;
  }
  const repo = queuedRepo;
  // The brain now belongs to a project: its pages follow it into the project's repo first (in that repo's turn).
  if (modeOf(brainId) === "git" && targetRepo(brainId) !== repo) {
    startRelocation(brainId, repo, targetRepo(brainId));
    return null;
  }
  const existed = repoExists(repo);
  await initRepo(repo);
  const outside = await commitOutsideEdits(repo);
  if (outside) reconcile(brainId);
  let sha: string | null = outside;
  for (const group of commitGroups(pendingChanges(brainId))) {
    try {
      for (const change of group) {
        for (const [path, content] of Object.entries(change.files)) {
          if (content === null) removeFile(repo, path);
          else writeFile(repo, path, content);
        }
      }
      const made = await commitAll(repo, groupMessage(group));
      sha = made ?? sha;
      const done = db.prepare(`DELETE FROM wiki_changes WHERE id = ?`);
      for (const change of group) {
        done.run(change.id);
        if (made) landed.set(change.batch ?? change.id, made);
      }
      failures.delete(brainId);
    } catch (err) {
      await discardChanges(repo).catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      const failed = db.prepare(`UPDATE wiki_changes SET error = ? WHERE id = ?`);
      for (const change of group) failed.run(message, change.id);
      console.warn(`[tot] couldn't commit a wiki change in ${repo} (tried again later):`, message);
      retryLater(brainId);
      break;
    }
  }
  while (landed.size > 500) landed.delete(landed.keys().next().value!);
  if (sha || !existed) announce(repo, sha);
  return head(repo);
}

/** Waits for every change to the brain's pages recorded so far to be committed; the repo's head after it. */
export async function flush(brainId: string): Promise<string | null> {
  await scheduleFlush(brainId);
  if (pendingChanges(brainId).some((change) => change.error)) {
    throw new Error(pendingChanges(brainId).find((change) => change.error)!.error!);
  }
  return head(repoOf(brainId));
}

/**
 * Waits until every page change recorded so far for any brain whose pages live in `repo` is committed (module 11:
 * auto-update runs count a write's commit as theirs only once it has landed). Never call it in the repo's turn.
 */
export async function flushRepo(repo: string): Promise<void> {
  const rows = db.prepare(`SELECT DISTINCT brain_id FROM wiki_changes`).all() as Row[];
  for (const row of rows) {
    const brainId = String(row.brain_id);
    if (repoOf(brainId) === repo) await flush(brainId);
  }
}

/** The commit a change (or a batch) landed in, once it has. */
export const landedIn = (changeOrBatch: string) => landed.get(changeOrBatch) ?? null;

// --- Reading the files back --------------------------------------------------------------------------------------

/** The page files in a repo (pages/ and repos/), by path. */
function pageFiles(repo: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!repoExists(repo)) return files;
  for (const path of listFiles(repo, { documents: true })) {
    if (!isPagePath(path)) continue;
    const text = readFile(repo, path);
    if (text !== null) files.set(path, text);
  }
  return files;
}

interface FilePage extends PageFields {
  path: string;
}

/** The pages a repo's files hold for a brain: ids from their front matter (or made from their path). */
function readPages(brainId: string, repo: string): FilePage[] {
  const pages: FilePage[] = [];
  const ids = new Set<string>();
  const foreign = (id: string) => {
    const row = db.prepare(`SELECT brain_id FROM wiki_pages WHERE id = ?`).get(id) as Row | undefined;
    return row !== undefined && row.brain_id !== brainId;
  };
  for (const [path, text] of [...pageFiles(repo)].sort(([a], [b]) => a.localeCompare(b))) {
    const parsed = parsePage(text);
    let id = isPageId(parsed.id) ? parsed.id : derivedPageId(brainId, path);
    // A copied file (its id already taken) or one from another brain gets an id of its own.
    if (ids.has(id) || foreign(id)) id = derivedPageId(brainId, path);
    ids.add(id);
    let { title, content } = parsed;
    if (!title?.trim()) {
      const heading = /^#\s+(.+)\n?/.exec(content);
      title = heading ? heading[1]!.trim() : titleFromPath(path);
      if (heading) content = content.slice(heading[0].length).trim();
    }
    pages.push({
      id,
      path,
      title: title.replace(/\s+/g, " ").trim().slice(0, 120),
      summary: (parsed.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
      parentId: parsed.parentId ?? null,
      pinned: parsed.pinned ?? path === OVERVIEW_PATH,
      position: parsed.position ?? 0,
      repo: parsed.repo ?? null,
      content,
    });
  }
  // A parent that isn't one of the brain's pages (no file, nothing waiting): the page sits at the top. Files under
  // repos/<name>/ without one go under that repo's head page.
  const overview = overviewId(liveRows(brainId));
  const known = new Set([...pages.map((page) => page.id), ...pendingPageIds(brainId), ...(overview ? [overview] : [])]);
  const heads = new Map(pages.filter((page) => page.repo).map((page) => [`${REPOS_DIR}/${repoFolder(page.repo!)}`, page.id]));
  for (const page of pages) {
    if (page.parentId && !known.has(page.parentId)) page.parentId = null;
    if (!page.parentId && !page.repo && !page.pinned && page.path.startsWith(`${REPOS_DIR}/`)) page.parentId = heads.get(folderOf(page.path)) ?? null;
  }
  return pages;
}

const sameText = (a: FilePage | IndexRow, b: FilePage | IndexRow) => a.title === b.title && a.summary === b.summary && a.content === b.content;
const samePlace = (a: FilePage | IndexRow, b: FilePage | IndexRow) =>
  a.parentId === b.parentId && a.pinned === b.pinned && a.position === b.position && (a.repo ?? null) === (b.repo ?? null);

/**
 * Brings a git brain's index in line with its files (they're the truth). Pages with a change still waiting keep
 * their index (it's ahead). A page whose file went is marked deleted (kept, as before git); the Overview stays,
 * empty. Text changed outside `wiki.*` (by hand, an undo) counts as the user's. Returns how many pages changed.
 */
export function reconcile(brainId: string): number {
  if (modeOf(brainId) !== "git") return 0;
  const repo = repoOf(brainId);
  if (!repoExists(repo)) return 0;
  const pending = pendingPageIds(brainId);
  const files = readPages(brainId, repo).filter((page) => !pending.has(page.id));
  const rows = new Map(
    (db.prepare(`SELECT * FROM wiki_pages WHERE brain_id = ?`).all(brainId) as Row[]).map((row) => [String(row.id), toIndexRow(row)]),
  );
  const now = Date.now();
  let changed = 0;
  let structure = false;
  atomically(() => {
    // A page may name a parent that's only added further down (checked when the transaction ends).
    db.exec("PRAGMA defer_foreign_keys = ON");
    for (const page of files) {
      const row = rows.get(page.id);
      if (!row) {
        db.prepare(
          `INSERT INTO wiki_pages (id, brain_id, parent_id, title, summary, content, pinned, position, updated_by, conversation_id, created_at, updated_at, path, repo)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user', NULL, ?, ?, ?, ?)`,
        ).run(page.id, brainId, page.parentId, page.title, page.summary, page.content, page.pinned ? 1 : 0, page.position, now, now, page.path, page.repo);
        changed++;
        structure = true;
        continue;
      }
      const text = sameText(page, row);
      if (text && samePlace(page, row) && row.path === page.path && row.deletedAt === null) continue;
      db.prepare(
        `UPDATE wiki_pages SET parent_id = ?, title = ?, summary = ?, content = ?, pinned = ?, position = ?, repo = ?, path = ?, deleted_at = NULL,
           updated_by = ?, conversation_id = ?, updated_at = ? WHERE id = ?`,
      ).run(
        page.parentId,
        page.title,
        page.summary,
        page.content,
        page.pinned ? 1 : 0,
        page.position,
        page.repo,
        page.path,
        text ? row.updatedBy : "user",
        text ? row.conversationId : null,
        text ? row.updatedAt : now,
        page.id,
      );
      changed++;
      if (row.deletedAt !== null || !samePlace(page, row)) structure = true;
    }
    const present = new Set(files.map((page) => page.id));
    const overview = overviewId([...rows.values()].filter((row) => row.deletedAt === null));
    for (const row of rows.values()) {
      if (row.deletedAt !== null || present.has(row.id) || pending.has(row.id)) continue;
      if (row.id === overview) {
        // The Overview always exists: without its file it's back to empty.
        if (row.content || row.path !== OVERVIEW_PATH) {
          db.prepare(`UPDATE wiki_pages SET content = '', path = ?, updated_by = 'user', conversation_id = NULL, updated_at = ? WHERE id = ?`).run(OVERVIEW_PATH, now, row.id);
          changed++;
        }
        continue;
      }
      db.prepare(`UPDATE wiki_pages SET deleted_at = ? WHERE id = ?`).run(now, row.id);
      changed++;
      structure = true;
    }
  });
  if (changed) linked.brainChanged(brainId, structure);
  return changed;
}

// Anything else that changed a repo (an undo, hand edits committed by memory, Dreaming): its pages are read again.
onRepoChange((repo) => {
  if (announcing.has(repo)) return;
  for (const row of db.prepare(`SELECT brain_id FROM wiki_stores WHERE repo = ? AND state = 'git'`).all(repo) as Row[]) {
    reconcile(String(row.brain_id));
  }
});

// --- History -----------------------------------------------------------------------------------------------------

interface LoggedCommit {
  sha: string;
  at: number;
  author: WikiAuthor | null;
  chat: string | null;
  kind: string | null;
  pages: { id: string; op: PageOp; change: string; path: string }[];
  files: string[];
}

const logCache = new Map<string, { head: string; commits: LoggedCommit[] }>();
const RS = "\x1e";
const US = "\x1f";

/** A repo's commits, oldest first, with what TOT's trailers say about pages (cached until the repo moves on). */
function commitsOf(repo: string): LoggedCommit[] {
  if (!repoExists(repo)) return [];
  const dir = repoDir(repo);
  let current: string;
  try {
    current = gitSync(dir, ["rev-parse", "HEAD"]).toString().trim();
  } catch {
    return [];
  }
  const cached = logCache.get(repo);
  if (cached?.head === current) return cached.commits;
  const out = gitSync(dir, ["log", `-n${LOG_LIMIT}`, `--format=${RS}%H${US}%ct${US}%B${US}`, "--name-only", "--no-renames", "--first-parent"]).toString();
  const commits: LoggedCommit[] = [];
  for (const record of out.split(RS).slice(1)) {
    const [sha, time, body = "", rest = ""] = record.split(US);
    const commit: LoggedCommit = { sha: sha!, at: Number(time) * 1000, author: null, chat: null, kind: null, pages: [], files: rest.split("\n").map((line) => line.trim()).filter(Boolean) };
    for (const line of body.split("\n")) {
      const trailer = /^TOT-([\w-]+):\s*(.*)$/.exec(line.trim());
      if (!trailer) continue;
      const [, key, value] = trailer;
      if (key === "Author" && /^(agent|keeper|user)$/.test(value!)) commit.author = value as WikiAuthor;
      else if (key === "Chat") commit.chat = value!.trim() || null;
      else if (key === "At" && /^\d+$/.test(value!)) commit.at = Number(value);
      else if (key === "Kind") commit.kind = value!.trim();
      else if (key === "Page") {
        const [id, op, change, ...path] = value!.trim().split(" ");
        if (id && op && change) commit.pages.push({ id, op: op as PageOp, change, path: path.join(" ") });
      }
    }
    commits.push(commit);
  }
  commits.reverse();
  logCache.set(repo, { head: current, commits });
  return commits;
}

/** What a commit did to pages, as TOT's trailers say (and, for other commits, the page files it touched). */
export function commitPages(repo: string): Map<string, { pages: LoggedCommit["pages"]; files: string[] }> {
  return new Map(commitsOf(repo).map((commit) => [commit.sha, { pages: commit.pages, files: commit.files.filter(isPagePath) }]));
}

/** Files at commits, read in one go: `${sha}:${path}` → text (null when it isn't there). */
function blobsAt(repo: string, refs: string[]): Map<string, string | null> {
  const found = new Map<string, string | null>();
  if (!refs.length) return found;
  const out = gitSync(repoDir(repo), ["cat-file", "--batch"], { input: `${refs.join("\n")}\n` });
  let at = 0;
  for (const ref of refs) {
    const newline = out.indexOf(10, at);
    if (newline < 0) break;
    const header = out.subarray(at, newline).toString();
    at = newline + 1;
    const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!match) {
      found.set(ref, null);
      continue;
    }
    const size = Number(match[1]);
    found.set(ref, out.subarray(at, at + size).toString("utf8"));
    at += size + 1;
  }
  return found;
}

interface PageState {
  title: string;
  summary: string;
  content: string;
}

/** One change to a page, oldest first: who made it and what the page said after it (null: gone). */
interface PageChange {
  id: string;
  at: number;
  author: WikiAuthor;
  chat: string | null;
  op: PageOp | "outside";
  state: PageState | null;
  /** Imported from before git: empty and never edited then. */
  pristine?: boolean;
}

function stateOf(text: string | null | undefined): PageState | null {
  if (text === null || text === undefined) return null;
  const parsed = parsePage(text);
  return { title: (parsed.title ?? "").trim(), summary: (parsed.summary ?? "").trim(), content: parsed.content };
}

/** Every change to a page: its commits in each repo it has lived in, then what's still waiting. */
function pageChanges(brainId: string, pageId: string): PageChange[] {
  const store = storeRow(brainId);
  const repos = [...(store?.earlier ?? []), repoOf(brainId)];
  const current = (db.prepare(`SELECT path FROM wiki_pages WHERE id = ?`).get(pageId) as Row | undefined)?.path as string | null | undefined;
  const legacy = db.prepare(`SELECT * FROM wiki_pages_legacy WHERE id = ?`).get(pageId) as Row | undefined;
  const changes: PageChange[] = [];
  for (const repo of repos) {
    let commits: LoggedCommit[];
    try {
      commits = commitsOf(repo);
    } catch {
      continue;
    }
    const picked: { commit: LoggedCommit; change: string; op: PageOp | "outside"; path: string | null }[] = [];
    let known: string | null = null;
    const paths = new Set<string>(current ? [current] : []);
    for (const commit of commits) for (const line of commit.pages) if (line.id === pageId && line.path !== "-") paths.add(line.path);
    for (const commit of commits) {
      const line = commit.pages.filter((page) => page.id === pageId).at(-1);
      if (line) {
        known = line.op === "delete" ? known : line.path;
        picked.push({ commit, change: line.change, op: line.op, path: line.op === "delete" ? null : line.path });
      } else if (!commit.pages.length && commit.files.some((file) => (known ? file === known : paths.has(file)))) {
        // Changed by something other than `wiki.*` (by hand, an undo): its file says what the page became.
        const path: string = known ?? commit.files.find((file) => paths.has(file))!;
        known = path;
        picked.push({ commit, change: commit.sha, op: "outside", path });
      }
    }
    const blobs = blobsAt(repo, picked.filter((p) => p.path).map((p) => `${p.commit.sha}:${p.path}`));
    for (const { commit, change, op, path } of picked) {
      const imported = op === "import" && legacy;
      changes.push({
        id: change,
        at: imported ? Number(legacy.updated_at) : commit.at,
        author: imported ? (legacy.updated_by as WikiAuthor) : (commit.author ?? "user"),
        chat: imported ? ((legacy.conversation_id as string | null) ?? null) : op === "outside" ? null : commit.chat,
        op,
        state: path ? stateOf(blobs.get(`${commit.sha}:${path}`)) : null,
        pristine: imported ? Number(legacy.updated_at) === Number(legacy.created_at) && !String(legacy.content) : undefined,
      });
    }
  }
  // Waiting changes; a batch's count as one (it lands as one commit).
  let lastBatch: string | null = null;
  for (const change of pendingChanges(brainId)) {
    const line = change.pages.filter((page) => page.id === pageId).at(-1);
    if (!line) continue;
    const entry: PageChange = {
      id: change.id,
      at: change.createdAt,
      author: change.author,
      chat: change.conversationId,
      op: line.op,
      state: line.op === "delete" ? null : stateOf(change.files[line.path]),
    };
    if (change.batch && change.batch === lastBatch) changes[changes.length - 1] = entry;
    else changes.push(entry);
    lastBatch = change.batch;
  }
  return changes;
}

/**
 * A git brain's page history as revisions (newest first): the page as it was before each burst of changes — as
 * before git, a burst is one author's edits in one chat within 15 minutes, a restore always starts one, and an
 * empty page nobody edited yet isn't worth keeping — then the rows from before git (`legacy`).
 */
export function gitRevisions(brainId: string, pageId: string): WikiRevision[] {
  const revisions: WikiRevision[] = [];
  let previous: PageState | null = null;
  let last: PageChange | null = null;
  // Whether its text changed since it appeared (an empty page nobody wrote in yet has nothing worth keeping).
  let edited = false;
  let lastRevisionAt = -Infinity;
  for (const change of pageChanges(brainId, pageId)) {
    if (!change.state) {
      previous = null;
      continue;
    }
    if (!previous || !last) {
      previous = change.state;
      last = change;
      edited = change.op === "import" ? !change.pristine : false;
      continue;
    }
    if (previous.title === change.state.title && previous.summary === change.state.summary && previous.content === change.state.content) continue;
    const sameBurst =
      change.op !== "restore" &&
      last.author === change.author &&
      last.chat === change.chat &&
      change.at - last.at < REVISION_COALESCE_MS &&
      lastRevisionAt >= change.at - REVISION_COALESCE_MS;
    const pristine = !previous.content && !edited;
    edited = true;
    if (!sameBurst && !pristine) {
      revisions.push({
        id: last.id,
        pageId,
        title: previous.title,
        summary: previous.summary,
        content: previous.content,
        updatedBy: last.author,
        conversationId: last.chat,
        createdAt: change.at,
      });
      lastRevisionAt = change.at;
    }
    previous = change.state;
    last = change;
  }
  const older = (db.prepare(`SELECT * FROM wiki_revisions_legacy WHERE page_id = ? ORDER BY created_at DESC`).all(pageId) as Row[]).map(
    (row): WikiRevision => ({
      id: String(row.id),
      pageId,
      title: String(row.title),
      summary: String(row.summary),
      content: String(row.content),
      updatedBy: row.updated_by as WikiAuthor,
      conversationId: (row.conversation_id as string | null) ?? null,
      createdAt: Number(row.created_at),
      legacy: true,
    }),
  );
  return [...revisions.reverse().slice(0, MAX_GIT_REVISIONS), ...older];
}

// --- Moving a brain's pages --------------------------------------------------------------------------------------

/** Page files as the move writes them: TOT's own secrets and key-shaped text hidden (the originals stay in the legacy table). */
const movedFile = (row: IndexRow) =>
  renderPage({ ...row, title: linked.scrub(row.title), summary: linked.scrub(row.summary), content: linked.scrub(row.content) });

/**
 * Moves a brain's pages from the database into its repo, once, keeping their ids: one commit "Imported N pages"
 * (and one more if pages changed while it ran), then the brain works from git. The rows stay in
 * `wiki_pages_legacy`, its revisions in `wiki_revisions_legacy`. A failure leaves it working from the database;
 * the next start tries again.
 */
export async function migrateBrain(brainId: string): Promise<number> {
  if (modeOf(brainId) === "git" || moving.has(brainId)) return 0;
  if (!linked.ready) throw new Error("The wiki's move into git isn't ready (knowledge/link.ts wasn't loaded).");
  const repo = targetRepo(brainId);
  moving.add(brainId);
  try {
    return await withRepo(repo, async () => {
      const existed = repoExists(repo);
      await initRepo(repo);
      await commitOutsideEdits(repo);
      let imported = 0;
      try {
        for (let round = 0; ; round++) {
          const rows = liveRows(brainId);
          const mine = new Set((db.prepare(`SELECT id FROM wiki_pages WHERE brain_id = ?`).all(brainId) as Row[]).map((row) => String(row.id)));
          const paths = place(rows, new Set(rows.map((row) => row.id)), foreignFile(repo, mine));
          const wanted = new Map(rows.map((row) => [paths.get(row.id)!, movedFile({ ...row, path: paths.get(row.id)! })]));
          // Our own files from an earlier try whose page has gone (deleted meanwhile, or moved) go too.
          for (const [path, text] of pageFiles(repo)) {
            const id = parsePage(text).id;
            if (!wanted.has(path) && id && mine.has(id)) removeFile(repo, path);
          }
          const changed: string[] = [];
          for (const [path, text] of wanted) {
            if (readFile(repo, path) !== text) {
              writeFile(repo, path, text);
              changed.push(path);
            }
          }
          const change = randomUUID();
          const byPath = new Map(rows.map((row) => [paths.get(row.id)!, row]));
          await commitAll(repo, {
            subject: round === 0 ? `Imported ${rows.length} wiki ${rows.length === 1 ? "page" : "pages"}` : "Imported what changed during the move",
            actor: "TOT",
            kind: "import",
            trailers: [
              "TOT-Author: agent",
              `TOT-At: ${Date.now()}`,
              "TOT-Undo: no",
              ...changed.map((path) => `TOT-Page: ${byPath.get(path)!.id} import ${change} ${path}`),
            ],
          });
          if (round === 0) imported = rows.length;
          // Nothing changed while that commit was made: switch over now, in one go (nothing can write in between).
          const now = liveRows(brainId);
          const again = place(now, new Set(now.map((row) => row.id)), foreignFile(repo, mine));
          const settled =
            now.length === rows.length && now.every((row) => readFile(repo, again.get(row.id)!) === movedFile({ ...row, path: again.get(row.id)! }));
          if (settled) {
            atomically(() => {
              const movedAt = Date.now();
              db.prepare(
                `INSERT OR IGNORE INTO wiki_pages_legacy (id, brain_id, parent_id, title, summary, content, pinned, position, updated_by, conversation_id, created_at, updated_at, deleted_at, moved_at)
                 SELECT id, brain_id, parent_id, title, summary, content, pinned, position, updated_by, conversation_id, created_at, updated_at, deleted_at, ?
                 FROM wiki_pages WHERE brain_id = ?`,
              ).run(movedAt, brainId);
              db.prepare(
                `INSERT OR IGNORE INTO wiki_revisions_legacy (id, page_id, title, summary, content, updated_by, conversation_id, created_at)
                 SELECT r.id, r.page_id, r.title, r.summary, r.content, r.updated_by, r.conversation_id, r.created_at
                 FROM wiki_revisions r JOIN wiki_pages p ON p.id = r.page_id WHERE p.brain_id = ?`,
              ).run(brainId);
              // The index keeps who wrote each page and when; it takes the files' text (secrets hidden) and places.
              const update = db.prepare(`UPDATE wiki_pages SET path = ?, title = ?, summary = ?, content = ? WHERE id = ?`);
              for (const row of now) update.run(again.get(row.id)!, linked.scrub(row.title), linked.scrub(row.summary), linked.scrub(row.content), row.id);
              putStore(brainId, { state: "git", repo, error: null, movedAt });
            });
            break;
          }
          if (round >= 4) throw new Error("The wiki kept changing while it moved into git; trying again at the next start.");
        }
      } catch (err) {
        await discardChanges(repo).catch(() => {});
        throw err;
      }
      announce(repo, await head(repo));
      if (!existed) logCache.delete(repo);
      reconcile(brainId);
      return imported;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    putStore(brainId, { state: "database", error: message });
    throw err;
  } finally {
    moving.delete(brainId);
  }
}

const relocating = new Set<string>();

/** Starts moving a brain's pages into its project's repo, in that repo's turn; its waiting changes follow. */
function startRelocation(brainId: string, from: string, to: string): void {
  if (relocating.has(brainId)) return;
  relocating.add(brainId);
  // Whatever was still running in the old repo finishes first; neither repo's turn is held while waiting.
  void withRepo(from, async () => {})
    .then(() => withRepo(to, () => relocate(brainId, from, to)))
    .then(
      () => void scheduleFlush(brainId),
      (err) => {
        console.warn(`[tot] couldn't move the wiki's pages into ${to} (tried again later):`, err instanceof Error ? err.message : err);
        retryLater(brainId);
      },
    )
    .finally(() => relocating.delete(brainId));
}

/**
 * A git brain that now belongs to a project (made from a brain learned before): its pages are copied into the
 * project's repo as one commit, keeping their ids; the old repo stays, and its history still counts. Call inside
 * the new repo's turn.
 */
async function relocate(brainId: string, from: string, to: string): Promise<void> {
  await initRepo(to);
  await commitOutsideEdits(to);
  const pages = readPages(brainId, from);
  const theirs = new Set(pageFiles(to).keys());
  const change = randomUUID();
  const lines: string[] = [];
  const setPath = db.prepare(`UPDATE wiki_pages SET path = ? WHERE id = ?`);
  try {
    for (const page of pages) {
      let path = page.path;
      for (let n = 2; theirs.has(path); n++) path = page.path.replace(/(\.md)$/i, `-${n}$1`);
      theirs.add(path);
      writeFile(to, path, readFile(from, page.path) ?? renderPage(page));
      setPath.run(path, page.id);
      lines.push(`TOT-Page: ${page.id} import ${change} ${path}`);
    }
    await commitAll(to, {
      subject: `Moved ${pages.length} wiki ${pages.length === 1 ? "page" : "pages"} here from ${from}`,
      actor: "TOT",
      kind: "import",
      trailers: ["TOT-Author: agent", `TOT-At: ${Date.now()}`, "TOT-Undo: no", ...lines],
    });
  } catch (err) {
    await discardChanges(to).catch(() => {});
    throw err;
  }
  const store = storeRow(brainId);
  putStore(brainId, { repo: to, earlier: [...(store?.earlier ?? []), from].filter((repo, i, all) => all.indexOf(repo) === i && repo !== to) });
  announce(to, await head(to));
}

// --- Startup -----------------------------------------------------------------------------------------------------

/** Brains that exist (deleted ones keep their pages where they are). */
const liveBrains = () => (db.prepare(`SELECT id FROM brains WHERE deleted_at IS NULL ORDER BY created_at`).all() as Row[]).map((row) => String(row.id));

/**
 * At startup (after memory's): moves every brain still in the database into git, commits changes a crash left
 * waiting, and rebuilds each git brain's index from its files.
 */
export async function startStore(): Promise<{ moved: number; pages: number; failed: { brainId: string; error: string }[] }> {
  const failed: { brainId: string; error: string }[] = [];
  let moved = 0;
  let pages = 0;
  for (const brainId of liveBrains()) {
    if (modeOf(brainId) !== "database") continue;
    try {
      pages += await migrateBrain(brainId);
      moved++;
    } catch (err) {
      failed.push({ brainId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const waiting = (db.prepare(`SELECT DISTINCT brain_id FROM wiki_changes`).all() as Row[]).map((row) => String(row.brain_id));
  for (const brainId of liveBrains()) {
    if (modeOf(brainId) !== "git") continue;
    if (targetRepo(brainId) !== repoOf(brainId)) {
      const from = repoOf(brainId);
      await withRepo(targetRepo(brainId), () => relocate(brainId, from, targetRepo(brainId))).catch((err) =>
        console.warn(`[tot] couldn't move the wiki's pages into ${targetRepo(brainId)}:`, err instanceof Error ? err.message : err),
      );
    }
    if (waiting.includes(brainId)) await scheduleFlush(brainId);
    const repo = repoOf(brainId);
    if (!repoExists(repo)) continue;
    await withRepo(repo, async () => {
      const outside = await commitOutsideEdits(repo);
      reconcile(brainId);
      if (outside) announce(repo, outside);
    }).catch((err) => console.warn(`[tot] couldn't read the wiki pages in ${repo}:`, err instanceof Error ? err.message : err));
  }
  return { moved, pages, failed };
}
