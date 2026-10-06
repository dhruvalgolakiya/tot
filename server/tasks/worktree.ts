import { randomBytes } from "node:crypto";
import type { TaskChangedFile, TaskChanges, TaskDiffStats, TaskRepo } from "../../shared/types.ts";
import { quote } from "../computer/github-login.ts";
import { computerManager } from "../computer/manager.ts";
import type { FolderGrant } from "../computer/types.ts";
import { cloneFolder, githubFullName } from "../data/brains.ts";
import { redactGitHubTokens } from "../github.ts";

/**
 * A coding task's own branch and git worktree, on its agent's computer: the repo lives in its
 * project's folder (~/projects/<slug>, see projects/checkout.ts), or outside a project in
 * ~/repos/<name> as Learn a repo keeps it, and each task checks its branch out in
 * <repo>/.tot-worktrees/<branch slug>, so tasks on the same repo run side by side without
 * touching each other or the base branch. In a folder on this Mac (a folder project), the same
 * happens in the user's own repo through the sandbox's folder grant, so the branch shows up in
 * their `git branch`. Nothing here ever pushes.
 */

const WORKTREES = ".tot-worktrees";
const GIT_TIMEOUT_MS = 120_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
const PATCH_LIMIT = 300_000;
const MAX_UNTRACKED = 50;
/** Paths kept in a task's diff stats (module 09): enough to spot overlaps between tasks. */
const MAX_STAT_PATHS = 200;

/** "fix the flaky checkout test" → "fix-the-flaky-checkout-test" (short, safe in a branch name). */
export function slugify(text: string, max = 32): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return slug || "task";
}

/** Whether a repo source is a folder on the agent's computer (rather than something to clone). */
export function isFolderSource(source: string): boolean {
  return /^(~(\/|$)|\/|\.\.?\/|repos\/)/.test(source.trim());
}

/** "acme/web" → its GitHub URL; URLs stay as they are; folders have none. */
export function cloneUrl(source: string): string | null {
  const text = source.trim();
  if (isFolderSource(text)) return null;
  if (/^[\w.-]+\/[\w.-]+$/.test(text)) return `https://github.com/${text.replace(/\.git$/i, "")}.git`;
  return text;
}

/** Where a source lives on the computer: the folder itself, or ~/repos/<name> once cloned. */
export function repoFolder(source: string): string {
  const text = source.trim().replace(/\/+$/, "");
  if (isFolderSource(text)) return text.startsWith("repos/") ? `~/${text}` : text;
  return `~/repos/${cloneFolder(githubFullName(text) ?? text)}`;
}

/** The same plan with its repo in another folder (its project's), and the worktree under it. */
export function inFolder(repo: TaskRepo, folder: string): TaskRepo {
  return { ...repo, folder, worktree: `${folder}/${WORKTREES}/${repo.worktree.split("/").pop()}` };
}

/**
 * The repo part of a new task: its branch and worktree are named now, created when the task first runs.
 * A task about a ticket (module 06) has its key first: tot/eng-123-fix-checkout-3f2a.
 */
export function planRepo(source: string, title: string, baseBranch?: string, ticketKey?: string | null): TaskRepo {
  const folder = repoFolder(source);
  const name = slugify(title, 28);
  // "eng-123", "acme-web-42"; a title that already starts with it doesn't get it twice.
  const key = ticketKey ? slugify(ticketKey, 20) : "";
  const prefix = key && name !== key && !name.startsWith(`${key}-`) ? `${key}-` : "";
  const branch = `tot/${prefix}${name}-${randomBytes(2).toString("hex")}`;
  return {
    source: source.trim(),
    folder,
    baseBranch: baseBranch?.trim() ?? "",
    branch,
    worktree: `${folder}/${WORKTREES}/${branch.replace(/\//g, "-")}`,
    headSha: null,
  };
}

/** Commands take paths relative to the computer's home folder: "~/repos/x" → "repos/x". */
export function homeRelative(path: string): string {
  if (path === "~") return ".";
  return path.startsWith("~/") ? path.slice(2) : path;
}

const oneLine = (text: string) => redactGitHubTokens(text).trim().split("\n").filter(Boolean).slice(-3).join(" · ").slice(0, 400);

interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  /** The task's folder grant, when its repo is a folder on this Mac (see checkout.grantFor). */
  grant?: FolderGrant | null;
}

