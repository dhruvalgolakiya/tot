import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Project, SetupDetection, TaskRepo, TaskSetup } from "../../shared/types.ts";
import { computerManager } from "../computer/manager.ts";
import type { ExecResult, FolderGrant } from "../computer/types.ts";
import { paths } from "../config.ts";
import { hostGitEnv } from "../git-env.ts";
import { projects } from "../projects/projects.ts";
import { projectRepos } from "../projects/repos.ts";
import { taskStore, type TaskRecord } from "../tasks/store.ts";
import { homeRelative } from "../tasks/worktree.ts";
import { scrub } from "../trust/shell.ts";
import { taskPorts } from "./ports.ts";

/**
 * A new task worktree made ready to work in (module 09), right after `git worktree add` (prepareTask):
 * it gets its port block; a folder project's listed files are copied in by TOT itself (their contents
 * are never shown or logged); then the project's setup command, or the one its lockfile implies, runs on
 * the agent's computer in the worktree, with the task's grant and ports, for up to 10 minutes. The
 * outcome is TaskInfo.setup. A failure never stops the task: its agent is told in its first turn.
 */

const SETUP_TIMEOUT_MS = 10 * 60_000;
const ERROR_LINES = 15;
const ERROR_CHARS = 2000;

/** Lockfiles in the order they're looked for, and the install each implies. */
export const LOCKFILES: readonly (readonly [string, string])[] = [
  ["package-lock.json", "npm ci"],
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
  ["yarn.lock", "yarn install --immutable"],
  ["bun.lock", "bun install --frozen-lockfile"],
  ["bun.lockb", "bun install --frozen-lockfile"],
  ["uv.lock", "uv sync"],
];

const NOTHING: SetupDetection = { command: null, lockfile: null };

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The setup a folder on this Mac implies. */
export function detectIn(folder: string): SetupDetection {
  for (const [lockfile, command] of LOCKFILES) if (existsSync(join(folder, lockfile))) return { command, lockfile };
  return NOTHING;
}

/**
 * What a project's new worktrees would run with no setupCommand (the Worktree setup dialog's placeholder):
 * a folder project's own lockfile, or a GitHub project's as cloned on a local computer. Null when there's
 * nothing to look at from here (a Boat clone, or none yet).
 */
