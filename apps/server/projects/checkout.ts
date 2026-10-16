import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Project, TaskRepo } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { quote } from "../computer/github-login.ts";
import { computerManager, type ActiveComputer } from "../computer/manager.ts";
import type { FolderGrant } from "../computer/types.ts";
import { cloneFolder, githubFullName } from "../data/brains.ts";
import type { ConversationRecord } from "../data/conversations.ts";
import { redactGitHubTokens } from "../github.ts";
import { taskStore, type TaskRecord } from "../tasks/store.ts";
import { cloneUrl, worktrees } from "../tasks/worktree.ts";
import { worktreeSetup } from "../worktrees/setup.ts";
import { FolderRefused, gitState, resolveFolder, tildePath } from "./folders.ts";
import { projects } from "./projects.ts";
import { projectRepos, type RepoRecord } from "./repos.ts";

/**
 * The project folder on an agent's computer (module 06). A GitHub or topic project lives in
 * ~/projects/<slug> on every computer that works on it: each agent has its own clone, like
 * teammates on their own laptops, set up the same way. A folder project is the user's folder on
 * this Mac, used in place by local computers through the sandbox's folder grant, and only by
 * chats and tasks in that project. A project with several repos (module 11) has each GitHub repo
 * cloned next to the primary's (~/projects/<slug>.<name>), and each folder with its own grant.
 */

const SHELL_TIMEOUT_MS = 60_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
const WORKTREES = ".tot-worktrees";

export const NEEDS_LOCAL = "This project's folder is on your Mac, so it needs an agent with a local computer.";

/** Project folders already set up on a computer this run ("agentId:~/projects/…"): chats don't check before every command. */
const ready = new Set<string>();
/** Computers whose old ~/repos clones were moved into project folders this run. */
const migrated = new Set<string>();
/** One setup at a time per project folder on a computer: two tasks starting together mustn't both clone it. */
const setups = new Map<string, Promise<string>>();

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Runs a script on the computer from its home folder; throws with the command's own last words. */
async function sh(active: ActiveComputer, script: string, timeoutMs = SHELL_TIMEOUT_MS): Promise<string> {
  const result = await active.backend.exec(active.externalId, script, { timeoutMs });
  if (result.exitCode !== 0) {
    const said = redactGitHubTokens(result.stderr || result.stdout).trim().split("\n").filter(Boolean).slice(-2).join(" · ");
    throw new Error(said || `exit code ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`);
  }
  return result.stdout;
}

/** Whether a clone's origin URL is the project's repo ("acme/web", or the URL it was made from). */
function sameRepo(remote: string, source: string): boolean {
  const url = cloneUrl(source) ?? source;
  const name = githubFullName(remote);
  if (name) return name.toLowerCase() === (githubFullName(url) ?? "").toLowerCase();
  const clean = (text: string) => text.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
  return clean(remote) === clean(url);
}

/** A GitHub repo's clone on the computer: its source, and its folder under ~/projects ("web", "web.api"). */
interface Clone {
  source: string;
  dir: string;
}

/** The project's GitHub repos' clones (module 11: the primary's ~/projects/<slug>, and its added repos' next to it). */
function clonesOf(project: Project): Clone[] {
  return projectRepos
    .list(project.id)
    .filter((repo) => repo.kind === "github" && repo.checkout?.startsWith("~/projects/"))
    .map((repo) => ({ source: repo.source, dir: repo.checkout!.slice("~/projects/".length) }));
}

/**
 * Moves the ~/repos/<name> clones of GitHub projects' repos to their folders in ~/projects, leaving a
 * symlink at the old path so old tasks' worktrees and wiki pages still resolve (and repairing the
 * worktrees' links to the new place). Only a real folder whose origin is the repo moves, and only into
 * a free folder, so running it again changes nothing.
 */
