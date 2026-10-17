import { isAbsolute, join, posix } from "node:path";
import type { ChatFiles } from "@tot/shared/types";
import { computerManager, type ActiveComputer } from "../computer/manager.ts";
import type { FolderGrant } from "../computer/types.ts";
import type { ConversationRecord } from "../data/conversations.ts";
import { grantFor } from "../projects/checkout.ts";
import { projects } from "../projects/projects.ts";
import { projectRepos } from "../projects/repos.ts";
import { homeRelative } from "../tasks/worktree.ts";
import { chatWorkspaces } from "./workspace.ts";

/**
 * Files the composer offers after "@" (and that a message then names): the ones in the folder a chat works in, from
 * git (tracked and untracked, without what .gitignore leaves out) or, outside a repo, every file. Listed on the agent's
 * computer the way its own commands run (through a folder on this Mac's grant), but never by waking a cloud computer
 * that's off: the menu just says so. A chat's list is kept for a little while, so typing narrows it at once.
 */

const LIST_TTL_MS = 30_000;
const LIST_TIMEOUT_MS = 15_000;
const MAX_FILES = 50_000;
const DEFAULT_MATCHES = 30;
/** A message names at most this many files; small text ones are put in its prompt, up to these sizes. */
const MAX_MENTIONS = 20;
const MAX_INLINE_BYTES = 12_000;
const MAX_INLINE_TOTAL = 40_000;

// git's view when the folder is in a repo that has files there (a folder the repo ignores has none), else every file.
const GIT_LIST = "git -c core.quotepath=off ls-files --cached --others --exclude-standard";
const LIST_SCRIPT =
  `if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && [ -n "$(${GIT_LIST} | head -n 1)" ]; then ${GIT_LIST}; ` +
  `else find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null | sed 's|^\\./||'; fi | head -n ${MAX_FILES + 1}`;

type Chat = Pick<ConversationRecord, "id" | "agentId" | "projectId" | "kind" | "title" | "task"> & Pick<Partial<ConversationRecord>, "workspace">;

