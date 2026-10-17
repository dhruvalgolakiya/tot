import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { LocalSession, ProviderAccount, ProviderId } from "@tot/shared/types";
import { accountDir, accounts, accountsHome, dirExists, tildePath } from "../accounts/accounts.ts";
import { projectRepos } from "../projects/repos.ts";
import { claudeEvents, isClaudeSessionFile, mayHoldFolder } from "./claude.ts";
import { codexEvents, codexThreadNames, isCodexSessionFile } from "./codex.ts";
import type { SessionEvent } from "./events.ts";
import { summarize, type SessionSummary } from "./transcript.ts";

/**
 * Finding a project's Claude Code and Codex sessions on this Mac: in every folder TOT knows the CLIs keep them (its
 * accounts' and the default ones), the sessions that ran in one of the project's folders, below it, or in one of its
 * worktrees. Only reads: the CLIs' files, and git's own worktree files in the project's folders (git itself isn't
 * run). A file is read once per version (its size and time), and a call stops waiting after a few seconds on a very
 * large history, saying so; the reading goes on, so the next call has more.
 */

/** A folder a CLI keeps sessions in, and the account using it (null: none does). */
export interface SessionSource {
  driver: ProviderId;
  dir: string;
  account: ProviderAccount | null;
}

export interface SessionFile {
  path: string;
  source: SessionSource;
  /** Size and time: a file is read again only when they change. */
  stamp: string;
}

/** A folder the project's sessions may have run in: a repo's main folder, or one of its worktrees. */
interface ProjectRoot {
  path: string;
  main: boolean;
  branch: string | null;
  /** The project repo's folder it belongs to. */
  repoFolder: string;
}

/** Where in the project a session ran. */
export interface SessionPlace {
  /** The repo folder's main checkout it belongs to. */
  repoFolder: string;
  /** The worktree it ran in, null for the main folder (or below it). */
  worktree: string | null;
  branch: string | null;
}

/** A session of the project, as found: its file, what it says, and where it ran. */
export interface FoundSession {
  key: string;
  driver: ProviderId;
  sessionId: string;
  file: SessionFile;
  summary: SessionSummary & { cwd: string };
  place: SessionPlace;
}

const TOT_WORKTREES = "/.tot-worktrees/";
/** How many files are read at once. */
const PARALLEL = 8;
const MAX_WORKTREES = 200;

const realOr = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
};

