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

/**
 * The project folder on an agent's computer (module 06). A GitHub or topic project lives in
 * ~/projects/<slug> on every computer that works on it: each agent has its own clone, like
 * teammates on their own laptops, set up the same way. A folder project is the user's folder on
 * this Mac, used in place by local computers through the sandbox's folder grant, and only by
 * chats and tasks in that project.
 */

const SHELL_TIMEOUT_MS = 60_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
const WORKTREES = ".tot-worktrees";

export const NEEDS_LOCAL = "This project's folder is on your Mac, so it needs an agent with a local computer.";

/** Project folders already set up on a computer this run ("agentId:projectId"): chats don't check before every command. */
const ready = new Set<string>();
/** Computers whose old ~/repos clones were moved into project folders this run. */
const migrated = new Set<string>();
/** One setup at a time per project on a computer: two tasks starting together mustn't both clone it. */
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

/**
 * Moves the ~/repos/<name> clones of GitHub projects to ~/projects/<slug>, leaving a symlink at the
 * old path so old tasks' worktrees and wiki pages still resolve (and repairing the worktrees' links
 * to the new place). Only a real folder whose origin is the project's repo moves, and only into a
 * free ~/projects/<slug>, so running it again changes nothing.
 */
async function moveClones(active: ActiveComputer, list: Project[]): Promise<void> {
  const candidates = list.filter((p) => p.kind === "github" && p.source).map((project) => ({ project, name: cloneFolder(project.source!) }));
  if (!candidates.length) return;
  const found = await sh(
    active,
    [
      `found() { [ -d "repos/$1" ] && [ ! -L "repos/$1" ] && [ -e "repos/$1/.git" ] && [ ! -e "projects/$2" ] && [ ! -L "projects/$2" ] && printf '%s\\t%s\\n' "$2" "$(git -C "repos/$1" config --get remote.origin.url)"; true; }`,
      ...candidates.map(({ project, name }) => `found ${quote(name)} ${quote(project.slug)}`),
    ].join("\n"),
  );
  const remotes = new Map(found.split("\n").filter(Boolean).map((line) => line.split("\t") as [string, string]));
  const moves = new Map<string, string>(); // name → slug: one project per old clone
  for (const { project, name } of candidates) {
    const remote = remotes.get(project.slug);
    if (remote && !moves.has(name) && sameRepo(remote, project.source!)) moves.set(name, project.slug);
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

/** Clones a GitHub project into ~/projects/<slug>, unless it's there (or an old ~/repos clone can move there). */
async function clone(active: ActiveComputer, project: Project, path: string): Promise<void> {
  const has = async () => (await sh(active, `test -e ${quote(`${path}/.git`)} && echo yes || true`)).trim() === "yes";
  if (await has()) return;
  await moveClones(active, [project]);
  if (await has()) return;
  const url = cloneUrl(project.source ?? "");
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
   * Makes the project folder exist on the agent's computer, and returns its path there:
   * GitHub projects are cloned to ~/projects/<slug> (with the agent's git login), topic projects
   * get an empty ~/projects/<slug>, and a folder project is checked and prepared for tasks
   * (see usableFolder; it needs a local computer).
   */
  ensure(agentId: string, project: Project): Promise<string> {
    if (project.kind === "folder") {
      return Promise.resolve().then(() => {
        const real = checkout.usableFolder(agentId, project, { forTasks: true });
        prepareFolder(real);
        return real;
      });
    }
    const key = `${agentId}:${project.id}`;
    const previous = setups.get(key) ?? Promise.resolve("");
    const next = previous
      .catch(() => "")
      .then(async () => {
        const active = await computerManager.ensure(agentId);
        // A computer made just now (or made again) has none of the folders this run knew about.
        if (active.event === "created") forget(agentId);
        const folder = projects.folder(project)!;
        if (ready.has(key)) return folder;
        const path = `projects/${project.slug}`;
        if (project.kind === "github") await clone(active, project, path);
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
    await moveClones(active, [...projects.list(), ...projects.list({ archived: true })]);
    migrated.add(key);
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
    const shown = tildePath(project.source ?? "");
    if (project.archived) throw new HttpError(400, `The ${project.name} project is archived.`);
    const kind = computerManager.kindFor(agentId);
    if (kind !== "local") throw new HttpError(400, kind ? NEEDS_LOCAL : "Turn on the local computer in Settings → Computer to work in this folder.");
    if (!project.folderGranted) throw new HttpError(400, `Agents can't use ${shown} yet: allow it on the ${project.name} project's page.`);
    let real: string;
    try {
      real = resolveFolder(project.source ?? "");
    } catch (err) {
      throw new HttpError(400, err instanceof FolderRefused ? `${shown} can't be used: ${err.message}` : errorText(err));
    }
    if (real !== project.source) throw new HttpError(400, `${shown} has moved or changed. Add it again as a new project.`);
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
 * The folder grant a chat's or task's commands get: only for a chat in a folder project the user
 * allowed, never for any other chat. A task also gets its own branch and worktree in it. Throws,
 * in words for the agent, when the folder can't be used.
 */
export function grantFor(chat: Pick<ConversationRecord, "agentId" | "projectId" | "kind" | "task">): FolderGrant | null {
  const project = projects.get(chat.projectId);
  if (project?.kind !== "folder") return null;
  const folder = checkout.usableFolder(chat.agentId, project);
  const repo = chat.kind === "task" ? chat.task?.repo : null;
  return repo && repo.folder === folder ? { folder, task: { branch: repo.branch, worktree: basename(repo.worktree) } } : { folder };
}

/**
 * What a chat's computer tools need from its project before they run: its folder set up on the
 * computer (cloned, or made for a topic), and for a folder on this Mac, the grant. A problem
 * becomes a note for the agent, and the tool still runs.
 */
export async function forTools(
  chat: Pick<ConversationRecord, "agentId" | "projectId" | "kind" | "task">,
  active: ActiveComputer,
): Promise<{ grant: FolderGrant | null; note: string }> {
  const project = projects.get(chat.projectId);
  if (!project || (project.archived && project.kind !== "folder")) return { grant: null, note: "" };
  try {
    if (project.kind !== "folder") {
      await checkout.ensure(chat.agentId, project);
      return { grant: null, note: "" };
    }
    if (active.backend.kind !== "local") return { grant: null, note: `[${NEEDS_LOCAL}]\n` };
    return { grant: grantFor(chat), note: "" };
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
  if (project && project.kind !== "none") await checkout.ensure(task.agentId, project);
  const grant = grantFor(task);
  const { repo, created } = await worktrees.ensure(task.agentId, task.task.repo!, grant);
  // Set up only when this call made the worktree: two replies at once don't both run the setup.
  await worktreeSetup.prepared(task, repo, grant, { fresh: created });
  return repo;
}
