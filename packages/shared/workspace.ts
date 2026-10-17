/**
 * The workspace panel: a chat that works in a project folder or a worktree of its own (ChatWorkspace) shows
 * that folder beside it. Everything is scoped to that one folder on this Mac; a paired device may read but
 * never change it, and only this computer (or the owner signed in on another device) gets a terminal.
 *
 * GET    /api/conversations/:id/workspace                 -> WorkspaceInfo  (always 200; `available` says whether the rest works)
 * GET    /api/conversations/:id/workspace/events          -> SSE: { type: "changed" } when files in it change (debounced)
 * GET    /api/conversations/:id/workspace/diff            -> WorkspaceDiff  (working tree and untracked files vs HEAD)
 * GET    /api/conversations/:id/workspace/diff/file?path=&old= -> WorkspaceFileDiff  (`old`: a renamed file's path before)
 */

export type WorkspaceTab = "diff" | "files" | "terminal" | "browser";

export interface WorkspaceInfo {
  available: boolean;
  /** Why the panel can't show this chat's folder, in words for the user, when it can't. */
  reason: string | null;
  /** The folder as the user knows it ("~/code/web", or the worktree's own folder). */
  label: string | null;
  mode: "checkout" | "worktree" | null;
  /** Whether the folder is a git repo. */
  git: boolean;
  /** Whether this caller may change files and run git (not a paired device). */
  canWrite: boolean;
  /** Whether this caller may open terminals: this computer, or the owner signed in on another device. */
  canTerminal: boolean;
}

export type WorkspaceChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface WorkspaceChange {
  path: string;
  /** A renamed file's path before. */
  oldPath?: string;
  status: WorkspaceChangeStatus;
  added: number;
  removed: number;
  binary: boolean;
}

export interface WorkspaceDiff {
  /** The checked-out branch; null when detached, or not a git repo. */
  branch: string | null;
  files: WorkspaceChange[];
  /** More files changed than are listed. */
  truncated: boolean;
}

export interface WorkspaceFileDiff {
  path: string;
  /** The file's unified diff (git's), headers included; empty when it hasn't changed. */
  patch: string;
  binary: boolean;
  /** Only the start of a very large diff came. */
  truncated: boolean;
}