/** Every account's folder, then the default ones (unless an account uses them), once each. */
export function sessionSources(): SessionSource[] {
  const found = new Map<string, SessionSource>();
  const add = (driver: ProviderId, dir: string, account: ProviderAccount | null) => {
    const key = `${driver}:${realOr(dir)}`;
    if (!found.has(key) && dirExists(dir)) found.set(key, { driver, dir, account });
  };
  for (const account of accounts.list()) add(account.driver, accountDir(account), account);
  add("claude", join(accountsHome(), ".claude"), null);
  add("chatgpt", join(accountsHome(), ".codex"), null);
  return [...found.values()];
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function headBranch(gitDir: string): string | null {
  return /^ref: refs\/heads\/(.+)$/m.exec(readText(join(gitDir, "HEAD")))?.[1]?.trim() ?? null;
}

/**
 * A folder repo's main checkout and its worktrees with their branches, from git's own files (what `git worktree list`
 * reads). A folder that's itself a worktree of a repo elsewhere stands alone: the rest of that repo isn't the project.
 */
export function gitWorktrees(folder: string): ProjectRoot[] {
  const gitDir = join(folder, ".git");
  const alone = [{ path: folder, main: true, branch: null, repoFolder: folder }];
  try {
    if (!lstatSync(gitDir).isDirectory()) return alone;
  } catch {
    return alone;
  }
  const roots: ProjectRoot[] = [{ path: folder, main: true, branch: headBranch(gitDir), repoFolder: folder }];
  let names: string[] = [];
  try {
    names = readdirSync(join(gitDir, "worktrees")).slice(0, MAX_WORKTREES);
  } catch {
    return roots;
  }
  for (const name of names) {
    const entry = join(gitDir, "worktrees", name);
    const pointer = readText(join(entry, "gitdir")).trim();
    if (pointer) roots.push({ path: dirname(resolve(entry, pointer)), main: false, branch: headBranch(entry), repoFolder: folder });
  }
  return roots;
}

/** The project's folder repos' main folders and worktrees, each under its real path too when that differs. */
export function projectRoots(projectId: string): ProjectRoot[] {
  const roots: ProjectRoot[] = [];
  const seen = new Set<string>();
  for (const repo of projectRepos.list(projectId)) {
    if (repo.kind !== "folder") continue;
    for (const root of gitWorktrees(repo.source)) {
      for (const path of new Set([root.path, realOr(root.path)])) {
        if (seen.has(path)) continue;
        seen.add(path);
        roots.push({ ...root, path });
      }
    }
  }
  return roots;
}

const inside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/** Where a session that ran in `cwd` sits in the project; null when it's not in it. */
export function placeOf(cwd: string, roots: ProjectRoot[], recordedBranch: string | null): SessionPlace | null {
  let best: ProjectRoot | null = null;
  for (const root of roots) if (inside(cwd, root.path) && (!best || root.path.length > best.path.length)) best = root;
  if (!best) return null;
  if (!best.main) return { repoFolder: best.repoFolder, worktree: best.path, branch: best.branch ?? recordedBranch ?? basename(best.path) };
  // A TOT worktree that's gone from git's list (removed since) is still under the folder's .tot-worktrees.
  const rest = cwd.slice(best.path.length);
  const tot = rest.startsWith(TOT_WORKTREES) ? rest.slice(TOT_WORKTREES.length).split("/")[0] : "";
  if (tot) return { repoFolder: best.repoFolder, worktree: `${best.path}${TOT_WORKTREES}${tot}`, branch: recordedBranch ?? tot };
  return { repoFolder: best.repoFolder, worktree: null, branch: null };
}

// --- Reading files, once per version -----------------------------------------------------------------------------

interface Head {
  cwd: string | null;
  sessionId: string | null;
  subagent: boolean;
}

const heads = new Map<string, { stamp: string; value: Promise<Head> }>();
const summaries = new Map<string, { stamp: string; value: Promise<SessionSummary> }>();

function eventsOf(file: SessionFile, light: boolean): AsyncGenerator<SessionEvent> {
  return file.source.driver === "claude" ? claudeEvents(file.path, { light }) : codexEvents(file.path, { light });
}

/** How far into a file its folder is looked for. */
const HEAD_EVENTS = 400;

/** The folder a session ran in, from its first records (without reading it all). */
async function readHead(file: SessionFile): Promise<Head> {
  let seen = 0;
  for await (const event of eventsOf(file, true)) {
    if (event.type === "meta" && event.cwd) return { cwd: event.cwd, sessionId: event.sessionId ?? null, subagent: Boolean(event.subagent) };
    if (++seen >= HEAD_EVENTS) break;
  }
  return { cwd: null, sessionId: null, subagent: false };
}

function once<T>(cache: Map<string, { stamp: string; value: Promise<T> }>, file: SessionFile, read: (file: SessionFile) => Promise<T>): Promise<T> {
  const cached = cache.get(file.path);
  if (cached?.stamp === file.stamp) return cached.value;
  const value = read(file);
  cache.set(file.path, { stamp: file.stamp, value });
  // A file that couldn't be read is tried again next time.
  value.catch(() => cache.get(file.path)?.value === value && cache.delete(file.path));
  return value;
}

export function summaryOf(file: SessionFile): Promise<SessionSummary> {
  return once(summaries, file, (f) => summarize(eventsOf(f, true)));
}

// --- Listing files -----------------------------------------------------------------------------------------------

async function filesIn(dir: string, source: SessionSource, accept: (name: string) => boolean): Promise<SessionFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = await Promise.all(
    names.filter(accept).map(async (name): Promise<SessionFile | null> => {
      const path = join(dir, name);
      try {
        const info = await stat(path);
        return info.isFile() ? { path, source, stamp: `${info.size}:${info.mtimeMs}` } : null;
      } catch {
        return null;
      }
    }),
  );
  return files.filter((file): file is SessionFile => file !== null);
}

/** A Claude folder's session files in the projects folders that may hold the project's folders. */
async function claudeFiles(source: SessionSource, roots: ProjectRoot[]): Promise<SessionFile[]> {
  const projects = join(source.dir, "projects");
  let names: string[];
  try {
    names = await readdir(projects);
  } catch {
    return [];
  }
  const wanted = names.filter((name) => roots.some((root) => mayHoldFolder(name, root.path)));
  return (await Promise.all(wanted.map((name) => filesIn(join(projects, name), source, isClaudeSessionFile)))).flat();
}

