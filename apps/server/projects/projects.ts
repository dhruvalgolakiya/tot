import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Brain, CreateProjectRequest, Project, ProjectIntake, ProjectKind, UpdateProjectRequest } from "@tot/shared/types";
import { HttpError } from "../agent/orchestrator.ts";
import { appEvents } from "../app-events.ts";
import { brains, BrainError, githubFullName } from "../data/brains.ts";
import { conversations, toPublicConversation } from "../data/conversations.ts";
import { db, parseJson, type Row } from "../db.ts";
import { subscriptionsOf } from "../signals/subscriptions.ts";
import { cleanCopyFiles, cleanSetupCommand } from "../worktrees/fields.ts";
import { FolderRefused, resolveFolder } from "./folders.ts";
import { projectRepos } from "./repos.ts";

export { tildePath } from "./folders.ts";

/**
 * Projects (roadmap module 06): what the user works on, shared by every agent. A project is a GitHub
 * repo, a folder on this Mac, or a topic with no files; it has a brain (its wiki) and standing
 * instructions. A chat is in one project or none, and its tasks and forks are in the same one.
 */

const KINDS: readonly ProjectKind[] = ["github", "folder", "none"];
const MAX_NAME = 60;
const MAX_INSTRUCTIONS = 4000;
const NO_INTAKE: ProjectIntake = { slackChannels: [], linearTeams: [] };

function toProject(row: Row): Project {
  const id = String(row.id);
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS chats,
              SUM(CASE WHEN kind = 'task' AND json_extract(task, '$.status') IN ('queued', 'running') THEN 1 ELSE 0 END) AS running
       FROM conversations WHERE project_id = ?`,
    )
    .get(id) as Row;
  return {
    id,
    name: String(row.name),
    slug: String(row.slug),
    kind: row.kind as ProjectKind,
    source: (row.source as string | null) ?? null,
    defaultBranch: (row.default_branch as string | null) ?? null,
    instructions: String(row.instructions ?? ""),
    brainId: String(row.brain_id),
    intake: { ...NO_INTAKE, ...parseJson<Partial<ProjectIntake>>(row.intake, {}) },
    folderGranted: row.folder_granted_at !== null && row.folder_granted_at !== undefined,
    archived: row.archived_at !== null && row.archived_at !== undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    chats: Number(counts.chats ?? 0),
    running: Number(counts.running ?? 0),
    // Module 11: its Lead chat, once made (apps/server/lead/).
    leadChatId: conversations.leadOf(id),
    // Module 09: what every new task worktree gets.
    setupCommand: (row.setup_command as string | null) ?? null,
    copyFiles: parseJson<string[]>(row.copy_files, []),
    // Module 11: its repos, the primary first (kind, source, defaultBranch and folderGranted above mirror it).
    repos: projectRepos.list(id).map(projectRepos.toPublic),
    // Module 12: what its Lead hears about on its own (apps/server/signals/).
    subscriptions: subscriptionsOf(row.subscriptions),
  };
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_NAME) : "";
  if (!name) throw new HttpError(400, "Give the project a name.");
  return name;
}

/** "Q4 launch!" → "q4-launch"; unique among all projects, archived ones included (their folders may still exist). */
function uniqueSlug(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "project";
  const taken = new Set(
    (db.prepare(`SELECT slug FROM projects`).all() as Row[]).map((row) => String(row.slug)),
  );
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

/** "acme/web", "https://github.com/acme/web.git" → "acme/web"; other git URLs stay as they are. */
export function cleanGitHubSource(value: unknown): string {
  const text = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  if (!text) throw new HttpError(400, "Pick a repo, or type owner/name.");
  if (text.length > 500 || /\s/.test(text)) throw new HttpError(400, "That doesn't look like a repo.");
  // Credentials belong in Settings → Connections, not in a URL that ends up in chats and the wiki.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(text)) throw new HttpError(400, "Leave the login out of the URL. Connect GitHub in Settings → Connections instead.");
  if (/^[\w.-]+\/[\w.-]+$/.test(text)) return text.replace(/\.git$/i, "");
  const fullName = githubFullName(text);
  if (fullName) return fullName;
  if (/^(https?:\/\/|git@|ssh:\/\/)/i.test(text)) return text;
  throw new HttpError(400, "Type the repo as owner/name, or paste its URL.");
}

/** "~/code/web" → its real absolute path, if it's a folder agents may be given (see folders.ts). */
export function cleanFolderSource(value: unknown): string {
  try {
    return resolveFolder(typeof value === "string" ? value : "");
  } catch (err) {
    if (err instanceof FolderRefused) throw new HttpError(400, err.message);
    throw err;
  }
}

/** The clone URL TOT's repo brains keep as their source (so Learn a repo finds the same brain). */
function brainSource(kind: ProjectKind, source: string | null): string | null {
  if (kind === "github" && source) return /^[\w.-]+\/[\w.-]+$/.test(source) ? `https://github.com/${source}` : source;
  return source;
}

