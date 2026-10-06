import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { LandTaskRequest, TaskLanding, TaskLandOptions } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { quote } from "../computer/github-login.ts";
import type { FolderGrant } from "../computer/types.ts";
import { githubFullName } from "../data/brains.ts";
import { githubAccessFor, type AgentGitHub } from "../persona-github.ts";
import { grantFor } from "../projects/checkout.ts";
import { projects } from "../projects/projects.ts";
import { runLoop } from "../tasks/run-loop.ts";
import { ACTIVE, FINISHED, taskStore, type TaskRecord } from "../tasks/store.ts";
import { tasks } from "../tasks/tasks.ts";
import { cloneUrl, worktrees } from "../tasks/worktree.ts";
import { previews } from "../worktrees/preview.ts";
import { profileFor, taskChecks } from "./checks.ts";
import { folderGit, gitWords, inWorktree, onComputer, statusPath, worktreeState, type WorktreeState } from "./git.ts";
import { openDraftPr } from "./pr.ts";

/**
 * Landing a finished coding task (module 09, lane A): how it can land right now, merging it into
 * the user's folder on this Mac (by TOT's server, on their click, only into a clean checkout and
 * only when `git merge-tree` finds no conflicts), opening a draft PR (pr.ts), bringing the branch
 * up to date with its base, and discarding it. A merged or discarded task's worktree goes away;
 * a branch that was pushed is never deleted. Every change goes out as a `task` event.
 */

const TOT_BRANCH = /^tot\/[A-Za-z0-9._/-]+$/;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One landing action at a time per task: a double click mustn't merge twice. */
const busy = new Set<string>();

async function exclusive<T>(taskId: string, work: () => Promise<T>): Promise<T> {
  if (busy.has(taskId)) throw new HttpError(409, "This task is already being landed. Wait a moment.");
  busy.add(taskId);
  try {
    return await work();
  } finally {
    busy.delete(taskId);
  }
}

/** One merge at a time into a folder: two tasks landing together mustn't check, merge and clean up over each other. */
const merging = new Map<string, Promise<unknown>>();

function oneMergeAt<T>(folder: string, work: () => Promise<T>): Promise<T> {
  const next = (merging.get(folder) ?? Promise.resolve()).catch(() => {}).then(work);
  merging.set(folder, next);
  void next
    .finally(() => {
      if (merging.get(folder) === next) merging.delete(folder);
    })
    .catch(() => {});
  return next;
}

const CHANGED = "The task's branch changed since you looked. Review it again.";

/** "a.ts, b.ts, c.ts and 4 more". */
function someFiles(paths: string[], max = 3): string {
  const shown = paths.slice(0, max).join(", ");
  return paths.length > max ? `${shown} and ${paths.length - max} more` : shown;
}

/** Records how the task landed, and tells every tab (lane C then stops its preview and frees its ports). */
function recordLanding(taskId: string, landing: Omit<TaskLanding, "at">): TaskRecord {
  return taskStore.patch(taskId, { landing: { ...landing, at: Date.now() } }, true)!;
}

function requireRepo(task: TaskRecord) {
  const repo = task.task.repo;
  if (!repo) throw new HttpError(400, "This task has no code to land.");
  return repo;
}

/** Where a task's code can land: the user's folder on this Mac (a folder project), and/or a GitHub repo ("owner/name"). */
function destinations(task: TaskRecord): { folder: boolean; github: string | null } {
  const project = projects.get(task.projectId);
  if (project?.kind === "folder") return { folder: true, github: null };
  const source = project?.kind === "github" && project.source ? project.source : task.task.repo!.source;
  return { folder: false, github: githubFullName(cloneUrl(source) ?? "") };
}

/** Why nothing can land now, whatever the method: it's landed already, or still working. */
function blockedBy(task: TaskRecord): string | null {
  const { status, landing } = task.task;
  if (landing?.kind === "merged") return `Already merged into ${landing.target ?? "your folder"}.`;
  if (landing?.kind === "pr") return `Already opened as draft PR #${landing.pr?.number ?? "?"}.`;
  if (landing?.kind === "discarded") return "This task's work was discarded.";
  if (!FINISHED.has(status)) return "Wait for the task to finish, or stop it.";
  return null;
}

const CLEANED_UP = "This task's worktree was cleaned up. Reply to the task to pick it up again.";

/**
 * A task without a head has no worktree: cleanup removed it (lane C; its branch is kept, and a reply
 * sets the worktree up again), or it never got one.
 */