async function moveClones(active: ActiveComputer, list: Clone[]): Promise<void> {
  const candidates = list.map((clone) => ({ ...clone, name: cloneFolder(clone.source) }));
  if (!candidates.length) return;
  const found = await sh(
    active,
    [
      `found() { [ -d "repos/$1" ] && [ ! -L "repos/$1" ] && [ -e "repos/$1/.git" ] && [ ! -e "projects/$2" ] && [ ! -L "projects/$2" ] && printf '%s\\t%s\\n' "$2" "$(git -C "repos/$1" config --get remote.origin.url)"; true; }`,
      ...candidates.map(({ dir, name }) => `found ${quote(name)} ${quote(dir)}`),
    ].join("\n"),
  );
  const remotes = new Map(found.split("\n").filter(Boolean).map((line) => line.split("\t") as [string, string]));
  const moves = new Map<string, string>(); // name → folder: one repo per old clone
  for (const { source, dir, name } of candidates) {
    const remote = remotes.get(dir);
    if (remote && !moves.has(name) && sameRepo(remote, source)) moves.set(name, dir);
  }
  if (!moves.size) return;
  await sh(
    active,
    [
      `move() { mkdir -p projects && mv "repos/$1" "projects/$2" && ln -s "../projects/$2" "repos/$1" && (cd "projects/$2" && for w in ${WORKTREES}/*; do [ -e "$w/.git" ] && git worktree repair "$w" >/dev/null 2>&1; done; true); }`,
      ...[...moves].map(([name, slug]) => `move ${quote(name)} ${quote(slug)}`),
    ].join("\n"),
  );
  console.log(`[tot] moved ${[...moves.keys()].map((name) => `~/repos/${name}`).join(", ")} into ~/projects`);
}

/**
 * Clones a GitHub repo into its folder in ~/projects, unless it's there (or an old ~/repos clone can move
 * there). An added repo's folder (module 11) that holds a clone of another repo (one removed from the
 * project, then a new one added under its name) is refused rather than used.
 */
async function clone(active: ActiveComputer, project: Project, repo: Clone, path: string): Promise<void> {
  const has = async () => (await sh(active, `test -e ${quote(`${path}/.git`)} && echo yes || true`)).trim() === "yes";
  if (!(await has())) await moveClones(active, [repo]);
  if (await has()) {
    if (repo.dir === project.slug) return;
    const remote = (await sh(active, `git -C ${quote(path)} config --get remote.origin.url || true`)).trim();
    if (remote && !sameRepo(remote, repo.source)) throw new Error(`~/${path} holds a clone of another repo. Move it aside, then try again.`);
    return;
  }
  const url = cloneUrl(repo.source);
  if (!url) throw new Error(`${project.name} has no repo to clone.`);
  // With the agent's GitHub login, set up on the computer by the computer manager.
  await sh(active, `mkdir -p projects && git clone --quiet ${quote(url)} ${quote(path)}`, CLONE_TIMEOUT_MS);
}

/**
 * A folder project's repo made ready for task worktrees, by TOT itself: the sandbox lets a task
 * write only its own worktree and branch, so the folders around them come from here, and
 * .tot-worktrees is kept out of the user's `git status`.
 */