/** A Codex home's rollouts, newest first (their folders are dates). */
async function codexFiles(source: SessionSource): Promise<SessionFile[]> {
  const walk = async (dir: string, depth: number): Promise<SessionFile[]> => {
    if (depth === 0) return filesIn(dir, source, isCodexSessionFile);
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => /^\d+$/.test(name)).sort().reverse();
    } catch {
      return [];
    }
    const out: SessionFile[] = [];
    for (const name of names) out.push(...(await walk(join(dir, name), depth - 1)));
    return out;
  };
  const files = [...(await walk(join(source.dir, "sessions"), 3)), ...(await filesIn(join(source.dir, "archived_sessions"), source, isCodexSessionFile))];
  return files.sort((a, b) => basename(b.path).localeCompare(basename(a.path)));
}

/** Runs `work` on each item, a few at a time; never rejects. */
async function pool<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, lane));
}

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

async function examine(file: SessionFile, roots: ProjectRoot[]): Promise<FoundSession | null> {
  const head = await once(heads, file, readHead);
  // Read whole only once its first records put it in the project (a Codex home holds every project's threads).
  if (!head.cwd || head.subagent || !placeOf(head.cwd, roots, null)) return null;
  const summary = await summaryOf(file);
  const cwd = summary.cwd ?? head.cwd;
  const place = placeOf(cwd, roots, summary.branch);
  if (!place || summary.subagent || !summary.firstPrompt) return null;
  // Claude Code names a session's file after it; a Codex thread's id is in its first record (and its file name).
  const fromName = UUID.exec(file.path)?.[1] ?? null;
  const sessionId = file.source.driver === "claude" ? fromName : (head.sessionId ?? fromName);
  if (!sessionId) return null;
  const driver = file.source.driver;
  return { key: `${driver}:${sessionId}`, driver, sessionId, file, summary: { ...summary, cwd }, place };
}

/** The project's sessions; `partial` when some files weren't read within `budgetMs` (they still are, for next time). */
export async function discover(projectId: string, { budgetMs = 8_000 } = {}): Promise<{ sessions: FoundSession[]; partial: boolean }> {
  const roots = projectRoots(projectId);
  if (!roots.length) return { sessions: [], partial: false };
  const sources = sessionSources();
  const files = (await Promise.all(sources.map((source) => (source.driver === "claude" ? claudeFiles(source, roots) : codexFiles(source))))).flat();
  const found: FoundSession[] = [];
  const all = pool(files, async (file) => {
    const session = await examine(file, roots);
    if (session) found.push(session);
  });
  let timer: NodeJS.Timeout | undefined;
  const finished = await Promise.race([all.then(() => true), new Promise<false>((done) => (timer = setTimeout(() => done(false), budgetMs)))]);
  clearTimeout(timer);
  // One session can be in two folders (copied into an account's): the account's copy, else the newest, stands for it.
  const byKey = new Map<string, FoundSession>();
  for (const session of found) {
    const current = byKey.get(session.key);
    const better =
      !current ||
      (Boolean(session.file.source.account) !== Boolean(current.file.source.account)
        ? Boolean(session.file.source.account)
        : session.summary.lastAt > current.summary.lastAt);
    if (better) byKey.set(session.key, session);
  }
  return { sessions: [...byKey.values()].sort((a, b) => b.summary.lastAt - a.summary.lastAt), partial: !finished };
}

/** Text on one line, cut to `max` characters. */
export function titleLine(text: string, max = 120): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A found session as the list shows it. */
export function toLocalSession(session: FoundSession, imported: Map<string, string>): LocalSession {
  const { summary, file, place } = session;
  const account = file.source.account;
  const title = codexTitle(session) ?? summary.title;
  return {
    key: session.key,
    driver: session.driver,
    sessionId: session.sessionId,
    accountId: account?.id ?? null,
    accountName: account?.name ?? tildePath(file.source.dir),
    cwd: summary.cwd,
    worktree: place.worktree !== null,
    branch: place.branch,
    title: titleLine(title || summary.firstPrompt),
    firstPrompt: titleLine(summary.firstPrompt, 400),
    messageCount: summary.messages,
    lastActivityAt: summary.lastAt || Number(file.stamp.split(":")[1]) || 0,
    importedChatId: imported.get(session.key) ?? null,
  };
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** A Codex thread's own name (its home's session_index.jsonl), if it has one. */
export function codexTitle(session: FoundSession): string | null {
  return session.driver === "chatgpt" ? (codexThreadNames(session.file.source.dir, mtimeOf).get(session.sessionId) ?? null) : null;
}
