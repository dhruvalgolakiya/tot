import type { AddProjectRepoRequest, Project, ProjectRepo, ProjectRepoKind, TaskInfo, UpdateProjectRepoRequest } from "@tot/shared/types";
import { HttpError } from "../agent/orchestrator.ts";
import { appEvents } from "../app-events.ts";
import { githubFullName } from "../data/brains.ts";
import { conversations } from "../data/conversations.ts";
import { db, type Row } from "../db.ts";
import { FINISHED, isTask, taskStore, type TaskRecord } from "../tasks/store.ts";
import { tildePath } from "./folders.ts";
import { cleanFolderSource, cleanGitHubSource, projects } from "./projects.ts";

/**
 * A project's repos (roadmap module 11, lane A): a project is a workspace of GitHub repos and folders
 * on this Mac ("web", "api", "mobile"), and each task works in one of them. The primary keeps the
 * project's original checkout, tasks default to it, and the project's own kind, source, base branch
 * and folder grant mirror it, so code from before 11 keeps working. An added GitHub repo is cloned
 * next to the primary, at ~/projects/<slug>.<name> (a sibling, never inside another clone), and keeps
 * that folder for good; a folder on this Mac is used in place, with its own grant. Removing a repo
 * leaves its files where they are.
 */

const KINDS: readonly ProjectRepoKind[] = ["github", "folder"];
/** A repo's name: what tasks and the knowledge base call it ("web", "api"). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const MAX_REPOS = 20;
const BRANCH = /^[\w./-]+$/;

/** A repo as stored: its public fields, where it lives, and its place in the list. */
export interface RepoRecord extends ProjectRepo {
  projectId: string;
  position: number;
  /** A GitHub repo's folder on every agent's computer ("~/projects/web.api"); null for a folder on this Mac. */
  checkout: string | null;
  /** When the user allowed agents into a folder repo. */
  grantedAt: number | null;
}

/** "acme/web" → "web", "https://gitlab.com/x/api.git" → "api", "/Users/me/code/meet-notes" → "meet-notes". */
export function repoNameFrom(source: string): string {
  const last = source.trim().replace(/[/\\]+$/, "").replace(/\.git$/i, "").split(/[/:\\]/).pop() ?? "";
  const name = last.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 40).replace(/[.-]+$/, "");
  return name || "repo";
}

function rowsOf(projectId: string): RepoRecord[] {
  const rows = db.prepare(`SELECT * FROM project_repos WHERE project_id = ? ORDER BY position, created_at`).all(projectId) as Row[];
  return rows.map((row, index) => {
    const grantedAt = row.folder_granted_at === null || row.folder_granted_at === undefined ? null : Number(row.folder_granted_at);
    return {
      projectId,
      name: String(row.name),
      kind: row.kind as ProjectRepoKind,
      source: String(row.source),
      defaultBranch: (row.default_branch as string | null) ?? null,
      folderGranted: row.kind === "github" || grantedAt !== null,
      primary: index === 0,
      position: Number(row.position),
      checkout: (row.checkout as string | null) ?? null,
      grantedAt,
    };
  });
}