function prepareFolder(real: string): void {
  const shown = tildePath(real);
  const git = join(real, ".git");
  if (existsSync(join(git, "reftable"))) throw new HttpError(400, `${shown} uses git's reftable format, which tasks can't make branches in yet.`);
  try {
    for (const dir of [WORKTREES, ".git/worktrees", ".git/refs/heads/tot", ".git/logs/refs/heads/tot"]) mkdirSync(join(real, dir), { recursive: true });
  } catch {
    throw new HttpError(400, `Tasks can't make tot/… branches in ${shown} (does it have a branch named "tot"?).`);
  }
  if (!lstatSync(join(real, WORKTREES)).isDirectory()) throw new HttpError(400, `${shown}/${WORKTREES} isn't a folder.`);
  const exclude = join(git, "info", "exclude");
  const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!text.split("\n").includes(`${WORKTREES}/`)) {
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${text && !text.endsWith("\n") ? "\n" : ""}${WORKTREES}/\n`);
  }
}

function forget(agentId: string): void {
  for (const key of ready) if (key.startsWith(`${agentId}:`)) ready.delete(key);
}

export const checkout = {
  /**
   * Makes a project folder exist on the agent's computer, and returns its path there: a GitHub repo is
   * cloned to its folder in ~/projects (with the agent's git login), a topic project gets an empty
   * ~/projects/<slug>, and a folder on this Mac is checked and prepared for tasks (see usableFolder; it
   * needs a local computer). Module 11: `repo` is one of the project's repos; without it, the primary.
   */
  ensure(agentId: string, project: Project, repo: RepoRecord | null = projectRepos.primary(project.id)): Promise<string> {
    if (repo?.kind === "folder") {
      return Promise.resolve().then(() => {
        const real = checkout.usableRepoFolder(agentId, project, repo, { forTasks: true });
        prepareFolder(real);
        return real;
      });
    }
    const folder = repo ? projectRepos.folder(repo) : `~/projects/${project.slug}`;
    const key = `${agentId}:${folder}`;
    const previous = setups.get(key) ?? Promise.resolve("");
    const next = previous
      .catch(() => "")
      .then(async () => {
        const active = await computerManager.ensure(agentId);
        // A computer made just now (or made again) has none of the folders this run knew about.
        if (active.event === "created") forget(agentId);
        if (ready.has(key)) return folder;
        const path = folder.slice(2);
        if (repo) await clone(active, project, { source: repo.source, dir: path.slice("projects/".length) }, path);
        else await sh(active, `mkdir -p ${quote(path)}`);
        ready.add(key);
        return folder;
      });
    setups.set(key, next);
    void next
      .finally(() => {
        if (setups.get(key) === next) setups.delete(key);
      })
      .catch(() => {});
    return next;
  },

  /**
   * Repos cloned before projects existed move into their project folders: once per computer per
   * run, when the computer is first used (computerManager.ensure calls this with the computer).
   */
  async migrate(agentId: string, active: ActiveComputer): Promise<void> {
    const key = `${agentId}:${active.externalId}`;
    if (migrated.has(key)) return;
    await moveClones(active, [...projects.list(), ...projects.list({ archived: true })].flatMap(clonesOf));
    migrated.add(key);
  },

  /**
   * What a chat's computer tools need first (module 11): every GitHub repo of the project cloned, or a
   * topic project's folder made. Folders on this Mac need nothing here. With one repo (or none) it throws
   * as ensure does; with several it returns notes for the agent on those that couldn't be set up, and
   * sets up the others.
   */
  async ensureAll(agentId: string, project: Project): Promise<string[]> {
    const repos = projectRepos.list(project.id);
    if (repos.length <= 1) {
      if (repos[0]?.kind !== "folder") await checkout.ensure(agentId, project, repos[0] ?? null);
      return [];
    }
    const notes: string[] = [];
    for (const repo of repos.filter((each) => each.kind === "github")) {
      await checkout.ensure(agentId, project, repo).catch((err) => notes.push(`${repo.name} (${repo.source}) couldn't be set up: ${errorText(err)}`));
    }
    return notes;
  },

  /** Tests: forget what this run has set up and moved, as a restarted server would. */
  reset(): void {
    ready.clear();
    migrated.clear();
  },

  /**
   * A folder project's real path, when this agent may use it; otherwise an error that says why, in
   * words for the user: the folder isn't shared yet, has gone or moved, or the agent's computer
   * isn't on this Mac. Tasks also need a git repo of its own (`forTasks`).
   */
  usableFolder(agentId: string, project: Project, { forTasks = false } = {}): string {
    const primary = projectRepos.primary(project.id);
    if (primary?.kind !== "folder") throw new HttpError(400, `${project.name} isn't a folder on this Mac.`);
    return checkout.usableRepoFolder(agentId, project, primary, { forTasks });
  },

  /** usableFolder for one of the project's folder repos (module 11): each has its own grant. */
  usableRepoFolder(agentId: string, project: Project, repo: RepoRecord, { forTasks = false } = {}): string {
    const shown = tildePath(repo.source);
    if (project.archived) throw new HttpError(400, `The ${project.name} project is archived.`);
    const kind = computerManager.kindFor(agentId);
    if (kind !== "local") throw new HttpError(400, kind ? NEEDS_LOCAL : "Turn on the local computer in Settings → Computer to work in this folder.");
    if (!repo.folderGranted) throw new HttpError(400, `Agents can't use ${shown} yet: allow it on the ${project.name} project's page.`);
    let real: string;
    try {
      real = resolveFolder(repo.source);
    } catch (err) {
      throw new HttpError(400, err instanceof FolderRefused ? `${shown} can't be used: ${err.message}` : errorText(err));
    }
    if (real !== repo.source) throw new HttpError(400, `${shown} has moved or changed. Add it again as a new ${repo.primary ? "project" : "repo"}.`);
    if (forTasks) {
      const git = gitState(real);
      if (git === "none") throw new HttpError(400, `${shown} isn't a git repo, so tasks can't start in it. Agents can still read it in chats.`);
      if (git === "linked") {
        throw new HttpError(400, `${shown} is a git worktree or submodule of another repo, so tasks can't start in it yet. Add the main checkout as the project instead.`);
      }
    }
    return real;
  },
};

/**
 * The folder grant a chat's or task's commands get: only for a chat in a project with a folder on this
 * Mac the user allowed, never for any other chat. A coding task in a folder repo gets that folder, with
 * its own branch and worktree in it; one in a GitHub repo gets none (its clone is on its computer). A
 * chat, or a task without code, gets the project's folders to read; a chat that picked where it works gets the
 * main checkout to change, or its own worktree as a task does (chats/workspace.ts). Module 11: a project's other allowed
 * folders come along as `reads`. Throws, in words for the agent, when the task's folder (or a folder
 * project's own) can't be used.
 */
