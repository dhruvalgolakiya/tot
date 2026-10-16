import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskRepo } from "../../shared/types.ts";
import { quote } from "../computer/github-login.ts";
import { computerManager } from "../computer/manager.ts";
import type { ExecResult, FolderGrant } from "../computer/types.ts";
import { hostGitEnv } from "../git-env.ts";
import type { TaskRecord } from "../tasks/store.ts";
import { homeRelative } from "../tasks/worktree.ts";
import { scrub } from "../trust/shell.ts";

/**
 * Git for landing a task (module 09, lane A), in two places. In the task's worktree, through its
 * agent's computer (with the task's folder grant for a folder project), as every other command a
 * task's branch sees. In the user's own folder on this Mac, run by TOT's server itself: only the
 * checks before a merge, the merge the user clicked, and deleting the branch it merged.
 */

const GIT_TIMEOUT_MS = 120_000;
const FOLDER_TIMEOUT_MS = 60_000;

/** Git's last words, without secrets: what goes into an error the user reads. */
export const gitWords = (text: string) => scrub(text).trim().split("\n").filter(Boolean).slice(-3).join(" · ").slice(0, 400);

const WORKTREE_GONE = "The task's worktree is gone.";

/**
 * A script that runs in the task's worktree, started from its repo folder: a worktree that's gone
 * exits 3 (as a working directory, the computer would make an empty folder in its place).
 */
export function inWorktree(repo: TaskRepo, script: string): { cwd: string; script: string } {
  const name = repo.worktree.split("/").pop()!;
  return { cwd: repo.folder, script: `cd ${quote(`.tot-worktrees/${name}`)} 2>/dev/null && test -e .git || { echo ${quote(WORKTREE_GONE)} >&2; exit 3; }\n${script}` };
}

/** Runs a script on the task's computer in `cwd` (its repo folder), with its folder grant. Output is scrubbed. */
export async function onComputer(task: TaskRecord, script: string, cwd: string, grant: FolderGrant | null, timeoutMs = GIT_TIMEOUT_MS): Promise<ExecResult> {
  const active = await computerManager.ensure(task.agentId);
  const result = await active.backend.exec(active.externalId, script, { cwd: homeRelative(cwd), timeoutMs, grant });
  computerManager.touch(task.agentId);
  return { ...result, stdout: scrub(result.stdout), stderr: scrub(result.stderr) };
}

/** The same, throwing with git's own words when it fails. */
export async function onComputerOrThrow(task: TaskRecord, script: string, cwd: string, grant: FolderGrant | null, timeoutMs?: number): Promise<string> {
  const result = await onComputer(task, script, cwd, grant, timeoutMs);
  if (result.exitCode !== 0) throw new Error(gitWords(result.stderr || result.stdout) || `exit code ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`);
  return result.stdout;
}

/** Splits output printed as "@@ name" sections. */
export function sectionsOf(stdout: string): Record<string, string> {
  const found: Record<string, string> = {};
  let name: string | null = null;
  for (const line of stdout.split("\n")) {
    const header = /^@@ (\S+)$/.exec(line);
    if (header) found[(name = header[1]!)] = "";
    else if (name) found[name] += `${line}\n`;
  }
  return found;
}

/**
 * Sets $ref to the ref a task's branch is compared with: origin/<base> when the repo has it, else
 * <base>. In a folder on this Mac the user's own <base> comes first (TOT never fetches there).
 */
export function baseRefScript(base: string, local: boolean): string {
  const [first, second] = local ? [base, `origin/${base}`] : [`origin/${base}`, base];
  return `ref=${quote(first)}; git rev-parse --verify --quiet "$ref^{commit}" >/dev/null || ref=${quote(second)}`;
}

/** Where the task's worktree stands against its base. */
export interface WorktreeState {
  /** What it's compared with: "main" or "origin/main". */
  ref: string;
  head: string | null;
  /** The task's branch as the repo has it now (refs/heads/<branch>), and what the worktree has checked out ("refs/heads/…", or null when detached). */
  branchHead: string | null;
  checkedOut: string | null;
  /** Tracked files changed but not committed (`git status --porcelain` lines). */
  uncommitted: string[];
  /** Files it made and never added (not ignored ones): a merge wouldn't carry them, and removing the worktree would lose them. */
  untracked: string[];
  /** Commits on the base the branch doesn't have, and commits on the branch the base doesn't have. */
  behind: number;
  ahead: number;
}

/** The file a `git status --porcelain` line is about ("R  old -> new" → "new"). */
export const statusPath = (line: string) => line.slice(3).replace(/^.* -> /, "");

/** One round trip to the computer; null when the worktree isn't there. */
export async function worktreeState(task: TaskRecord, grant: FolderGrant | null): Promise<WorktreeState | null> {
  const repo = task.task.repo!;
  const lines = [
    baseRefScript(repo.baseBranch, Boolean(grant)),
    `echo '@@ ref'; echo "$ref"`,
    "echo '@@ head'; git rev-parse HEAD 2>/dev/null",
    `echo '@@ branch'; git rev-parse --verify --quiet ${quote(`refs/heads/${repo.branch}`)}`,
    "echo '@@ checkout'; git symbolic-ref --quiet HEAD",
    "echo '@@ uncommitted'; git status --porcelain --untracked-files=no | head -n 50",
    "echo '@@ untracked'; git ls-files --others --exclude-standard | head -n 50",
    `echo '@@ behind'; git rev-list --count "HEAD..$ref" 2>/dev/null || echo 0`,
    `echo '@@ ahead'; git rev-list --count "$ref..HEAD" 2>/dev/null || echo 0`,
  ];
  const { cwd, script } = inWorktree(repo, lines.join("\n"));
  const result = await onComputer(task, script, cwd, grant);
  if (result.exitCode === 3) return null;
  if (result.exitCode !== 0) throw new Error(gitWords(result.stderr || result.stdout) || `exit code ${result.exitCode}`);
  const found = sectionsOf(result.stdout);
  return {
    ref: found.ref?.trim() || repo.baseBranch,
    head: found.head?.trim() || null,
    branchHead: found.branch?.trim() || null,
    checkedOut: found.checkout?.trim() || null,
    uncommitted: (found.uncommitted ?? "").split("\n").filter(Boolean),
    untracked: (found.untracked ?? "").split("\n").filter(Boolean),
    behind: Number(found.behind?.trim()) || 0,
    ahead: Number(found.ahead?.trim()) || 0,
  };
}

const execFileAsync = promisify(execFile);

/**
 * git in the user's folder on this Mac, as TOT's server: never through an agent's sandbox, and without
 * TOT's own GIT_* variables. `timeoutMs: 0` waits as long as git takes (a merge mustn't be cut off halfway).
 */
export async function folderGit(folder: string, args: string[], { timeoutMs = FOLDER_TIMEOUT_MS } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: folder,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: hostGitEnv({ GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no" }),
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failed = err as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    return { code: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: failed.stderr || failed.message || "" };
  }
}