/** The one repo a project with code had before 11: its own source, as its primary, in the checkout it already has. */
function insertPrimaryFrom(project: Row): void {
  const kind = project.kind as ProjectRepoKind;
  db.prepare(
    `INSERT OR IGNORE INTO project_repos (project_id, name, kind, source, default_branch, folder_granted_at, position, checkout, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    String(project.id),
    repoNameFrom(String(project.source)),
    kind,
    String(project.source),
    (project.default_branch as string | null) ?? null,
    kind === "folder" ? ((project.folder_granted_at as number | null) ?? null) : null,
    kind === "github" ? `~/projects/${project.slug}` : null,
    Number(project.created_at),
  );
}

const WITHOUT_REPOS = `SELECT * FROM projects p WHERE kind IN ('github', 'folder') AND source IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM project_repos r WHERE r.project_id = p.id)`;

/**
 * Module 11's migration (at startup; idempotent): every project with a GitHub repo or a folder gets it as
 * its one primary repo, in the checkout it has today (~/projects/<slug>, or the folder itself). Topic
 * projects get none. Returns how many projects it gave a repo.
 */
export function migrateProjectRepos(): number {
  const rows = db.prepare(WITHOUT_REPOS).all() as Row[];
  for (const row of rows) insertPrimaryFrom(row);
  if (rows.length) console.log(`[tot] gave ${rows.length} project${rows.length === 1 ? "" : "s"} its repo as the primary (module 11)`);
  return rows.length;
}

/**
 * The project's kind, source, base branch and grant follow its primary repo (code from before 11 reads
 * them), and say "no files" once it has none.
 */
function mirror(projectId: string): void {
  const primary = rowsOf(projectId)[0];
  db.prepare(`UPDATE projects SET kind = ?, source = ?, default_branch = ?, folder_granted_at = ?, updated_at = ? WHERE id = ?`).run(
    primary?.kind ?? "none",
    primary?.source ?? null,
    primary?.defaultBranch ?? null,
    primary?.kind === "folder" ? primary.grantedAt : null,
    Date.now(),
    projectId,
  );
}

/** Two sources for the same repo: the same GitHub owner/name, the same URL, or the same folder. */
function sameSource(a: string, b: string): boolean {
  const fullName = (text: string) => githubFullName(text) ?? (/^[\w.-]+\/[\w.-]+$/.test(text.trim()) ? text.trim().replace(/\.git$/i, "") : null);
  const [x, y] = [fullName(a), fullName(b)];
  if (x || y) return Boolean(x && y && x.toLowerCase() === y.toLowerCase());
  const clean = (text: string) => tildePath(text.trim().replace(/\/+$/, "").replace(/\.git$/i, "")).toLowerCase();
  return clean(a) === clean(b);
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!NAME.test(name)) throw new HttpError(400, "Name the repo with letters, numbers, dots, dashes or underscores (up to 40), like “web” or “api”.");
  return name;
}

function cleanBranch(value: unknown): string | null {
  const branch = typeof value === "string" ? value.trim() : "";
  if (branch && !BRANCH.test(branch)) throw new HttpError(400, "That isn't a branch name.");
  return branch || null;
}

function requireProject(projectId: string): Project {
  const project = projects.get(projectId);
  if (!project) throw new HttpError(404, "Project not found.");
  if (project.archived) throw new HttpError(400, "This project is archived.");
  return project;
}

function requireRepo(projectId: string, name: string): RepoRecord {
  const repo = projectRepos.get(projectId, name);
  if (!repo) throw new HttpError(404, `There's no repo called “${name}” in this project.`);
  return repo;
}

/** An added GitHub repo's clone: ~/projects/<slug>.<name>, next to the primary's, never one another repo of the project uses. */
function checkoutFor(project: Project, list: RepoRecord[], name: string): string {
  const taken = new Set(list.map((repo) => repo.checkout?.toLowerCase()).filter(Boolean));
  const base = `~/projects/${project.slug}.${name.toLowerCase()}`;
  let path = base;
  for (let n = 2; taken.has(path); n++) path = `${base}-${n}`;
  return path;
}

/** Tasks with work in the repo: still going, or finished with a worktree whose work hasn't landed (a merge or a PR) or been discarded. */
function tasksWithWork(repo: RepoRecord): TaskRecord[] {
  const folder = projectRepos.folder(repo);
  return conversations
    .inProject(repo.projectId)
    .filter(isTask)
    .filter((task) => task.task.repo?.folder === folder)
    .filter((task) => !FINISHED.has(task.task.status) || (Boolean(task.task.repo?.headSha) && !task.task.landing));
}

function publish(projectId: string): Project {
  const project = projects.get(projectId)!;
  appEvents.publish({ type: "project", project });
  return project;
}