export function grantFor(chat: Pick<ConversationRecord, "agentId" | "projectId" | "kind" | "task"> & Pick<Partial<ConversationRecord>, "workspace">): FolderGrant | null {
  const project = projects.get(chat.projectId);
  if (!project) return null;
  const repos = projectRepos.list(project.id);
  const taskRepo = chat.kind === "task" ? chat.task?.repo : null;
  const own = taskRepo ? projectRepos.forTask({ projectId: project.id, task: chat.task }) : null;
  // A clone needs no grant; nor does a repo of no project's (a topic project's task), and a folder the project no longer holds gets none.
  if (taskRepo && own?.kind !== "folder") return null;
  const usable = (repo: RepoRecord) => {
    try {
      return checkout.usableRepoFolder(chat.agentId, project, repo);
    } catch {
      return null;
    }
  };
  // The folder it works in (a task's), or else the primary when it's a folder: these must be usable.
  const first = own ?? (repos[0]?.kind === "folder" ? repos[0] : null);
  const folder = first ? checkout.usableRepoFolder(chat.agentId, project, first) : null;
  const others = repos
    .filter((repo) => repo.kind === "folder" && repo.name !== first?.name)
    .map(usable)
    .filter((path): path is string => Boolean(path));
  const main = folder ?? others.shift();
  if (!main) return null;
  const reads = others.length ? { reads: others } : {};
  if (taskRepo && taskRepo.folder === main) return { folder: main, task: { branch: taskRepo.branch, worktree: basename(taskRepo.worktree) }, ...reads };
  // A chat that picked where it works: the primary folder's main checkout to change, or its own worktree there,
  // granted as a task's is (only once its branch is named; a GitHub primary's clone needs no grant).
  const workspace = chat.kind === "task" ? null : chat.workspace;
  if (workspace && folder === main) {
    if (workspace.mode === "checkout") return { folder: main, write: true, ...reads };
    if (workspace.branch && workspace.worktree) return { folder: main, task: { branch: workspace.branch, worktree: basename(workspace.worktree) }, ...reads };
  }
  return { folder: main, ...reads };
}

/**
 * What a chat's computer tools need from its project before they run: its folder set up on the
 * computer (cloned, or made for a topic), and for a folder on this Mac, the grant. A problem
 * becomes a note for the agent, and the tool still runs.
 */
export async function forTools(
  chat: Pick<ConversationRecord, "agentId" | "projectId" | "kind" | "task"> & Pick<Partial<ConversationRecord>, "workspace">,
  active: ActiveComputer,
): Promise<{ grant: FolderGrant | null; note: string }> {
  const project = projects.get(chat.projectId);
  const folders = project ? projectRepos.list(project.id).filter((repo) => repo.kind === "folder") : [];
  if (!project || (project.archived && !folders.length)) return { grant: null, note: "" };
  try {
    // Every GitHub repo cloned (module 11: a project may have several), or a topic's folder made.
    const problems = project.archived ? [] : await checkout.ensureAll(chat.agentId, project);
    const note = problems.length ? `[Not every repo of the project could be set up: ${problems.join("; ")}]\n` : "";
    if (!folders.length) return { grant: null, note };
    if (active.backend.kind !== "local") return { grant: null, note: project.kind === "folder" ? `${note}[${NEEDS_LOCAL}]\n` : note };
    return { grant: grantFor(chat), note };
  } catch (err) {
    return { grant: null, note: `[The project's folder can't be used right now: ${errorText(err)}]\n` };
  }
}

/**
 * A task's repo made ready to work in: its project's folder on the computer first, then the task's own
 * worktree, then (module 09) its ports, and for a worktree made just now its project's files and setup.
 * One at a time per task (worktrees.forTask), with picking it up again, landing it and cleanup.
 */
export function prepareTask(task: TaskRecord): Promise<TaskRepo> {
  return worktrees.forTask(task.id, () => prepareTaskNow(taskStore.get(task.id) ?? task));
}

/** prepareTask, for a caller that's already running alone for the task (inside worktrees.forTask). */
export async function prepareTaskNow(task: TaskRecord): Promise<TaskRepo> {
  const project = projects.get(task.projectId);
  // Module 11: the project repo it works in (a task of a topic project, or of a repo since removed, sets up on its own).
  const own = project ? projectRepos.forTask(task) : null;
  if (project && own) await checkout.ensure(task.agentId, project, own);
  const grant = grantFor(task);
  const { repo, created } = await worktrees.ensure(task.agentId, task.task.repo!, grant);
  // Set up only when this call made the worktree: two replies at once don't both run the setup.
  await worktreeSetup.prepared(task, repo, grant, { fresh: created });
  return repo;
}
