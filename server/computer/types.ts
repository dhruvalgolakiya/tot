import type { ComputerKind } from "../../shared/types.ts";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

export type ComputerSize = "small" | "default" | "large";

/**
 * A folder on this Mac that a local computer may use for one command (module 06). It can read all
 * of it; a task can also write its own branch, its own worktree in <folder>/.tot-worktrees and new
 * git objects, and nothing else: never the checked-out files, .git/config, hooks or other refs.
 */
export interface FolderGrant {
  /** The folder's real path. */
  folder: string;
  /** For a task: its branch ("tot/…") and its worktree's folder name in <folder>/.tot-worktrees. */
  task?: { branch: string; worktree: string };
}

/** GUI control of a computer's desktop ("computer use"). Coordinates are real screen pixels. */
export interface DesktopControl {
  /** PNG of the whole screen scaled to at most `maxWidth` px wide, plus the real screen size. */
  screenshot(externalId: string, maxWidth: number): Promise<{ png: Buffer; screenWidth: number; screenHeight: number }>;
  click(externalId: string, x: number, y: number, opts: { button: "left" | "right" | "middle"; double: boolean }): Promise<void>;
  type(externalId: string, text: string): Promise<void>;
  /** xdotool-style key names, space-separated combos: "ctrl+l", "Return", "ctrl+shift+t Tab". */
  key(externalId: string, keys: string): Promise<void>;
  scroll(externalId: string, x: number, y: number, direction: "up" | "down" | "left" | "right", amount: number): Promise<void>;
  openUrl(externalId: string, url: string): Promise<void>;
}

/** A long-running command (module 09's previews): its process group, ended by `stop`. */
export interface BackgroundProcess {
  pid: number;
  /** Resolves with its exit code (null when a signal ended it) once it's gone. */
  exited: Promise<number | null>;
  /** SIGTERM to its whole process group, SIGKILL after a moment; resolves once it has exited. */
  stop(): Promise<void>;
}

/** One way of providing computers (Boat cloud VMs, sandboxed local folders). */
export interface ComputerBackend {
  kind: ComputerKind;
  /** Whether the backend can be used right now (credentials present, platform supported...). */
  check(): Promise<{ ok: boolean; reason?: string }>;
  create(opts: { name: string; agentId: string; size: ComputerSize }): Promise<{
    externalId: string;
    label: string;
    desktopUrl?: string;
    workspacePath?: string;
  }>;
  /** Start a stopped computer again (Boat: resume from snapshot). */
  resume(externalId: string): Promise<void>;
  /** Stop billing / pause (Boat: snapshot + stop). Files must survive. */
  stop(externalId: string): Promise<void>;
  destroy(externalId: string): Promise<void>;
  /**
   * `grant` lets a local computer use a folder on this Mac for this one command (others ignore it).
   * `env` adds variables to the command's environment (a task's PORT and TOT_PORTS, module 09).
   */
  exec(
    externalId: string,
    command: string,
    opts: { cwd?: string; timeoutMs: number; grant?: FolderGrant | null; env?: Record<string, string> },
  ): Promise<ExecResult>;
  /**
   * Starts a command that keeps running (a dev server), the way `exec` runs one: same sandbox, grant and
   * environment. Its output goes to `log`, a file on this Mac. Local computers only (module 09's previews).
   */
  background?(
    externalId: string,
    command: string,
    opts: { cwd?: string; grant?: FolderGrant | null; env?: Record<string, string>; log: string },
  ): Promise<BackgroundProcess>;
  readFile(externalId: string, path: string, opts?: { grant?: FolderGrant | null }): Promise<string>;
  writeFile(externalId: string, path: string, content: string, opts?: { grant?: FolderGrant | null }): Promise<void>;
  /** Writes binary data (e.g. a user's attachment); creates parent folders. */
  upload(externalId: string, path: string, data: Buffer): Promise<void>;
  /** Make a port reachable from the user's browser; returns the URL. */
  exposePort(externalId: string, port: number): Promise<string>;
  /** A fresh, short-lived URL for the computer's virtual desktop, when the backend has one. */
  desktopUrl?(externalId: string): Promise<string>;
  /** Where relative paths resolve and commands start (shown to the agent). */
  home(externalId: string): string;
  /** Present when the computer has a desktop the agent can see and control. */
  desktop?: DesktopControl;
}
