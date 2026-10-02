import { randomBytes } from "node:crypto";
import type { TaskChangedFile, TaskChanges, TaskRepo } from "../../shared/types.ts";
import { quote } from "../computer/github-login.ts";
import { computerManager } from "../computer/manager.ts";
import { cloneFolder, githubFullName } from "../data/brains.ts";
import { redactGitHubTokens } from "../github.ts";

/**
 * A coding task's own branch and git worktree, on its agent's computer (never on this Mac
 * directly): the repo lives in ~/repos/<name> as Learn a repo keeps it, and each task checks
 * its branch out in <repo>/.tot-worktrees/<branch slug>, so tasks on the same repo run side by
 * side without touching each other or the base branch. Nothing here ever pushes.
 */

const WORKTREES = ".tot-worktrees";
const GIT_TIMEOUT_MS = 120_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
const PATCH_LIMIT = 300_000;
const MAX_UNTRACKED = 50;

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

/** The repo part of a new task: its branch and worktree are named now, created when the task first runs. */
export function planRepo(source: string, title: string, baseBranch?: string): TaskRepo {
  const folder = repoFolder(source);
  const branch = `tot/${slugify(title, 28)}-${randomBytes(2).toString("hex")}`;
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

/** Runs a shell command on the agent's computer; throws with git's own words when it fails. */
async function run(agentId: string, command: string, cwd?: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  const active = await computerManager.ensure(agentId);
  const result = await active.backend.exec(active.externalId, command, { cwd: cwd ? homeRelative(cwd) : undefined, timeoutMs });
  computerManager.touch(agentId);
  if (result.exitCode !== 0) {
    throw new Error(oneLine(result.stderr || result.stdout) || `exit code ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`);
  }
  return result.stdout;
}

async function succeeds(agentId: string, command: string, cwd?: string): Promise<boolean> {
  try {
    await run(agentId, command, cwd);
    return true;
  } catch {
    return false;
  }
}

/** The ref a task's branch starts from: origin/<base> when the repo has a remote copy of it. */
async function baseRef(agentId: string, repo: TaskRepo): Promise<string> {
  const remote = `origin/${repo.baseBranch}`;
  return (await succeeds(agentId, `git rev-parse --verify --quiet ${quote(`${remote}^{commit}`)}`, repo.folder)) ? remote : repo.baseBranch;
}

/** One setup at a time per repo on a computer: two tasks starting together mustn't both clone it, or race on `git worktree add`. */
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

async function defaultBranch(agentId: string, folder: string): Promise<string> {
  const remoteHead = await run(agentId, "git symbolic-ref --quiet --short refs/remotes/origin/HEAD || true", folder);
  const name = remoteHead.trim().replace(/^origin\//, "");
  if (name) return name;
  return (await run(agentId, "git rev-parse --abbrev-ref HEAD", folder)).trim() || "main";
}

/** Clones (if needed), fetches, and adds the task's worktree; see `worktrees.ensure`. */
async function setUp(agentId: string, repo: TaskRepo): Promise<TaskRepo> {
  const { folder } = repo;
  if (!(await succeeds(agentId, "test -e .git", folder))) {
    const url = cloneUrl(repo.source);
    if (!url) throw new Error(`There's no git repo at ${folder} on the computer.`);
    await run(agentId, `mkdir -p ${quote(homeRelative(folder).replace(/\/[^/]+$/, "") || ".")} && git clone --quiet ${quote(url)} ${quote(homeRelative(folder))}`, undefined, CLONE_TIMEOUT_MS);
  }
  // A repo without a remote (a local folder) simply has nothing to fetch.
  if (await succeeds(agentId, "git remote get-url origin", folder)) {
    await run(agentId, "git fetch --quiet origin", folder, CLONE_TIMEOUT_MS).catch((err) => {
      console.warn(`[tot] git fetch in ${folder} failed, using what's there:`, err instanceof Error ? err.message : err);
    });
  }
  const baseBranch = repo.baseBranch || (await defaultBranch(agentId, folder));
  const planned: TaskRepo = { ...repo, baseBranch };
  const relative = `${WORKTREES}/${repo.worktree.split("/").pop()}`;
  if (!(await succeeds(agentId, `test -e ${quote(`${relative}/.git`)}`, folder))) {
    // Keep worktrees out of the main checkout's `git status`.
    await run(
      agentId,
      `mkdir -p ${WORKTREES} && exclude="$(git rev-parse --git-path info/exclude)" && mkdir -p "$(dirname "$exclude")" && (grep -qxF '${WORKTREES}/' "$exclude" 2>/dev/null || echo '${WORKTREES}/' >> "$exclude")`,
      folder,
    );
    const branchExists = await succeeds(agentId, `git rev-parse --verify --quiet ${quote(`refs/heads/${repo.branch}`)}`, folder);
    await run(
      agentId,
      branchExists
        ? `git worktree add --quiet ${quote(relative)} ${quote(repo.branch)}`
        : `git worktree add --quiet -b ${quote(repo.branch)} ${quote(relative)} ${quote(await baseRef(agentId, planned))}`,
      folder,
    );
  }
  return { ...planned, headSha: await worktrees.head(agentId, planned) };
}

export const worktrees = {
  /**
   * Makes sure the task's worktree exists: clones the repo if it isn't on the computer yet
   * (with the agent's GitHub login, set up by the computer manager), fetches, and adds the
   * branch's worktree from the base. Returns the repo with its base branch and head filled in.
   */
  ensure(agentId: string, repo: TaskRepo): Promise<TaskRepo> {
    return oneAtATime(`${agentId}:${repo.folder}`, () => setUp(agentId, repo));
  },

  /** The branch's newest commit; null when the worktree isn't there. */
  async head(agentId: string, repo: TaskRepo): Promise<string | null> {
    try {
      return (await run(agentId, "git rev-parse HEAD", repo.worktree)).trim() || null;
    } catch {
      return null;
    }
  },

  /** Everything the task changed: committed or not, tracked or new, against where its branch left the base. */
  async changes(agentId: string, repo: TaskRepo): Promise<TaskChanges> {
    const ref = await baseRef(agentId, repo);
    const script = [
      "set -e",
      `base=$(git merge-base ${quote(ref)} HEAD)`,
      `echo '@@NUMSTAT'; git diff --numstat -M "$base"`,
      `echo '@@STATUS'; git diff --name-status -M "$base"`,
      `echo '@@UNTRACKED'; git ls-files --others --exclude-standard | head -n ${MAX_UNTRACKED} | while IFS= read -r f; do printf '%s\\t%s\\n' "$(wc -l < "$f" | tr -d ' ')" "$f"; done`,
      `echo '@@PATCH'; { git diff -M "$base"; git ls-files --others --exclude-standard | head -n ${MAX_UNTRACKED} | while IFS= read -r f; do git diff --no-index -- /dev/null "$f" || true; done; } | head -c ${PATCH_LIMIT + 1}`,
    ].join("\n");
    const out = redactGitHubTokens(await run(agentId, script, repo.worktree));
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
      headSha: await worktrees.head(agentId, repo),
      files,
      patch: patch.slice(0, PATCH_LIMIT),
      truncated: patch.length > PATCH_LIMIT,
    };
  },

  /**
   * Removes the task's worktree. Its branch stays, unless `deleteBranch` and it was never
   * pushed (no remote branch contains it), so nothing that exists elsewhere is lost.
   */
  async remove(agentId: string, repo: TaskRepo, { deleteBranch = false } = {}): Promise<{ branchDeleted: boolean }> {
    const relative = `${WORKTREES}/${repo.worktree.split("/").pop()}`;
    if (await succeeds(agentId, `test -e ${quote(relative)}`, repo.folder)) {
      await run(agentId, `git worktree remove --force ${quote(relative)}`, repo.folder);
    }
    await run(agentId, "git worktree prune", repo.folder).catch(() => {});
    if (!deleteBranch) return { branchDeleted: false };
    const pushed = (await run(agentId, `git branch -r --contains ${quote(repo.branch)} 2>/dev/null || true`, repo.folder)).trim();
    if (pushed) return { branchDeleted: false };
    return { branchDeleted: await succeeds(agentId, `git branch -D ${quote(repo.branch)}`, repo.folder) };
  },
};