/** Where a chat's files are: the folder its commands start in, relative to its computer's home (or a real path on this Mac). */
interface Root {
  agentId: string;
  dir: string;
  grant: FolderGrant | null;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The chat's working folder: a task's worktree, the chat's own worktree or checkout, else its project's main repo. */
function rootOf(chat: Chat): Root | { unavailable: string } | null {
  const taskDir = chat.kind === "task" && chat.task?.repo?.headSha ? homeRelative(chat.task.repo.worktree) : null;
  const project = projects.get(chat.projectId);
  const own = project ? projectRepos.primary(project.id) : null;
  if (!taskDir && !own) return null;
  let grant: FolderGrant | null = null;
  if (computerManager.kindFor(chat.agentId) === "local") {
    try {
      grant = grantFor(chat);
    } catch (err) {
      return { unavailable: errorText(err) };
    }
  }
  const main = own?.kind === "folder" ? (grant?.folder ?? null) : own?.checkout ? homeRelative(own.checkout) : null;
  const dir = taskDir ?? chatWorkspaces.workDir(chat, grant) ?? main;
  if (!dir) {
    return { unavailable: own?.kind === "folder" ? "This project's folder is on your Mac: its files show for agents with a local computer." : "This project's files aren't set up yet." };
  }
  return { agentId: chat.agentId, dir, grant };
}

/** The agent's computer, when it's on (or local, which costs nothing to bring up); null for a cloud computer that's off. */
async function computerFor(agentId: string): Promise<ActiveComputer | null> {
  const kind = computerManager.kindFor(agentId);
  if (!kind) return null;
  if (kind !== "local" && computerManager.get(agentId)?.state !== "running") return null;
  return computerManager.ensure(agentId);
}

const lists = new Map<string, { at: number; files: Promise<string[]> }>();

async function readList(active: ActiveComputer, root: Root): Promise<string[]> {
  const result = await active.backend.exec(active.externalId, LIST_SCRIPT, { cwd: root.dir, timeoutMs: LIST_TIMEOUT_MS, grant: root.grant });
  if (result.exitCode !== 0 && !result.stdout.trim()) throw new Error(result.stderr.trim().split("\n").pop() || `exit code ${result.exitCode}`);
  return result.stdout.split("\n").filter((line) => line && !line.startsWith(".tot-worktrees/"));
}

/** Where `dir` is on this Mac, when it is (a folder project, or a local computer's home): for paths dragged in. */
function hostPath(active: ActiveComputer, root: Root): string | null {
  if (active.backend.kind !== "local") return null;
  return isAbsolute(root.dir) ? root.dir : join(active.backend.home(active.externalId), root.dir);
}

/**
 * Ranks paths for what's typed after "@": the file's name first (exact, then its start, then anywhere in it), then the
 * path, then letters in order (word starts and runs count most); shorter paths break ties.
 */
export function rankFiles(files: string[], query: string, limit = DEFAULT_MATCHES): string[] {
  const needle = query.trim().toLowerCase().replace(/^\.\//, "");
  if (!needle) return [...files].sort((a, b) => depth(a) - depth(b) || a.length - b.length || a.localeCompare(b)).slice(0, limit);
  const scored: { path: string; score: number }[] = [];
  for (const path of files) {
    const score = scoreOf(path.toLowerCase(), needle);
    if (score > 0) scored.push({ path, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((entry) => entry.path);
}

const depth = (path: string) => path.split("/").length;

function scoreOf(path: string, needle: string): number {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!needle.includes("/")) {
    if (name === needle) return 1000;
    if (name.startsWith(needle)) return 900 - name.length;
    const at = name.indexOf(needle);
    if (at >= 0) return 800 - at - name.length / 10;
  }
  const at = path.indexOf(needle);
  if (at >= 0) return 600 - path.length / 10 + (at === 0 || path[at - 1] === "/" ? 50 : 0);
  return subsequence(path, needle);
}

/** The needle's letters in order in the path: 0 when they aren't; more for word starts and letters in a row. */
function subsequence(path: string, needle: string): number {
  let score = 100;
  let from = 0;
  let previous = -2;
  for (const char of needle) {
    const at = path.indexOf(char, from);
    if (at < 0) return 0;
    if (at === previous + 1) score += 8;
    if (at === 0 || "/._-".includes(path[at - 1]!)) score += 6;
    score -= Math.min(at - from, 10);
    previous = at;
    from = at + 1;
  }
  // Letters that land in the file's name count more than ones spread over its folders.
  if (previous > path.lastIndexOf("/")) score += 20;
  return Math.max(1, score - path.length / 20);
}

export const chatFiles = {
  /** GET …/files: the files matching `query`, best first. */
  async list(chat: Chat, query: string, limit = DEFAULT_MATCHES): Promise<ChatFiles> {
    const root = rootOf(chat);
    if (!root) return { files: [], total: 0, root: null, unavailable: "This chat isn't in a project with files." };
    if ("unavailable" in root) return { files: [], total: 0, root: null, unavailable: root.unavailable };
    const active = await computerFor(root.agentId).catch(() => null);
    if (!active) return { files: [], total: 0, root: null, unavailable: "Files show once the agent's computer is on." };
    const key = `${root.agentId}|${root.dir}`;
    let entry = lists.get(key);
    if (!entry || Date.now() - entry.at > LIST_TTL_MS) {
      entry = { at: Date.now(), files: readList(active, root) };
      lists.set(key, entry);
      // A failed listing isn't kept: the next keystroke tries again.
      entry.files.catch(() => lists.get(key) === entry && lists.delete(key));
    }
    let files: string[];
    try {
      files = await entry.files;
    } catch (err) {
      return { files: [], total: 0, root: null, unavailable: `The files couldn't be listed: ${errorText(err)}` };
    }
    return {
      files: rankFiles(files.slice(0, MAX_FILES), query, Math.min(Math.max(limit, 1), 100)),
      total: Math.min(files.length, MAX_FILES),
      root: hostPath(active, root),
      ...(files.length > MAX_FILES ? { truncated: true } : {}),
    };
  },

  /** The paths a message names, kept to relative ones inside the chat's folder (no "..", no absolute paths), at most 20. */
  clean(paths: unknown): string[] {
    if (!Array.isArray(paths)) return [];
    const clean = paths
      .filter((path): path is string => typeof path === "string")
      .map((path) => posix.normalize(path.trim().replace(/^\.\/+/, "")))
      .filter((path) => path && path !== "." && !path.startsWith("/") && !path.startsWith("../") && path !== "..");
    return [...new Set(clean)].slice(0, MAX_MENTIONS);
  },

  /**
   * What the model gets for the files a message names: their paths, with the small text ones' contents (read where its
   * tools would read them). A cloud computer that's off isn't woken for this: the model reads them itself.
   */
  async note(chat: Chat, paths: string[]): Promise<string> {
    if (!paths.length) return "";
    const root = rootOf(chat);
    const listed = paths.map((path) => `- ${path}`).join("\n");
    const intro = `[The user mentioned these files, relative to your working folder:\n${listed}]`;
    if (!root || "unavailable" in root) return intro;
    const active = await computerFor(root.agentId).catch(() => null);
    if (!active) return intro;
    const blocks: string[] = [];
    let total = 0;
    for (const path of paths) {
      try {
        const content = await active.backend.readFile(active.externalId, `${root.dir}/${path}`, { grant: root.grant });
        const size = Buffer.byteLength(content);
        if (size > MAX_INLINE_BYTES || total + size > MAX_INLINE_TOTAL || content.includes("\u0000")) continue;
        total += size;
        blocks.push(`<file path="${path}">\n${content}\n</file>`);
      } catch {
        // Not readable as text (a folder, gone, too big for the backend): the path above is enough.
      }
    }
    return [intro, ...blocks].join("\n\n");
  },

  /** Forgets cached lists (tests; a chat whose files just changed lists them afresh after the TTL anyway). */
  reset(): void {
    lists.clear();
  },
};