export const projectRepos = {
  /** The project's repos, the primary first. A project with code from before 11 gets its primary here if startup hasn't given it one. */
  list(projectId: string): RepoRecord[] {
    const list = rowsOf(projectId);
    if (list.length) return list;
    const old = db.prepare(`${WITHOUT_REPOS} AND p.id = ?`).get(projectId) as Row | undefined;
    if (!old) return list;
    insertPrimaryFrom(old);
    return rowsOf(projectId);
  },

  get(projectId: string, name: string): RepoRecord | null {
    const key = name.trim().toLowerCase();
    return projectRepos.list(projectId).find((repo) => repo.name.toLowerCase() === key) ?? null;
  },

  primary(projectId: string): RepoRecord | null {
    return projectRepos.list(projectId)[0] ?? null;
  },

  /** What a client sees: the stored fields without where the clone lives. */
  toPublic({ name, kind, source, defaultBranch, folderGranted, primary }: RepoRecord): ProjectRepo {
    return { name, kind, source, defaultBranch, folderGranted, primary };
  },

  /** Where the repo's files are on an agent's computer: its clone (~/projects/…), or the folder on this Mac itself. */
  folder(repo: RepoRecord): string {
    return repo.kind === "folder" ? repo.source : (repo.checkout ?? "");
  },

  /** One of the project's repos by its name, or by what it is ("acme/api", its URL, its folder); null when none is. */
  resolve(projectId: string, ref: string): RepoRecord | null {
    const text = ref.trim();
    if (!text) return null;
    return projectRepos.get(projectId, text) ?? projectRepos.list(projectId).find((repo) => sameSource(repo.source, text)) ?? null;
  },

  /**
   * The repo a new task in the project works in: the one `ref` names, or the primary. A project with one
   * repo ignores a `ref` that isn't it, as before 11; with several, an unknown one is an error that lists
   * them. Null for a project with no repos (a topic: a task there may still name a repo of its own).
   */
  pick(project: Project, ref: unknown): RepoRecord | null {
    const list = projectRepos.list(project.id);
    if (!list.length) return null;
    const text = typeof ref === "string" ? ref.trim() : "";
    if (!text) return list[0]!;
    const found = projectRepos.resolve(project.id, text);
    if (found || list.length === 1) return found ?? list[0]!;
    throw new HttpError(400, `There's no repo called “${text}” in ${project.name}. Its repos: ${list.map((repo) => repo.name).join(", ")}.`);
  },

  /** The repo a task works in, found by its folder (the same before and after a rename); null outside a project's repos. */
  forTask(task: { projectId: string | null; task: Pick<TaskInfo, "repo"> | null }): RepoRecord | null {
    const folder = task.task?.repo?.folder;
    if (!task.projectId || !folder) return null;
    return projectRepos.list(task.projectId).find((repo) => projectRepos.folder(repo) === folder) ?? null;
  },

  /** POST /api/projects/:id/repos: a GitHub repo, or a folder on this Mac (granted at once with `grant`, after the consent dialog). */
  add(projectId: string, input: AddProjectRepoRequest): Project {
    const project = requireProject(projectId);
    const kind = input?.kind;
    if (!KINDS.includes(kind)) throw new HttpError(400, 'A repo is a GitHub repo or a folder on this Mac ("github" or "folder").');
    const source = kind === "github" ? cleanGitHubSource(input.source) : cleanFolderSource(input.source);
    const list = projectRepos.list(projectId);
    if (list.length >= MAX_REPOS) throw new HttpError(400, `A project holds at most ${MAX_REPOS} repos.`);
    const same = list.find((repo) => repo.kind === kind && sameSource(repo.source, source));
    if (same) throw new HttpError(409, `That's in ${project.name} already, as “${same.name}”.`);
    const taken = new Set(list.map((repo) => repo.name.toLowerCase()));
    let name: string;
    if (typeof input.name === "string" && input.name.trim()) {
      name = cleanName(input.name);
      if (taken.has(name.toLowerCase())) throw new HttpError(409, `${project.name} has a repo called “${name}” already.`);
    } else {
      const base = repoNameFrom(source).slice(0, 37);
      name = base;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}`;
    }
    const now = Date.now();
    const position = list.length ? Math.max(...list.map((repo) => repo.position)) + 1 : 0;
    db.prepare(
      `INSERT INTO project_repos (project_id, name, kind, source, default_branch, folder_granted_at, position, checkout, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      projectId,
      name,
      kind,
      source,
      cleanBranch(input.defaultBranch),
      kind === "folder" && input.grant === true ? now : null,
      position,
      kind === "github" ? checkoutFor(project, list, name) : null,
      now,
    );
    // The first repo of a topic project becomes its primary.
    if (!list.length) mirror(projectId);
    return publish(projectId);
  },

  /**
   * PATCH /api/projects/:id/repos/:name: a new name (its tasks follow; its clone stays where it is), a base
   * branch, or primary: true (the old primary keeps its checkout too).
   */
  update(projectId: string, name: string, patch: UpdateProjectRepoRequest): Project {
    const project = requireProject(projectId);
    const repo = requireRepo(projectId, name);
    const others = projectRepos.list(projectId).filter((other) => other.name !== repo.name);
    let current = repo.name;
    if (patch?.name !== undefined) {
      const next = cleanName(patch.name);
      if (others.some((other) => other.name.toLowerCase() === next.toLowerCase())) {
        throw new HttpError(409, `${project.name} has a repo called “${next}” already.`);
      }
      if (next !== repo.name) {
        db.prepare(`UPDATE project_repos SET name = ? WHERE project_id = ? AND name = ?`).run(next, projectId, repo.name);
        // Its tasks show the new name; they find their repo by its folder, which doesn't change.
        const folder = projectRepos.folder(repo);
        const renamed = conversations.inProject(projectId).filter(isTask).filter((task) => task.task.repo?.folder === folder);
        const rename = db.prepare(`UPDATE conversations SET task = json_set(task, '$.repo.repoName', ?) WHERE id = ?`);
        for (const task of renamed) rename.run(next, task.id);
        for (const task of renamed) taskStore.publish(taskStore.get(task.id) ?? task);
        current = next;
      }
    }
    if (patch?.defaultBranch !== undefined) {
      db.prepare(`UPDATE project_repos SET default_branch = ? WHERE project_id = ? AND name = ?`).run(cleanBranch(patch.defaultBranch), projectId, current);
    }
    if (patch?.primary === true && !repo.primary) {
      const move = db.prepare(`UPDATE project_repos SET position = ? WHERE project_id = ? AND name = ?`);
      [current, ...others.map((other) => other.name)].forEach((each, index) => move.run(index, projectId, each));
    }
    if (repo.primary || patch?.primary === true) mirror(projectId);
    return publish(projectId);
  },

  /**
   * DELETE /api/projects/:id/repos/:name: refused while a task has work in it. Its clones and folder stay
   * where they are (a folder's grant goes); the next repo becomes the primary.
   */
  remove(projectId: string, name: string): Project {
    const project = requireProject(projectId);
    const repo = requireRepo(projectId, name);
    const busy = tasksWithWork(repo);
    if (busy.length) {
      const [first, ...rest] = busy;
      const others = rest.length ? ` and ${rest.length} more` : "";
      throw new HttpError(409, `“${first!.title}”${others} still ${busy.length === 1 ? "has" : "have"} work in ${repo.name}. Land or discard ${busy.length === 1 ? "it" : "them"} first.`);
    }
    db.prepare(`DELETE FROM project_repos WHERE project_id = ? AND name = ?`).run(project.id, repo.name);
    if (repo.primary) mirror(projectId);
    return publish(projectId);
  },

  /**
   * POST /api/projects/:id/repos/:name/grant: the user's yes for a folder repo (the consent dialog): agents
   * may read the folder, and tasks in this repo make tot/… branches and worktrees in its git repo.
   */
  grant(projectId: string, name: string): Project {
    requireProject(projectId);
    const repo = requireRepo(projectId, name);
    if (repo.kind !== "folder") throw new HttpError(400, "Only a folder on this Mac needs your OK.");
    if (cleanFolderSource(repo.source) !== repo.source) {
      throw new HttpError(400, `${tildePath(repo.source)} has moved or changed since it was added. Add it again.`);
    }
    db.prepare(`UPDATE project_repos SET folder_granted_at = ? WHERE project_id = ? AND name = ?`).run(Date.now(), projectId, repo.name);
    if (repo.primary) mirror(projectId);
    return publish(projectId);
  },
};