/** The project's brain: the repo brain already learned from the same source, a free one by its name, or a new one. */
function brainFor(kind: ProjectKind, source: string | null, name: string): Brain {
  const brainKind = kind === "none" ? "notes" : "repo";
  const learned = kind !== "none" && source ? brains.forSource(brainSource(kind, source)!) : null;
  const claimed = new Set((db.prepare(`SELECT brain_id FROM projects`).all() as Row[]).map((row) => String(row.brain_id)));
  if (learned && !claimed.has(learned.id)) return learned.allAgents ? learned : brains.update(learned.id, { allAgents: true });

  const sameName = brains.list().find((brain) => !brain.ownerAgentId && brain.name.toLowerCase() === name.toLowerCase());
  if (sameName && !claimed.has(sameName.id) && sameName.kind === brainKind && (brainKind === "notes" || !sameName.source)) {
    return sameName.allAgents ? sameName : brains.update(sameName.id, { allAgents: true });
  }
  const description = kind === "none" ? `Notes for the ${name} project.` : `The ${name} project's code: how it works and where things are.`;
  for (let n = 1; ; n++) {
    try {
      return brains.create({ name: n === 1 ? name : `${name} ${n}`, kind: brainKind, source: brainSource(kind, source), description, allAgents: true });
    } catch (err) {
      if (!(err instanceof BrainError) || n > 20) throw err;
    }
  }
}

function publish(project: Project): Project {
  appEvents.publish({ type: "project", project });
  return project;
}

