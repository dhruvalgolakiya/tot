/**
 * The workspace panel: a chat that works in a project folder or a worktree of its own (ChatWorkspace) shows
 * that folder beside it. Everything is scoped to that one folder on this Mac; a paired device may read but
 * never change it, and only this computer (or the owner signed in on another device) gets a terminal.
 *
 * GET    /api/conversations/:id/workspace                 -> WorkspaceInfo  (always 200; `available` says whether the rest works)
 * GET    /api/conversations/:id/workspace/events          -> SSE: { type: "changed" } when files in it change (debounced)
 * GET    /api/conversations/:id/workspace/diff            -> WorkspaceDiff  (working tree and untracked files vs HEAD)
 * GET    /api/conversations/:id/workspace/diff/file?path=&old= -> WorkspaceFileDiff  (`old`: a renamed file's path before)
 * GET    /api/conversations/:id/workspace/files           -> WorkspaceFiles (what git doesn't ignore)
 * GET    /api/conversations/:id/workspace/file?path=      -> WorkspaceFile
 * GET    /api/conversations/:id/workspace/raw?path=       -> an image's bytes, for its preview
 * PUT    /api/conversations/:id/workspace/file            WorkspaceSave -> WorkspaceSaved  (409 when it changed since it was read)
 * GET    /api/conversations/:id/workspace/search?q=&case=1&regex=1 -> WorkspaceSearch
 * GET    /api/conversations/:id/workspace/terminals       -> WorkspaceTerminal[]
 * POST   /api/conversations/:id/workspace/terminals       { cols, rows } -> WorkspaceTerminal
 * GET    /api/workspace/terminals/:tid/stream             -> SSE: TerminalEvent (what it printed lately first)
 * POST   /api/workspace/terminals/:tid/input              { data } -> { ok: true }
 * POST   /api/workspace/terminals/:tid/resize             { cols, rows } -> { ok: true }
 * DELETE /api/workspace/terminals/:tid                    -> { ok: true }
 * GET    /api/conversations/:id/workspace/servers         -> WorkspaceServer[]  (dev servers running from the folder; this Mac only)
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

export interface WorkspaceFiles {
  /** Every file, as paths relative to the folder, sorted; ignored files left out. */
  files: string[];
  truncated: boolean;
}

export interface WorkspaceFile {
  path: string;
  kind: "text" | "image" | "binary" | "too-large";
  /** The text, for kind "text". */
  content?: string;
  size: number;
  /** Last modified (ms): saving sends it back, so a file changed meanwhile isn't overwritten. */
  mtime: number;
}

export interface WorkspaceSave {
  path: string;
  content: string;
  /** The mtime the edit started from; omitted to write whatever is there. */
  baseMtime?: number;
}

export interface WorkspaceSaved {
  path: string;
  size: number;
  mtime: number;
}

export interface WorkspaceSearchHit {
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based, in characters. */
  column: number;
  text: string;
}

export interface WorkspaceSearch {
  hits: WorkspaceSearchHit[];
  /** More matches than are listed. */
  truncated: boolean;
}

export interface WorkspaceTerminal {
  id: string;
  conversationId: string;
  /** "zsh 1". */
  title: string;
  createdAt: number;
  /** Null while it runs. */
  exitCode: number | null;
}

/** What a terminal's stream sends: its output (what it printed lately first), and its end. */
export type TerminalEvent = { type: "output"; data: string } | { type: "exit"; exitCode: number };

/** A dev server running from the chat's folder, to preview in the Browser tab. */
export interface WorkspaceServer {
  port: number;
  url: string;
  /** The process listening ("node"); empty when only a terminal's output named it. */
  command: string;
  pid: number | null;
  /** How it was found: a process working in the folder, or an address a terminal printed. */
  source: "process" | "terminal";
}