async function noWorktree(task: TaskRecord, grant: FolderGrant | null): Promise<string> {
  const { folder, branch } = task.task.repo!;
  const found = await onComputer(task, `git rev-parse --verify --quiet ${quote(`refs/heads/${branch}`)}`, folder, grant).catch(() => null);
  return found?.exitCode === 0 ? CLEANED_UP : "The task's branch was never set up.";
}

/**
 * Why the worktree can't be landed as it is (not on its branch, work left uncommitted, nothing new), or
 * null. New files count as uncommitted: a merge wouldn't carry them, and removing the worktree would lose them.
 */
function treeProblem(tree: WorktreeState | null, branch: string): string | null {
  if (!tree) return "The task's worktree is gone.";
  if (tree.checkedOut !== `refs/heads/${branch}`) {
    const what = tree.checkedOut ? `has ${tree.checkedOut.replace(/^refs\/heads\//, "")} checked out` : "isn't on a branch (detached HEAD)";
    return `The task's worktree ${what}, not ${branch}. Reply to the task to check its branch out again, or discard it.`;
  }
  const files = [...tree.uncommitted, ...tree.untracked.map((path) => `?? ${path}`)].map(statusPath);
  if (files.length) return `This task has files it didn't commit (${someFiles(files)}). Reply to the task to commit them, or discard it.`;
  if (!tree.ahead) return "The branch has no commits yet.";
  return null;
}

/** Of `paths` in the folder, those that exist there and git ignores: a merge would replace them without a word. */
async function ignoredThere(folder: string, paths: string[]): Promise<string[]> {
  const present = paths.filter((path) => {
    try {
      lstatSync(join(folder, path));
      return true;
    } catch {
      return false;
    }
  });
  const ignored: string[] = [];
  for (let i = 0; i < present.length; i += 500) {
    // Tracked files are never "ignored" here: only the user's own untracked, ignored ones are.
    const found = await folderGit(folder, ["-c", "core.quotePath=false", "check-ignore", "--", ...present.slice(i, i + 500)]);
    if (found.code > 1) throw new Error(gitWords(found.stderr) || `exit code ${found.code}`);
    ignored.push(...found.stdout.split("\n").filter(Boolean));
  }
  return ignored;
}

interface MergeCheck {
  target: string | null;
  reason: string | null;
  /** The branch's commit, as the folder has it now: what a merge merges. */
  sha: string | null;
}