export const projects = {
  list({ archived = false }: { archived?: boolean } = {}): Project[] {
    const rows = db
      .prepare(`SELECT * FROM projects WHERE archived_at IS ${archived ? "NOT NULL" : "NULL"} ORDER BY name COLLATE NOCASE`)
      .all() as Row[];
    return rows.map(toProject);
  },

  get(id: string | null | undefined): Project | null {
    if (!id) return null;
    const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Row | undefined;
    return row ? toProject(row) : null;
  },

  /** By id, slug or (case-insensitive) name; archived projects aren't found. */
  resolve(ref: string): Project | null {
    const key = ref.trim().replace(/^#/, "").toLowerCase();
    if (!key) return null;
    return projects.list().find((p) => p.id === ref.trim() || p.slug === key || p.name.toLowerCase() === key) ?? null;
  },

  /** The project a chat or task is in. */
  forChat(conversationId: string): Project | null {
    return projects.get(conversations.get(conversationId)?.projectId);
  },

  create(input: CreateProjectRequest): Project {
    const kind = input.kind;
    if (!KINDS.includes(kind)) throw new HttpError(400, `A project is a GitHub repo, a folder, or neither ("${KINDS.join('", "')}").`);
    const source = kind === "github" ? cleanGitHubSource(input.source) : kind === "folder" ? cleanFolderSource(input.source) : null;
    if (source && projects.list().some((p) => p.kind === kind && p.source?.toLowerCase() === source.toLowerCase())) {
      throw new HttpError(409, "There's already a project for that.");
    }
    const fallback = source ? basename(source.replace(/\.git$/i, "")) : "";
    const name = cleanName(typeof input.name === "string" && input.name.trim() ? input.name : fallback);
    const brain = brainFor(kind, source, name);
    const id = randomUUID();
    const now = Date.now();
    // A folder on this Mac can be shared with agents right away, when the user said yes as they added it.
    const granted = kind === "folder" && input.grant === true ? now : null;
    db.prepare(
      `INSERT INTO projects (id, name, slug, kind, source, brain_id, folder_granted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, uniqueSlug(name), kind, source, brain.id, granted, now, now);
    // Module 11: its repo or folder is its primary repo (in ~/projects/<slug>, or the folder itself).
    projectRepos.list(id);
    appEvents.publish({ type: "brains", brains: brains.list() });
    return publish(projects.get(id)!);
  },

  update(id: string, patch: UpdateProjectRequest): Project {
    const project = projects.get(id);
    if (!project) throw new HttpError(404, "Project not found.");
    const name = patch.name === undefined ? project.name : cleanName(patch.name);
    const instructions =
      patch.instructions === undefined ? project.instructions : String(patch.instructions).trim().slice(0, MAX_INSTRUCTIONS);
    const branch =
      patch.defaultBranch === undefined ? project.defaultBranch : (patch.defaultBranch ?? "").trim() || null;
    if (branch && !/^[\w./-]+$/.test(branch)) throw new HttpError(400, "That isn't a branch name.");
    const intake = patch.intake ? { ...project.intake, ...cleanIntake(patch.intake) } : project.intake;
    const setupCommand = patch.setupCommand === undefined ? (project.setupCommand ?? null) : cleanSetupCommand(patch.setupCommand);
    const copyFiles = patch.copyFiles === undefined ? (project.copyFiles ?? []) : cleanCopyFiles(patch.copyFiles);
    if (patch.copyFiles !== undefined && copyFiles.length && project.kind !== "folder") {
      throw new HttpError(400, "Only a folder project on this Mac has files to copy into its worktrees.");
    }
    // The slug stays as it was: it names the project's folder on every agent's computer.
    db.prepare(
      `UPDATE projects SET name = ?, instructions = ?, default_branch = ?, intake = ?, setup_command = ?, copy_files = ?, updated_at = ? WHERE id = ?`,
    ).run(name, instructions, branch, JSON.stringify(intake), setupCommand, JSON.stringify(copyFiles), Date.now(), id);
    // Module 11: the project's base branch is its primary repo's.
    const primary = projectRepos.primary(id);
    if (patch.defaultBranch !== undefined && primary) {
      db.prepare(`UPDATE project_repos SET default_branch = ? WHERE project_id = ? AND name = ?`).run(branch, id, primary.name);
    }
    return publish(projects.get(id)!);
  },

  /**
   * The user's yes for a folder project: agents may read the folder, and tasks make tot/… branches
   * and worktrees in its git repo. Asked once; the folder is checked again before every command.
   */
  grant(id: string): Project {
    const project = projects.get(id);
    if (!project) throw new HttpError(404, "Project not found.");
    if (project.kind !== "folder" || !project.source) throw new HttpError(400, "Only a folder on this Mac needs your OK.");
    if (project.archived) throw new HttpError(400, "This project is archived.");
    if (cleanFolderSource(project.source) !== project.source) {
      throw new HttpError(400, "That folder has moved or changed since the project was made. Add it again as a new project.");
    }
    // Module 11: the grant is its primary repo's (the project's mirrors it).
    return projectRepos.grant(id, projectRepos.primary(id)!.name);
  },

  /** Hides the project; its chats stay filed under it, and its brain stays. */
  archive(id: string): Project {
    if (!projects.get(id)) throw new HttpError(404, "Project not found.");
    db.prepare(`UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?`).run(Date.now(), Date.now(), id);
    return publish(projects.get(id)!);
  },

  /**
   * Files a chat (and its tasks) into a project, or takes it out with null. The chat's next turn hears
   * about it (see projectNote), and new wiki pages go to the project's brain.
   */
  moveChat(conversationId: string, projectId: string | null): void {
    const chat = conversations.get(conversationId);
    if (!chat) throw new HttpError(404, "Chat not found.");
    // Module 11: a project's Lead runs that project; it isn't filed elsewhere.
    if (chat.lead) throw new HttpError(400, "The Lead stays in its project.");
    // A chat working in its project's checkout or its own worktree there can't take that elsewhere.
    if (chat.workspace && projectId !== chat.projectId) throw new HttpError(400, "This chat works in its project's files, so it stays in the project.");
    const project = projectId ? projects.get(projectId) : null;
    if (projectId && (!project || project.archived)) throw new HttpError(404, "Project not found.");
    const family = [chat, ...conversations.tasks({ parentId: chat.id })];
    for (const member of family) {
      const updated = conversations.update(member.id, { projectId: project?.id ?? null });
      if (project && brains.focus(member.id) === null) brains.setFocus(member.id, project.brainId);
      if (updated) appEvents.publish({ type: "conversation", conversation: toPublicConversation(updated) });
    }
    if (project) publish(projects.get(project.id)!);
    const before = projects.get(chat.projectId);
    if (before && before.id !== project?.id) publish(before);
    appEvents.agentChanged(chat.agentId);
  },

  /**
   * What a task in this project works on when it touches code: the repo to clone, the folder on
   * this Mac once the user allowed it, or null (no code here, or not allowed yet).
   */
  taskSource(project: Project): string | null {
    if (project.kind === "github") return project.source;
    return project.kind === "folder" && project.folderGranted ? project.source : null;
  },

  /** What Learn a repo studies for this project (the same source its brain was made from), or null. */
  learnSource(project: Project): string | null {
    if (project.kind === "github") return brainSource("github", project.source);
    return project.kind === "folder" && project.folderGranted ? project.source : null;
  },

  /**
   * Where the project's files are on an agent's computer: ~/projects/<slug> for GitHub and topic
   * projects (see checkout.ts), and the folder's own path for a folder on this Mac. With several
   * repos (module 11), its primary repo's.
   */
  folder(project: Project): string | null {
    const primary = projectRepos.primary(project.id);
    if (primary) return projectRepos.folder(primary);
    if (project.kind === "folder") return project.source;
    return `~/projects/${project.slug}`;
  },

  /** The project whose brain this is (archived ones too), or null. */
  forBrain(brainId: string): Project | null {
    const row = db.prepare(`SELECT * FROM projects WHERE brain_id = ?`).get(brainId) as Row | undefined;
    return row ? toProject(row) : null;
  },
};

function cleanIntake(value: Partial<ProjectIntake>): Partial<ProjectIntake> {
  const list = (items: unknown, clean: (item: string) => string) =>
    Array.isArray(items) ? [...new Set(items.map((item) => clean(String(item))).filter(Boolean))].slice(0, 20) : undefined;
  const out: Partial<ProjectIntake> = {};
  const channels = list(value.slackChannels, (item) => {
    const name = item.trim().replace(/^#/, "").toLowerCase();
    return /^[a-z0-9_-]{1,80}$/.test(name) ? `#${name}` : "";
  });
  const teams = list(value.linearTeams, (item) => {
    const key = item.trim().toUpperCase();
    return /^[A-Z][A-Z0-9]{0,9}$/.test(key) ? key : "";
  });
  if (channels) out.slackChannels = channels;
  if (teams) out.linearTeams = teams;
  return out;
}

/** Repo brains learned before projects existed become GitHub projects, once (startup; idempotent). */
export function migrateRepoBrains(): void {
  const claimed = new Set((db.prepare(`SELECT brain_id FROM projects`).all() as Row[]).map((row) => String(row.brain_id)));
  for (const brain of brains.list()) {
    if (brain.kind !== "repo" || !brain.source || claimed.has(brain.id)) continue;
    const fullName = githubFullName(brain.source);
    const source = fullName ?? (/^(https?:\/\/|git@|ssh:\/\/)/i.test(brain.source) ? brain.source : null);
    if (!source) continue; // a folder on an agent's computer: no project to make
    const now = Date.now();
    db.prepare(
      `INSERT INTO projects (id, name, slug, kind, source, brain_id, created_at, updated_at) VALUES (?, ?, ?, 'github', ?, ?, ?, ?)`,
    ).run(randomUUID(), brain.name.slice(0, MAX_NAME), uniqueSlug(brain.name), source, brain.id, now, now);
    if (!brain.allAgents) brains.update(brain.id, { allAgents: true });
  }
}