/** Runs a shell command on the agent's computer; throws with git's own words when it fails. */
async function run(agentId: string, command: string, { cwd, timeoutMs = GIT_TIMEOUT_MS, grant }: RunOptions = {}): Promise<string> {
  const active = await computerManager.ensure(agentId);
  const result = await active.backend.exec(active.externalId, command, { cwd: cwd ? homeRelative(cwd) : undefined, timeoutMs, grant });
  computerManager.touch(agentId);
  if (result.exitCode !== 0) {
    throw new Error(oneLine(result.stderr || result.stdout) || `exit code ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`);
  }
  return result.stdout;
}

async function succeeds(agentId: string, command: string, options: RunOptions = {}): Promise<boolean> {
  try {
    await run(agentId, command, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * The ref a task's branch starts from: origin/<base> when the repo has a remote copy of it. In a
 * folder on this Mac, the user's own <base> comes first: TOT doesn't fetch there, and that branch
 * is what they have.
 */
async function baseRef(agentId: string, repo: TaskRepo, grant?: FolderGrant | null): Promise<string> {
  const remote = `origin/${repo.baseBranch}`;
  const [first, second] = grant ? [repo.baseBranch, remote] : [remote, repo.baseBranch];
  return (await succeeds(agentId, `git rev-parse --verify --quiet ${quote(`${first}^{commit}`)}`, { cwd: repo.folder, grant })) ? first : second;
}

/**
 * One setup at a time per repo on a computer ("<agentId>:<folder>"): two tasks starting together mustn't
 * both clone it, or race on `git worktree add`. And one change at a time to a task's worktree ("task:<id>").
 */
const setups = new Map<string, Promise<unknown>>();

function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = setups.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  setups.set(key, next);
  void next.finally(() => {
    if (setups.get(key) === next) setups.delete(key);
  }).catch(() => {});
  return next;
}

async function defaultBranch(agentId: string, folder: string, grant?: FolderGrant | null): Promise<string> {
  const remoteHead = await run(agentId, "git symbolic-ref --quiet --short refs/remotes/origin/HEAD || true", { cwd: folder, grant });
  const name = remoteHead.trim().replace(/^origin\//, "");
  if (name) return name;
  return (await run(agentId, "git rev-parse --abbrev-ref HEAD", { cwd: folder, grant })).trim() || "main";
}

/**
 * Clones (if needed), fetches, and adds the task's worktree; see `worktrees.ensure`. A folder on
 * this Mac (with a grant) is never cloned or fetched, and checkout.ensure has already made its
 * .tot-worktrees and kept it out of the user's `git status`: the sandbox lets the task write its
 * own worktree and branch, nothing around them.
 */
async function setUp(agentId: string, repo: TaskRepo, grant?: FolderGrant | null): Promise<{ repo: TaskRepo; created: boolean }> {
  const { folder } = repo;
  const here = { cwd: folder, grant };
  if (!(await succeeds(agentId, "test -e .git", here))) {
    const url = grant ? null : cloneUrl(repo.source);
    if (!url) throw new Error(`There's no git repo at ${folder} on the computer.`);
    await run(agentId, `mkdir -p ${quote(homeRelative(folder).replace(/\/[^/]+$/, "") || ".")} && git clone --quiet ${quote(url)} ${quote(homeRelative(folder))}`, { timeoutMs: CLONE_TIMEOUT_MS });
  }
  // A repo without a remote (a local folder) simply has nothing to fetch.
  if (!grant && (await succeeds(agentId, "git remote get-url origin", here))) {
    await run(agentId, "git fetch --quiet origin", { cwd: folder, timeoutMs: CLONE_TIMEOUT_MS }).catch((err) => {
      console.warn(`[tot] git fetch in ${folder} failed, using what's there:`, err instanceof Error ? err.message : err);
    });
  }
  const baseBranch = repo.baseBranch || (await defaultBranch(agentId, folder, grant));
  const planned: TaskRepo = { ...repo, baseBranch };
  const relative = `${WORKTREES}/${repo.worktree.split("/").pop()}`;
  const created = !(await succeeds(agentId, `test -e ${quote(`${relative}/.git`)}`, here));
  if (created) {
    // Keep worktrees out of the main checkout's `git status`.
    if (!grant) {
      await run(
        agentId,
        `mkdir -p ${WORKTREES} && exclude="$(git rev-parse --git-path info/exclude)" && mkdir -p "$(dirname "$exclude")" && (grep -qxF '${WORKTREES}/' "$exclude" 2>/dev/null || echo '${WORKTREES}/' >> "$exclude")`,
        here,
      );
    }
    const branchExists = await succeeds(agentId, `git rev-parse --verify --quiet ${quote(`refs/heads/${repo.branch}`)}`, here);
    await run(
      agentId,
      branchExists
        ? `git worktree add --quiet ${quote(relative)} ${quote(repo.branch)}`
        : `git worktree add --quiet -b ${quote(repo.branch)} ${quote(relative)} ${quote(await baseRef(agentId, planned, grant))}`,
      here,
    );
  }
  return { repo: { ...planned, headSha: await worktrees.head(agentId, planned, grant) }, created };
}

export const worktrees = {
  /**
   * Makes sure the task's worktree exists: clones the repo if it isn't on the computer yet
   * (with the agent's GitHub login, set up by the computer manager), fetches, and adds the
   * branch's worktree from the base. Returns the repo with its base branch and head filled in,
   * and whether the worktree was made just now (decided under the repo's setup lock, so two
   * callers never both see it as new).
   */
  ensure(agentId: string, repo: TaskRepo, grant?: FolderGrant | null): Promise<{ repo: TaskRepo; created: boolean }> {
    return oneAtATime(`${agentId}:${repo.folder}`, () => setUp(agentId, repo, grant));
  },

  /**
   * Runs `work` alone for the task (module 09): setting up its worktree (prepareTask), picking it up
   * again (tasks.message), merging or discarding it and cleanup wait for each other, so none acts on a
   * worktree another is making or removing. Not re-entrant: `work` mustn't wait for the same task's turn.
   */
  forTask<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    return oneAtATime(`task:${taskId}`, work);
  },

  /** The branch's newest commit; null when the worktree isn't there. */
  async head(agentId: string, repo: TaskRepo, grant?: FolderGrant | null): Promise<string | null> {
    try {
      return (await run(agentId, "git rev-parse HEAD", { cwd: repo.worktree, grant })).trim() || null;
    } catch {
      return null;
    }
  },

  /** Everything the task changed: committed or not, tracked or new, against where its branch left the base. */
  async changes(agentId: string, repo: TaskRepo, grant?: FolderGrant | null): Promise<TaskChanges> {
    const ref = await baseRef(agentId, repo, grant);
    const script = [
      "set -e",
      `base=$(git merge-base ${quote(ref)} HEAD)`,
      `echo '@@NUMSTAT'; git diff --numstat -M "$base"`,
      `echo '@@STATUS'; git diff --name-status -M "$base"`,
      `echo '@@UNTRACKED'; git ls-files --others --exclude-standard | head -n ${MAX_UNTRACKED} | while IFS= read -r f; do printf '%s\\t%s\\n' "$(wc -l < "$f" | tr -d ' ')" "$f"; done`,
      `echo '@@PATCH'; { git diff -M "$base"; git ls-files --others --exclude-standard | head -n ${MAX_UNTRACKED} | while IFS= read -r f; do git diff --no-index -- /dev/null "$f" || true; done; } | head -c ${PATCH_LIMIT + 1}`,
    ].join("\n");
    const out = redactGitHubTokens(await run(agentId, script, { cwd: repo.worktree, grant }));
    const section = (name: string) => {
      const start = out.indexOf(`@@${name}\n`);
      if (start === -1) return "";
      const from = start + name.length + 3;
      const next = out.indexOf("\n@@", from - 1);
      return name === "PATCH" ? out.slice(from) : out.slice(from, next === -1 ? undefined : next + 1);
    };
    const statuses = new Map<string, TaskChangedFile["status"]>();
    for (const line of section("STATUS").split("\n").filter(Boolean)) {
      const [code = "", ...paths] = line.split("\t");
      const status = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : code.startsWith("R") ? "renamed" : "modified";
      statuses.set(paths.at(-1) ?? "", status);
    }
    const files: TaskChangedFile[] = [];
    for (const line of section("NUMSTAT").split("\n").filter(Boolean)) {
      const [added = "0", deleted = "0", ...rest] = line.split("\t");
      // Renames read "old => new" or "dir/{old => new}"; keep the new path.
      const path = rest.join("\t").replace(/\{[^}]* => ([^}]*)\}/, "$1").replace(/^.* => /, "");
      files.push({ path, status: statuses.get(path) ?? "modified", additions: Number(added) || 0, deletions: Number(deleted) || 0 });
    }
    for (const line of section("UNTRACKED").split("\n").filter(Boolean)) {
      const [count = "0", ...rest] = line.split("\t");
      files.push({ path: rest.join("\t"), status: "added", additions: Number(count) || 0, deletions: 0 });
    }
    const patch = section("PATCH");
    return {
      baseBranch: repo.baseBranch,
      branch: repo.branch,
      headSha: await worktrees.head(agentId, repo, grant),
      files,
      patch: patch.slice(0, PATCH_LIMIT),
      truncated: patch.length > PATCH_LIMIT,
    };
  },

  /**
   * How much the task changed, cheaply enough to run after every turn (module 09): numstat against
   * the merge-base, committed or not, with untracked files counted as added lines; at most
   * `MAX_STAT_PATHS` paths are kept, the totals cover everything.
   */
  async stats(agentId: string, repo: TaskRepo, grant?: FolderGrant | null): Promise<TaskDiffStats> {
    const ref = await baseRef(agentId, repo, grant);
    const script = [
      "set -e",
      `base=$(git merge-base ${quote(ref)} HEAD)`,
      "echo '@@HEAD'; git rev-parse HEAD",
      `echo '@@NUMSTAT'; git diff --numstat -M "$base"`,
      "echo '@@UNTRACKED'; git ls-files --others --exclude-standard | wc -l | tr -d ' '",
      `git ls-files --others --exclude-standard | head -n ${MAX_STAT_PATHS} | while IFS= read -r f; do printf '%s\\t%s\\n' "$(wc -l < "$f" 2>/dev/null | tr -d ' ')" "$f"; done`,
    ].join("\n");
    const out = await run(agentId, script, { cwd: repo.worktree, grant });
    const [, head = "", numstat = "", untracked = ""] = out.split(/^@@(?:HEAD|NUMSTAT|UNTRACKED)\n/m);
    const paths: string[] = [];
    let files = 0;
    let added = 0;
    let removed = 0;
    for (const line of numstat.split("\n").filter(Boolean)) {
      const [plus = "0", minus = "0", ...rest] = line.split("\t");
      files++;
      added += Number(plus) || 0;
      removed += Number(minus) || 0;
      // Renames read "old => new" or "dir/{old => new}"; keep the new path.
      if (paths.length < MAX_STAT_PATHS) paths.push(rest.join("\t").replace(/\{[^}]* => ([^}]*)\}/, "$1").replace(/^.* => /, ""));
    }
    const [count = "0", ...listed] = untracked.split("\n").filter(Boolean);
    files += Number(count) || 0;
    for (const line of listed) {
      const [lines = "0", ...rest] = line.split("\t");
      added += Number(lines) || 0;
      if (paths.length < MAX_STAT_PATHS) paths.push(rest.join("\t"));
    }
    return { files, added, removed, paths, headSha: head.trim() || null, at: Date.now() };
  },

  /**
   * What's changed in the worktree and not committed, as `git status --porcelain` lines (new files
   * included, ignored ones not); none when the worktree isn't there.
   */
  async uncommitted(agentId: string, repo: TaskRepo, grant?: FolderGrant | null): Promise<string[]> {
    const relative = `${WORKTREES}/${repo.worktree.split("/").pop()}`;
    // From the repo folder: a worktree that's gone must not read as the main checkout's status.
    const out = await run(agentId, `cd ${quote(relative)} 2>/dev/null && test -e .git || exit 0\ngit status --porcelain | head -n 50`, { cwd: repo.folder, grant });
    return out.split("\n").filter(Boolean);
  },

  /**
   * Removes the task's worktree. Only a clean one (git refuses when there are changes or new files
   * that aren't committed; ignored files go with it), unless `force`: discarding or deleting the task,
   * where the user asked for its work to go. Its branch stays, unless `deleteBranch` and it was never
   * pushed (no remote branch contains it), so nothing that exists elsewhere is lost.
   */
  async remove(
    agentId: string,
    repo: TaskRepo,
    { deleteBranch = false, force = false, grant }: { deleteBranch?: boolean; force?: boolean; grant?: FolderGrant | null } = {},
  ): Promise<{ branchDeleted: boolean }> {
    const here = { cwd: repo.folder, grant };
    const relative = `${WORKTREES}/${repo.worktree.split("/").pop()}`;
    if (await succeeds(agentId, `test -e ${quote(relative)}`, here)) {
      await run(agentId, `git worktree remove ${force ? "--force " : ""}${quote(relative)}`, here);
    }
    await run(agentId, "git worktree prune", here).catch(() => {});
    if (!deleteBranch) return { branchDeleted: false };
    const pushed = (await run(agentId, `git branch -r --contains ${quote(repo.branch)} 2>/dev/null || true`, here)).trim();
    if (pushed) return { branchDeleted: false };
    return { branchDeleted: await succeeds(agentId, `git branch -D ${quote(repo.branch)}`, here) };
  },
};
