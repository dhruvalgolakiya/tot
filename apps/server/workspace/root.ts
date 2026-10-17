import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import type { Project } from "@tot/shared/types";
import { HttpError } from "../agent/orchestrator.ts";
import { chatWorkspaces } from "../chats/workspace.ts";
import type { FolderGrant } from "../computer/types.ts";
import { computers } from "../data/computers.ts";
import { conversations, type ConversationRecord } from "../data/conversations.ts";
import { grantFor } from "../projects/checkout.ts";
import { FolderRefused, gitState, resolveFolder, tildePath } from "../projects/folders.ts";
import { projects } from "../projects/projects.ts";
import { projectRepos, type RepoRecord } from "../projects/repos.ts";
import { homeRelative } from "../tasks/worktree.ts";

/**
 * The folder on this Mac a chat's workspace panel shows: its worktree once made, or the project's main
 * checkout (a folder project's folder, or a GitHub project's clone on the agent's local computer). A Boat VM's
 * files aren't on this Mac, so a chat whose agent works there gets no panel.
 *
 * Every path the panel asks for is resolved here, inside that folder: no "..", no absolute paths, nothing in
 * git's own folder (its config and hooks run outside any sandbox), and no symlink that leads out of it. The
 * folder itself is checked as well, since an agent may change what's in its computer's workspace: a clone or a
 * worktree replaced by a link elsewhere is refused.
 */

const NO_WORKSPACE = "This chat doesn't work in a project folder.";

export interface ChatSpace {
  chat: ConversationRecord;
  /** The folder's real path on this Mac. */
  root: string;
  label: string;
  mode: "checkout" | "worktree";
  /** Whether git runs here as TOT itself (the user's own main checkout) or on the chat's computer, sandboxed. */
  gitHost: "tot" | "computer";
  /** For git on the computer: where its commands start, and the chat's folder grant. */
  workDir: string | null;
  grant: FolderGrant | null;
  /** The branch it started from, for a worktree. */
  baseBranch: string | null;
  git: boolean;
}

const isIn = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

function realOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/** The repo a chat works in: the one its worktree names, or the project's primary. */
function repoOf(project: Project, chat: ConversationRecord): RepoRecord | null {
  const workspace = chat.workspace!;
  return (workspace.mode === "worktree" ? projectRepos.get(project.id, workspace.repo) : null) ?? projectRepos.primary(project.id);
}

/** A folder project's folder, as long as it's still where it was added and agents may use it. */
function userFolder(repo: RepoRecord, project: Project): string {
  const shown = tildePath(repo.source);
  if (!repo.folderGranted) throw new HttpError(409, `TOT can't use ${shown} yet: allow it on the ${project.name} project's page.`);
  try {
    if (resolveFolder(repo.source) === repo.source) return repo.source;
  } catch (err) {
    throw new HttpError(409, err instanceof FolderRefused ? `${shown} can't be used: ${err.message}` : `${shown} can't be used.`);
  }
  throw new HttpError(409, `${shown} has moved or changed.`);
}

function resolveSpace(chat: ConversationRecord): ChatSpace {
  const workspace = chat.kind === "task" ? null : chat.workspace;
  const project = workspace ? projects.get(chat.projectId) : null;
  const own = project ? repoOf(project, chat) : null;
  if (!workspace || !project || !own) throw new HttpError(400, NO_WORKSPACE);
  if (workspace.mode === "worktree" && (!workspace.created || !workspace.worktree)) {
    throw new HttpError(409, "This chat's worktree is made with its first message.");
  }
  const computer = computers.getByAgent(chat.agentId);
  // A folder on this Mac is the user's own: it shows whatever computer the agent has. A clone is only here on a local one.
  let path: string;
  let within: string;
  if (own.kind === "folder") {
    within = userFolder(own, project);
    path = workspace.mode === "worktree" ? workspace.worktree! : within;
  } else {
    if (computer && computer.kind !== "local") throw new HttpError(409, "This chat works on a cloud computer, so its files aren't on this Mac.");
    if (!computer?.workspacePath || !projectRepos.folder(own)) throw new HttpError(409, "The project is cloned onto the agent's computer with this chat's first message.");
    within = realOrNull(computer.workspacePath) ?? computer.workspacePath;
    path = join(within, homeRelative(workspace.mode === "worktree" ? workspace.worktree! : projectRepos.folder(own)));
  }
  const root = realOrNull(path);
  if (!root || !statSync(root).isDirectory()) throw new HttpError(409, `${tildePath(path)} is gone.`);
  if (!isIn(root, within)) throw new HttpError(409, `${tildePath(path)} now leads somewhere else, so TOT won't show it.`);
  const host = own.kind === "folder" && workspace.mode === "checkout";
  let grant: FolderGrant | null = null;
  let workDir: string | null = null;
  if (!host) {
    try {
      grant = grantFor(chat);
    } catch {
      grant = null;
    }
    workDir = chatWorkspaces.workDir(chat, grant);
  }
  return {
    chat,
    root,
    label: tildePath(root),
    mode: workspace.mode,
    gitHost: host ? "tot" : "computer",
    workDir,
    grant,
    baseBranch: workspace.mode === "worktree" ? workspace.baseBranch : null,
    git: gitState(root) !== "none",
  };
}

export const chatSpaces = {
  /** The chat's folder; throws, in words for the user, when it has none on this Mac. */
  resolve(chatId: string): ChatSpace {
    const chat = conversations.get(chatId);
    if (!chat) throw new HttpError(404, "Chat not found.");
    return resolveSpace(chat);
  },

  /** The same, or null (for listeners deciding whether a chat still has its folder). */
  tryResolve(chatId: string): ChatSpace | null {
    try {
      return chatSpaces.resolve(chatId);
    } catch {
      return null;
    }
  },
};

/**
 * A relative path as the panel sends it, normalized ("src/app.ts"); "" for the folder itself. Refuses what
 * could leave the folder or reach git's own files.
 */
export function cleanPath(input: unknown): string {
  if (typeof input !== "string" || input.length > 4096 || /[\x00-\x1f\x7f]/.test(input)) throw new HttpError(400, "That isn't a path in this folder.");
  const path = posix.normalize(input.replaceAll("\\", "/")).replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (path === "." || path === "") return "";
  if (path.startsWith("/") || path === ".." || path.startsWith("../")) throw new HttpError(400, `"${input}" is outside this chat's folder.`);
  const parts = path.split("/");
  if (parts.includes(".git")) throw new HttpError(403, "Git's own files aren't shown here.");
  if (parts[0] === ".tot-worktrees") throw new HttpError(403, "Other chats' and tasks' worktrees aren't shown here.");
  return path;
}

/**
 * Where a relative path is in the folder, checked: the path itself and every folder on the way must stay
 * inside it once symlinks are followed. `exists` also requires something to be there.
 */
export function inside(root: string, input: unknown, { exists = true } = {}): { path: string; rel: string } {
  const rel = cleanPath(input);
  const target = rel ? join(root, rel) : root;
  let probe = target;
  while (!existsSync(probe) && probe !== root && isIn(probe, root)) probe = dirname(probe);
  const real = realOrNull(probe);
  if (!real || !isIn(real, root)) throw new HttpError(403, `"${rel}" leads outside this chat's folder.`);
  if (probe !== target) {
    if (exists) throw new HttpError(404, `There's no ${rel} in this folder.`);
    return { path: join(real, relative(probe, target)), rel };
  }
  return { path: real, rel };
}

/** Whether a path is a symlink (lstat): a file to write must not be one. */
export function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
