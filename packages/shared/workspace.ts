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
 * GET    /api/conversations/:id/workspace/terminals/stream -> SSE: TerminalStreamEvent, for every terminal of the chat
 *                                                          (what each printed lately first, then terminals opened later too)
 * POST   /api/workspace/terminals/:tid/input              { data } -> { ok: true }
 * POST   /api/workspace/terminals/:tid/resize             { cols, rows } -> { ok: true }
 * DELETE /api/workspace/terminals/:tid                    -> { ok: true }
 * GET    /api/conversations/:id/workspace/servers         -> WorkspaceServer[]  (dev servers running from the folder; this Mac only)
 * GET    /api/conversations/:id/workspace/git             -> WorkspaceGit
 * POST   /api/conversations/:id/workspace/git/message     -> { message: string }  (a suggested commit message; "" with nothing to commit)
 * POST   /api/conversations/:id/workspace/git/commit      WorkspaceCommit -> WorkspaceGitResult
 * POST   /api/conversations/:id/workspace/git/push        { confirmDefault? } -> WorkspaceGitResult
 * POST   /api/conversations/:id/workspace/git/pull        -> WorkspaceGitResult  (fast-forward only)
 * POST   /api/conversations/:id/workspace/git/sync        { confirmDefault? } -> WorkspaceGitResult  (pull, then push)
 * Pushing to the repo's default branch is refused (409) unless `confirmDefault` is true.
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

/** What a terminal sends: its output (what it printed lately first), and its end. */
export type TerminalEvent = { type: "output"; data: string } | { type: "exit"; exitCode: number };

/** A chat's terminal stream: each terminal's events, with its id. */
export type TerminalStreamEvent = TerminalEvent & { id: string };

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

export interface WorkspaceGit {
  branch: string | null;
  /** The repo's default branch ("main"), when known. */
  defaultBranch: string | null;
  /** The branch on the remote a push lands on (the branch's push destination, else what it tracks, else its name). */
  pushesTo: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Files changed or new. */
  changes: number;
  /** "owner/name" when origin is on GitHub. */
  github: string | null;
  /** Whether a draft pull request can be opened from here (on GitHub, connected, allowed to write). */
  canOpenPr: boolean;
  /** Why not, when it can't. */
  prProblem: string | null;
}

export interface WorkspaceCommit {
  message: string;
  push?: boolean;
  /** Push, then open a draft pull request into the default branch (a worktree's: the branch it started from). */
  pr?: boolean;
  /** Pushing to the default branch itself, which the user confirmed. */
  confirmDefault?: boolean;
}

export interface WorkspaceGitResult {
  git: WorkspaceGit;
  /** What happened, for a toast ("Committed 3 files, pushed"). */
  summary: string;
  pr?: { number: number; url: string };
}