/** Whether the branch can be merged into what's checked out in the user's folder, checked by TOT there itself. */
async function mergeCheck(folder: string, branch: string, base: string): Promise<MergeCheck> {
  const head = await folderGit(folder, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const target = head.code === 0 ? head.stdout.trim() : null;
  if (!target) return { target: null, reason: "Your folder isn't on a branch. Check out the branch to merge into.", sha: null };
  const refused = (reason: string): MergeCheck => ({ target, reason, sha: null });
  if (target.startsWith("tot/")) return refused(`Your folder has ${target} checked out. Check out the branch to merge into, like ${base}.`);
  if ((await folderGit(folder, ["rev-parse", "--quiet", "--verify", "MERGE_HEAD"])).code === 0) {
    return refused("Your folder is in the middle of a merge. Finish or abort it first.");
  }
  const status = await folderGit(folder, ["status", "--porcelain", "--untracked-files=no"]);
  if (status.code !== 0) return refused(`Couldn't read your folder's status: ${gitWords(status.stderr)}`);
  if (status.stdout.trim()) return refused(`Your folder has uncommitted changes. Commit or stash them, then merge.`);
  const sha = (await folderGit(folder, ["rev-parse", "--quiet", "--verify", `refs/heads/${branch}^{commit}`])).stdout.trim();
  if (!sha) return refused(`Your folder doesn't have ${branch}.`);
  const ahead = await folderGit(folder, ["rev-list", "--count", `${target}..${sha}`]);
  if (ahead.code !== 0) return refused(`Couldn't compare ${branch} with ${target}: ${gitWords(ahead.stderr)}`);
  if (Number(ahead.stdout.trim()) === 0) return refused(`${target} already has everything on ${branch}.`);
  const merged = await folderGit(folder, ["merge-tree", "--write-tree", "--no-messages", target, sha]);
  if (merged.code === 1) return refused(`Conflicts with ${target}. Update from ${base} first.`);
  if (merged.code !== 0) return refused(`Couldn't check for conflicts: ${gitWords(merged.stderr)}`);
  // Git replaces files it ignores without asking (a .env the branch added with -f): the user's own copy would be gone.
  const changed = await folderGit(folder, ["diff", "--name-only", "--no-renames", "-z", `${target}...${sha}`]);
  if (changed.code !== 0) return refused(`Couldn't list what ${branch} changes: ${gitWords(changed.stderr)}`);
  let ignored: string[];
  try {
    ignored = await ignoredThere(folder, changed.stdout.split("\0").filter(Boolean));
  } catch (err) {
    return refused(`Couldn't check your folder's ignored files: ${errorText(err)}`);
  }
  if (ignored.length) {
    const one = ignored.length === 1;
    return refused(`Merging would replace ${one ? "a file" : "files"} git ignores in your folder with the branch's: ${someFiles(ignored, 5)}. Move ${one ? "it" : "them"} aside, then merge.`);
  }
  return { target, reason: null, sha };
}

/** Whether the agent's GitHub account may push and open PRs. */
function writesProblem(access: AgentGitHub | null): string | null {
  if (!access) return "Connect GitHub in Settings → GitHub.";
  if (access.allowWrites) return null;
  return access.source === "persona" ? `Turn on GitHub writes for @${access.login} in the persona's settings.` : "Turn on GitHub writes in Settings → GitHub.";
}

interface Assessment {
  options: TaskLandOptions;
  grant: FolderGrant | null;
  access: AgentGitHub | null;
  github: string | null;
  /** The worktree as it was read (null when it wasn't), and the commit a merge would merge. */
  tree: WorktreeState | null;
  mergeSha: string | null;
}

/** Everything GET /land says, worked out now; POST /land works it out again right before it acts. */
async function assess(task: TaskRecord): Promise<Assessment> {
  const repo = requireRepo(task);
  const base = repo.baseBranch || "main";
  const where = destinations(task);
  const blocked = blockedBy(task);
  let grant: FolderGrant | null = null;
  let folderProblem: string | null = null;
  try {
    grant = grantFor(task);
  } catch (err) {
    folderProblem = errorText(err);
  }
  let tree: WorktreeState | null = null;
  let treeError: string | null = null;
  if (!blocked && !folderProblem && !repo.headSha) {
    treeError = await noWorktree(task, grant);
  } else if (!blocked && !folderProblem) {
    try {
      tree = await worktreeState(task, grant);
    } catch (err) {
      treeError = `Couldn't read the task's worktree: ${errorText(err)}`;
    }
  }
  const problem = blocked ?? folderProblem ?? treeError ?? treeProblem(tree, repo.branch);

  const merge: TaskLandOptions["merge"] = { available: false, target: null, reason: null };
  let mergeSha: string | null = null;
  if (!where.folder) merge.reason = "Merging is for folders on this Mac. Open a draft PR instead.";
  else if (problem) merge.reason = problem;
  else ({ target: merge.target, reason: merge.reason, sha: mergeSha } = await mergeCheck(grant!.folder, repo.branch, base));
  merge.available = where.folder && !merge.reason;

  const access = where.github ? githubAccessFor(task.agentId) : null;
  const pr: TaskLandOptions["pr"] = { available: false, base, reason: null };
  if (!where.github) pr.reason = "Draft PRs are for GitHub projects.";
  else pr.reason = blocked ?? (TOT_BRANCH.test(repo.branch) ? null : "Only TOT's own tot/… branches are pushed.") ?? writesProblem(access) ?? problem;
  pr.available = Boolean(where.github) && !pr.reason;

  return { options: { merge, pr, behind: tree?.behind ?? 0 }, grant, access, github: where.github, tree, mergeSha };
}

/**
 * Merges the branch's commit (the one just checked) into the folder's checked-out branch, as TOT itself.
 * Git gets all the time it needs: cut off halfway, it would leave the folder half merged. A merge that
 * fails is aborted when it's this one; anything else in the folder is left for the user, and said so.
 */
async function merge(task: TaskRecord, assessment: Assessment): Promise<TaskRecord> {
  const repo = task.task.repo!;
  const folder = assessment.grant!.folder;
  const target = assessment.options.merge.target!;
  const commit = assessment.mergeSha!;
  const merged = await folderGit(folder, ["merge", "--no-ff", "--no-edit", "--no-stat", "-m", `Merge ${repo.branch}: ${task.title}`, commit], { timeoutMs: 0 });
  if (merged.code !== 0) {
    const words = gitWords(merged.stderr || merged.stdout) || `exit code ${merged.code}`;
    const mergeHead = (await folderGit(folder, ["rev-parse", "--quiet", "--verify", "MERGE_HEAD"])).stdout.trim();
    if (mergeHead === commit) {
      await folderGit(folder, ["merge", "--abort"]);
      throw new HttpError(409, `Git couldn't merge ${repo.branch}: ${words}`);
    }
    if (mergeHead) throw new HttpError(409, `Git couldn't merge ${repo.branch}, and your folder is in the middle of another merge now, which TOT left alone: ${words}`);
    const left = await folderGit(folder, ["status", "--porcelain", "--untracked-files=no"]);
    if (left.code !== 0 || left.stdout.trim()) {
      throw new HttpError(409, `Git stopped partway through merging ${repo.branch}, and your folder has changes that aren't committed now. Look at git status there before you go on: ${words}`);
    }
    throw new HttpError(409, `Git couldn't merge ${repo.branch}: ${words}`);
  }
  const sha = (await folderGit(folder, ["rev-parse", "HEAD"])).stdout.trim() || null;
  // Its work is in the user's branch now: the worktree goes (only clean: nothing the merge didn't carry is lost),
  // and so does the branch (merged, so -d), unless it was pushed.
  try {
    await worktrees.remove(task.agentId, repo, { grant: assessment.grant });
    const pushed = await folderGit(folder, ["branch", "-r", "--contains", repo.branch]);
    if (pushed.code === 0 && !pushed.stdout.trim()) await folderGit(folder, ["branch", "-d", repo.branch]);
  } catch (err) {
    console.warn(`[tot] merged task ${task.id}, but couldn't remove its worktree:`, errorText(err));
  }
  return recordLanding(task.id, { kind: "merged", target, sha, pr: null });
}

/**
 * The branch as the user reviewed it (`headSha`, when the request says) is the one that lands: its
 * ref, its worktree's HEAD and the commit a merge would merge must all still be it.
 */
function requireReviewed(assessment: Assessment, headSha: string | undefined, method: "merge" | "pr"): void {
  if (!headSha) return;
  const { tree, mergeSha } = assessment;
  if (!tree || tree.head !== headSha || tree.branchHead !== headSha || (method === "merge" && mergeSha !== headSha)) throw new HttpError(409, CHANGED);
}

/** A turn for the task (as task_message sends one): it picks up again, in its worktree, with this as its instruction. */
async function askTask(taskId: string, text: string): Promise<TaskRecord> {
  await tasks.message(taskId, { text });
  return taskStore.get(taskId)!;
}

export const landing = {
  /** GET /api/tasks/:id/land: how the task can land right now. */
  async options(taskId: string): Promise<TaskLandOptions> {
    return (await assess(taskStore.require(taskId))).options;
  },

  /**
   * POST /api/tasks/:id/land: merge into the user's folder, or push and open a draft PR. With `headSha`
   * (the head the user reviewed), only that head lands. Its preview stops first. A merge runs alone for
   * the task (a reply waits for it) and alone in its folder.
   */
  land(taskId: string, request: Partial<LandTaskRequest>): Promise<TaskRecord> {
    const method = request.method;
    if (method !== "merge" && method !== "pr") throw new HttpError(400, 'Say how to land it: { method: "merge" } or { method: "pr" }.');
    if ((request.title !== undefined && typeof request.title !== "string") || (request.body !== undefined && typeof request.body !== "string")) {
      throw new HttpError(400, "A PR's title and body are text.");
    }
    if (request.headSha !== undefined && (typeof request.headSha !== "string" || !/^[0-9a-f]{7,64}$/.test(request.headSha))) {
      throw new HttpError(400, "headSha is the commit you reviewed, e.g. task.repo.headSha.");
    }
    const headSha = request.headSha;
    return exclusive(taskId, async () => {
      if (method === "merge") {
        return worktrees.forTask(taskId, () =>
          oneMergeAt(taskStore.require(taskId).task.repo?.folder ?? "", async () => {
            const task = taskStore.require(taskId);
            const assessment = await assess(task);
            const { available, reason } = assessment.options.merge;
            if (!available) throw new HttpError(409, reason ?? "This task can't be merged.");
            requireReviewed(assessment, headSha, method);
            await previews.stop(taskId);
            return merge(task, assessment);
          }),
        );
      }
      const task = taskStore.require(taskId);
      const assessment = await assess(task);
      const { available, reason, base } = assessment.options.pr;
      if (!available) throw new HttpError(409, reason ?? "This task can't be opened as a PR.");
      requireReviewed(assessment, headSha, method);
      await previews.stop(taskId);
      const landed = await openDraftPr(task, { repo: assessment.github!, base, access: assessment.access!, title: request.title, body: request.body });
      // The worktree stays: review fixes may follow on the same branch.
      return recordLanding(taskId, landed);
    });
  },

  /**
   * POST /api/tasks/:id/update-from-base: rebases the branch onto its base (fetched first on a
   * clone) in the worktree. When that conflicts, or work is left uncommitted, the rebase is undone
   * and the task gets a turn to do it itself, resolving the conflicts.
   */
  updateFromBase(taskId: string): Promise<TaskRecord> {
    return exclusive(taskId, async () => {
      const task = taskStore.require(taskId);
      const repo = requireRepo(task);
      const { status, landing: landed } = task.task;
      if (landed?.kind === "pr") throw new HttpError(409, "The branch is on GitHub already; update it there.");
      if (landed) throw new HttpError(409, blockedBy(task)!);
      if (ACTIVE.has(status)) throw new HttpError(409, "Wait for the task to finish (or pause it), then update it.");
      const grant = grantFor(task);
      if (!repo.headSha) throw new HttpError(409, await noWorktree(task, grant));
      if (!grant) {
        const fetched = await onComputer(task, "git remote get-url origin >/dev/null 2>&1 || exit 0; git fetch --quiet origin", repo.folder, null, 5 * 60_000);
        if (fetched.exitCode !== 0) console.warn(`[tot] git fetch for task ${taskId} failed, rebasing on what's there:`, gitWords(fetched.stderr));
      }
      const tree = await worktreeState(task, grant);
      if (!tree) throw new HttpError(409, "The task's worktree is gone.");
      if (!tree.behind) return task;
      if (tree.uncommitted.length) {
        return askTask(taskId, `Commit your work, then rebase onto ${tree.ref} and resolve any conflicts, keeping both sides' intent, then run the checks.`);
      }

      // A computer without a git identity of its own still records who rebased.
      const rebase = inWorktree(
        repo,
        `git config user.email >/dev/null 2>&1 || export GIT_COMMITTER_NAME=TOT GIT_COMMITTER_EMAIL=tot@localhost\ngit rebase --quiet ${quote(tree.ref)}`,
      );
      const rebased = await onComputer(task, rebase.script, rebase.cwd, grant);
      if (rebased.exitCode !== 0) {
        const undo = inWorktree(repo, `stopped=no; for d in rebase-merge rebase-apply; do test -d "$(git rev-parse --git-path "$d")" && stopped=yes; done\necho "$stopped"; git rebase --abort >/dev/null 2>&1; true`);
        const conflicted = (await onComputer(task, undo.script, undo.cwd, grant)).stdout.trim() === "yes";
        if (!conflicted) throw new HttpError(409, `Couldn't rebase onto ${tree.ref}: ${gitWords(rebased.stderr || rebased.stdout)}`);
        return askTask(taskId, `Rebase onto ${tree.ref} and resolve the conflicts, keeping both sides' intent, then run the checks.`);
      }
      const head = await worktrees.head(task.agentId, repo, grant);
      const updated = taskStore.patch(taskId, { repo: { ...repo, headSha: head ?? repo.headSha } }, true)!;
      // The checks were for the old head.
      return profileFor(updated) && updated.task.status === "done" ? taskChecks.start(taskId) : updated;
    });
  },

  /** POST /api/tasks/:id/discard: stops it, removes its worktree, deletes its branch unless it was pushed. */
  discard(taskId: string): Promise<TaskRecord> {
    return exclusive(taskId, async () => {
      const task = taskStore.require(taskId);
      const repo = requireRepo(task);
      const landed = task.task.landing;
      if (landed?.kind === "discarded") return task;
      if (landed?.kind === "merged") throw new HttpError(409, `It's merged into ${landed.target ?? "your folder"} already.`);
      if (landed?.kind === "pr") throw new HttpError(409, `It's draft PR #${landed.pr?.number ?? "?"} on GitHub: close it there instead.`);
      if (!FINISHED.has(task.task.status)) tasks.stop(taskId);
      await runLoop.settled(taskId);
      return worktrees.forTask(taskId, async () => {
        const now = taskStore.require(taskId);
        if (!FINISHED.has(now.task.status)) throw new HttpError(409, "The task picked up again meanwhile. Stop it, then discard it.");
        // Its preview goes before its worktree does.
        await previews.stop(taskId);
        // A task that ran has a branch (and, unless cleanup removed it, a worktree); one stopped while queued has neither.
        const current = now.task.repo ?? repo;
        if (current.headSha || now.task.startedAt) {
          try {
            // The user asked for its work to go: uncommitted files too.
            await worktrees.remove(now.agentId, current, { deleteBranch: true, force: true, grant: grantFor(now) });
          } catch (err) {
            throw new HttpError(409, `Couldn't remove the task's worktree: ${errorText(err)}`);
          }
        }
        return recordLanding(taskId, { kind: "discarded", target: null, sha: null, pr: null });
      });
    });
  },
};
