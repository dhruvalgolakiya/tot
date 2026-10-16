import type { GateName, GateResult, RepoProfileInput, TaskChecks } from "@tot/shared/types";
import { brains } from "../data/brains.ts";
import { conversations } from "../data/conversations.ts";
import { grantFor } from "../projects/checkout.ts";
import { projects } from "../projects/projects.ts";
import { projectRepos } from "../projects/repos.ts";
import { isTask, taskStore, type TaskRecord } from "../tasks/store.ts";
import { cloneUrl } from "../tasks/worktree.ts";
import { blocks, COMMAND_GATES, runGates } from "../trust/gates.ts";
import { detectProfileIn, repoProfiles } from "../trust/profile.ts";
import { baseRefScript, onComputerOrThrow } from "./git.ts";

/**
 * A finished coding task's checks (module 09, lane A): module 03's gates, run on its branch in its
 * worktree when it's done, and again on demand (Run checks). Only for a repo with a profile (saved
 * in its brain's settings, or drafted by Learn a repo); without one the state is "none". The result
 * is kept on the task as one line per gate, with the head it was run on.
 */

const LINE_MAX = 200;

/** Task id → its checks while they run. */
const running = new Map<string, Promise<void>>();

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The repo profile for a task's repo: its project's brain's, else the repo brain learned from the same source. */
/**
 * The brain a coding task's checks belong to, with its repo's saved profile. `profile` is null when none
 * was saved yet (no Learn a repo): run() then reads one from the worktree, so a repo with `npm test`
 * gets checks out of the box. Null when the repo has no brain at all.
 */
export function profileFor(task: TaskRecord): { brainId: string; profile: RepoProfileInput | null } | null {
  const repo = task.task.repo;
  if (!repo) return null;
  const project = projects.get(task.projectId);
  const brainId = project && project.kind !== "none" ? project.brainId : brains.forSource(cloneUrl(repo.source) ?? repo.source)?.id;
  if (!brainId) return null;
  // Module 11: the project's saved profile is its primary repo's; another repo's checks are read from its worktree.
  if (projectRepos.forTask(task)?.primary === false) return { brainId, profile: null };
  try {
    return { brainId, profile: repoProfiles.get(brainId) ?? null };
  } catch {
    // Not a repo's brain: no profile.
    return null;
  }
}

/** "typecheck passed", "test failed: 2 new failures", "size needs your OK: …". */
export function checkLine(result: GateResult): string {
  const name = result.gate === "e2e" ? "end-to-end" : result.gate;
  let line: string;
  if (result.status === "pass") line = `${name} passed`;
  else if (result.status === "skipped") line = `${name} skipped`;
  else if (result.status === "needs-approval") line = `${name} needs your OK${result.note ? `: ${result.note}` : ""}`;
  else if (!blocks(result)) line = `${name} failed, as it does on the base branch`;
  else if (result.newFailures?.length) line = `${name} failed: ${result.newFailures.length} new failure${result.newFailures.length === 1 ? "" : "s"}`;
  else if (result.baseline === "pass") line = `${name} failed (it passes on the base branch)`;
  else line = result.note?.startsWith("Timed out") ? `${name} timed out` : `${name} failed`;
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line;
}

function save(taskId: string, checks: TaskChecks): void {
  taskStore.patch(taskId, { checks });
}

async function run(taskId: string, found: { brainId: string; profile: RepoProfileInput | null }): Promise<void> {
  const task = taskStore.get(taskId);
  const repo = task?.task.repo;
  if (!task || !repo) return;
  try {
    const grant = grantFor(task);
    // The base it's compared with, as the worktree knows it: origin/<base> on a clone, the user's own <base> in a folder.
    const baseRef = (await onComputerOrThrow(task, `${baseRefScript(repo.baseBranch, Boolean(grant))}; echo "$ref"`, repo.folder, grant)).trim();
    const profile = found.profile ?? (await detectProfileIn(task.agentId, repo.worktree, grant));
    const gates: GateName[] = [...COMMAND_GATES.filter((gate) => profile.commands[gate]), "scope", "deps", "size"];
    const report = await runGates({ agentId: task.agentId, cwd: repo.worktree, profile, brainId: found.brainId, gates, baseRef, grant });
    save(taskId, { state: report.ok ? "passing" : "failing", lines: report.results.map(checkLine), headSha: report.headSha, at: Date.now() });
  } catch (err) {
    save(taskId, { state: "failing", lines: [`Couldn't run the checks: ${errorText(err)}`.slice(0, LINE_MAX)], headSha: repo.headSha, at: Date.now() });
  }
}

export const taskChecks = {
  /**
   * Starts the checks on a coding task's branch, or joins the run already going; returns the task
   * with its checks "running" (or "none": the repo has no profile). The result arrives as a task event.
   */
  start(taskId: string): TaskRecord {
    const task = taskStore.require(taskId);
    const repo = task.task.repo;
    if (!repo?.headSha || running.has(taskId)) return task;
    const found = profileFor(task);
    if (!found) {
      save(taskId, { state: "none", lines: [], headSha: repo.headSha, at: Date.now() });
      return taskStore.get(taskId)!;
    }
    save(taskId, { state: "running", lines: [], headSha: repo.headSha, at: Date.now() });
    const done = run(taskId, found).finally(() => running.delete(taskId));
    running.set(taskId, done);
    return taskStore.get(taskId)!;
  },

  /** A task that just finished "done": its checks start on the next tick, once its status change is out. */
  afterDone(taskId: string): void {
    setImmediate(() => {
      if (taskStore.get(taskId)?.task.status !== "done") return;
      try {
        taskChecks.start(taskId);
      } catch (err) {
        console.warn(`[tot] couldn't start the checks of task ${taskId}:`, errorText(err));
      }
    });
  },

  isRunning(taskId: string): boolean {
    return running.has(taskId);
  },

  /** Resolves when the task's checks (if running) have finished. */
  async settled(taskId: string): Promise<void> {
    await running.get(taskId);
  },

  /** On startup: checks a restart cut off run again. */
  recover(): void {
    for (const task of conversations.tasks()) {
      if (isTask(task) && task.task.checks?.state === "running" && !running.has(task.id)) {
        try {
          taskChecks.start(task.id);
        } catch (err) {
          console.warn(`[tot] couldn't run the checks of task ${task.id} again:`, errorText(err));
        }
      }
    }
  },
};