export function detectForProject(project: Project): SetupDetection {
  if (project.kind === "folder") return project.source && existsSync(project.source) ? detectIn(project.source) : NOTHING;
  if (project.kind !== "github") return NOTHING;
  let homes: string[] = [];
  try {
    homes = readdirSync(paths.computers);
  } catch {
    return NOTHING;
  }
  // Module 11: the primary repo's clone (~/projects/<slug> for a project from before 11).
  const dir = projectRepos.primary(project.id)?.checkout?.replace(/^~\/projects\//, "") ?? project.slug;
  for (const home of homes) {
    const clone = join(paths.computers, home, "projects", dir);
    if (existsSync(join(clone, ".git"))) return detectIn(clone);
  }
  return NOTHING;
}

/** Whether `path` (or, when it doesn't exist yet, the nearest folder above it that does) really is inside `root`. */
function staysIn(path: string, root: string): boolean {
  let probe = path;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync.native(probe);
  return real === root || real.startsWith(`${root}/`);
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Writes a file that mustn't exist yet, never through a symlink (one swapped in meanwhile makes it fail). */
function writeNew(path: string, data: Buffer, mode: number): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** Keeps copied files out of commits: any git doesn't already ignore goes in the repo's info/exclude. */
function ignoreCopied(folder: string, worktree: string, copied: string[]): void {
  const unignored = copied.filter((file) => {
    try {
      execFileSync("git", ["-c", "core.fsmonitor=false", "check-ignore", "-q", "--no-index", "--", file], { cwd: worktree, stdio: "ignore", env: hostGitEnv() });
      return false;
    } catch {
      return true;
    }
  });
  if (!unignored.length) return;
  const exclude = join(folder, ".git", "info", "exclude");
  const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const lines = text.split("\n");
  const add = unignored.map((file) => `/${file}`).filter((line) => !lines.includes(line));
  if (!add.length) return;
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, `${text && !text.endsWith("\n") ? "\n" : ""}# Copied into TOT's task worktrees; keeps them out of commits.\n${add.join("\n")}\n`);
}

/**
 * Copies a folder project's listed files from the folder into a task's new worktree. Only regular files
 * really inside the folder are read, and only into the worktree itself (a symlink in either can't lead
 * anywhere else). Returns the paths that weren't copied; contents never leave the copy.
 */
export function copyProjectFiles(project: Project, worktree: string): { copied: string[]; skipped: string[] } {
  const copied: string[] = [];
  const skipped: string[] = [];
  const files = project.kind === "folder" && project.source ? (project.copyFiles ?? []) : [];
  if (!files.length) return { copied, skipped };
  const folder = realpathSync.native(project.source!);
  const target = realpathSync.native(worktree);
  for (const file of files) {
    try {
      const from = realpathSync.native(join(folder, file));
      if (!from.startsWith(`${folder}/`) || from.startsWith(`${target}/`) || !statSync(from).isFile()) {
        skipped.push(file);
        continue;
      }
      const to = join(target, file);
      // lstat, not exists: a symlink the branch put there (pointing nowhere yet, too) is never written through.
      const there = lstatOrNull(to);
      if (!staysIn(dirname(to), target) || (there && !there.isFile())) {
        skipped.push(file);
        continue;
      }
      mkdirSync(dirname(to), { recursive: true });
      if (there) unlinkSync(to);
      writeNew(to, readFileSync(from), statSync(from).mode & 0o777);
      copied.push(file);
    } catch {
      skipped.push(file);
    }
  }
  if (copied.length) {
    try {
      ignoreCopied(folder, target, copied);
    } catch (err) {
      console.warn("[tot] couldn't keep copied files out of git:", errorText(err));
    }
  }
  return { copied, skipped };
}

/** The last lines of a command's output (stdout, then stderr), without secrets (it goes into the agent's prompt and the UI). */
function lastLines(...outputs: string[]): string {
  const text = outputs.map((output) => output.trimEnd()).filter(Boolean).join("\n");
  const lines = scrub(text).split("\n");
  return lines.slice(-ERROR_LINES).join("\n").slice(-ERROR_CHARS).replace(/^\s*\n/, "");
}

/**
 * The setup command a new worktree of the project's runs: the project's setupCommand ("" for none), or with
 * none set the install its lockfile implies (looked for in the worktree itself). Null when there's nothing to run.
 */
async function setupCommand(configured: string | null | undefined, exec: (command: string, timeoutMs: number) => Promise<ExecResult>): Promise<string | null> {
  if (typeof configured === "string") return configured || null;
  const names = LOCKFILES.map(([lockfile]) => lockfile).join(" ");
  const found = await exec(`for f in ${names}; do if [ -e "$f" ]; then echo "$f"; break; fi; done`, 30_000);
  const lockfile = found.stdout.trim();
  return LOCKFILES.find(([name]) => name === lockfile)?.[1] ?? null;
}

/** Runs a setup command (for up to 10 minutes) and says how it went: the error is its last lines, without secrets. */
async function runCommand(command: string, exec: (command: string, timeoutMs: number) => Promise<ExecResult>, note: string): Promise<TaskSetup> {
  const result = await exec(command, SETUP_TIMEOUT_MS).catch((err) => ({ exitCode: -1, stdout: "", stderr: errorText(err), timedOut: false }));
  const failed = result.exitCode !== 0;
  const output = failed ? lastLines(result.stdout, result.stderr) : "";
  const error = failed ? `${output || `exit code ${result.exitCode}`}${result.timedOut ? "\n(stopped after 10 minutes)" : ""}` : null;
  return { state: failed ? "failed" : "done", command, at: Date.now(), error: [note, error].filter(Boolean).join("\n") || null };
}

/** A folder project's listed files copied into a new worktree; a note on any that weren't. */
function copyInto(project: Project | null, repo: TaskRepo): string {
  if (project?.kind !== "folder" || !project.copyFiles?.length || repo.folder !== project.source) return "";
  try {
    const { skipped } = copyProjectFiles(project, repo.worktree);
    return skipped.length ? `Not copied from the project's folder (missing, not a file, or outside it): ${skipped.join(", ")}.` : "";
  } catch (err) {
    return `Couldn't copy the project's files: ${errorText(err)}`;
  }
}

/** Runs the worktree's setup command on the agent's computer and records how it went in TaskInfo.setup. */
async function runSetup(task: TaskRecord, repo: TaskRepo, grant: FolderGrant | null, note: string): Promise<TaskSetup> {
  // Module 11: the project's setup command is its primary repo's; another repo's comes from its own lockfile.
  const configured = projectRepos.forTask(task)?.primary === false ? null : projects.get(task.projectId)?.setupCommand;
  const active = await computerManager.ensure(task.agentId);
  const ports = taskStore.get(task.id)?.task.ports;
  const exec = (command: string, timeoutMs: number) =>
    active.backend.exec(active.externalId, command, { cwd: homeRelative(repo.worktree), timeoutMs, grant, env: taskPorts.env(ports) });

  const command = await setupCommand(configured, exec);
  if (!command) {
    const skipped: TaskSetup = { state: "skipped", command: null, at: Date.now(), error: note || null };
    taskStore.patch(task.id, { setup: skipped });
    return skipped;
  }
  // The card says what's taking the time, then shows what it showed before.
  const before = taskStore.get(task.id)?.task.progress ?? null;
  const progress = `Setting up: ${command.length > 60 ? `${command.slice(0, 59)}…` : command}`;
  taskStore.patch(task.id, { setup: { state: "running", command, at: Date.now(), error: null }, progress });
  const setup = await runCommand(command, exec, note);
  computerManager.touch(task.agentId);
  if (taskStore.get(task.id)?.task.progress === progress) taskStore.patch(task.id, { progress: before });
  taskStore.patch(task.id, { setup });
  return setup;
}

export const worktreeSetup = {
  /**
   * After prepareTask's `worktrees.ensure`: the task's port block, and for a worktree made just now
   * (`fresh`), the project's files and its setup. Never throws: the task goes on either way.
   */
  async prepared(task: TaskRecord, repo: TaskRepo, grant: FolderGrant | null, { fresh }: { fresh: boolean }): Promise<void> {
    try {
      await taskPorts.ensure(task.id);
    } catch (err) {
      console.warn(`[tot] no ports for task ${task.id}:`, errorText(err));
    }
    if (!fresh) return;
    const note = copyInto(projects.get(task.projectId), repo);
    try {
      await runSetup(task, repo, grant, note);
    } catch (err) {
      taskStore.patch(task.id, { setup: { state: "failed", command: null, at: Date.now(), error: [note, errorText(err)].filter(Boolean).join("\n") } });
    }
  },

  /**
   * A worktree chat's new worktree (chats/workspace.ts), set up as a task's is: the project's files copied in,
   * then its setup command (its primary repo's, which is the one a chat works in). It gets no port block:
   * those belong to tasks. Never throws; says how it went.
   */
  async forChat(agentId: string, project: Project | null, repo: TaskRepo, grant: FolderGrant | null): Promise<TaskSetup> {
    const note = copyInto(project, repo);
    try {
      const active = await computerManager.ensure(agentId);
      const exec = (command: string, timeoutMs: number) => active.backend.exec(active.externalId, command, { cwd: homeRelative(repo.worktree), timeoutMs, grant });
      const command = await setupCommand(project?.setupCommand, exec);
      if (!command) return { state: "skipped", command: null, at: Date.now(), error: note || null };
      const setup = await runCommand(command, exec, note);
      computerManager.touch(agentId);
      return setup;
    } catch (err) {
      return { state: "failed", command: null, at: Date.now(), error: [note, errorText(err)].filter(Boolean).join("\n") };
    }
  },
};
