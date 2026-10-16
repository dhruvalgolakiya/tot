import type { ChatWorkspace, Project } from "@tot/shared/types";
import { brains } from "../data/brains.ts";
import { wiki } from "../data/wiki.ts";
import { gitState } from "./folders.ts";
import { projects, tildePath } from "./projects.ts";
import { projectRepos, type RepoRecord } from "./repos.ts";

/**
 * What a chat or task in a project is told about it (module 06): one short section, always the same
 * shape, so every agent reads it the same way. It sits between `# Project: <name>` and the
 * <project></project> tags, which is how a frozen prompt's old section is found and replaced.
 * A chat in no project gets the list of projects instead (`# Projects`, <projects></projects>), so
 * its agent can file it. A project with several repos (module 11) lists them, one line each.
 */

const OVERVIEW_MAX = 4000;
const LIST_MAX = 20;
const SECTION = /# Project: [^\n]*\n<project>[\s\S]*?<\/project>/;
const LIST = /# Projects\n<projects>[\s\S]*?<\/projects>/;
/** Whichever of the two a frozen prompt has. */
const BLOCK = new RegExp(`${SECTION.source}|${LIST.source}`);

function where(project: Project): string {
  const folder = projects.folder(project);
  const branch = `base branch ${project.defaultBranch ?? "is the repo's default"}`;
  if (project.kind === "github") return `GitHub ${project.source} · ${branch} · files at ${folder}`;
  if (project.kind === "folder") return `Folder on the user's Mac, ${tildePath(project.source ?? "")} · ${branch}`;
  return `No code. Shared files at ${folder} (drafts, notes, exports); edit them freely.`;
}

/** One repo of a project with several (module 11): its name, what it is, its base branch and where its files are. */
function repoLine(repo: RepoRecord): string {
  const label = `- ${repo.name}${repo.primary ? " (primary)" : ""}`;
  const branch = `base branch ${repo.defaultBranch ?? "is the repo's default"}`;
  if (repo.kind === "github") return `${label}: GitHub ${repo.source} · ${branch} · files at ${projectRepos.folder(repo)}`;
  if (!repo.folderGranted) return `${label}: folder on the user's Mac, ${tildePath(repo.source)} · the user hasn't let agents into it yet (they can allow it on the project's page in TOT)`;
  const git = gitState(repo.source) === "repo" ? "" : " · not a git repo, so tasks can't start in it";
  return `${label}: folder on the user's Mac · ${branch} · files at ${repo.source}${git}`;
}

function reposWhere(repos: RepoRecord[]): string {
  return [`Repos (each task works in one; task_start's \`repo\` takes its name, the primary when left out):`, ...repos.map(repoLine)].join("\n");
}

function reposRule(repos: RepoRecord[], inTask: boolean): string {
  if (inTask) return "You're one task in this project: change files only in your own task folder (your worktree), never in the repos' folders themselves.";
  const folders = repos.some((repo) => repo.kind === "folder")
    ? " A folder on the user's Mac is at its full path (~ on your computer is your own home)."
    : "";
  return `Look in the repos' folders, but don't change them: start a task for any change, in the repo it's about; split work across repos into one task per repo.\nEach task gets its own branch (tot/…) and folder.${folders}`;
}

/**
 * For a chat that picked where it works (chats/workspace.ts): the main checkout of `folder` to change, or its own
 * worktree; other repos' folders stay read-only. Null for any other chat.
 */
function workspaceRule(workspace: ChatWorkspace | null | undefined, folder: string, others: boolean): string | null {
  if (!workspace) return null;
  const rest = others ? "\nThe project's other repos' folders are read-only for you: start a task to change them." : "";
  if (workspace.mode === "checkout") {
    return `You work directly in ${folder} (the user's main checkout): change files there when asked; small, careful changes; for big or parallel work start a task.\nYour commands start there.${rest}`;
  }
  if (!workspace.branch || !workspace.worktree) return `You'll work in your own worktree on a new tot/… branch, but it isn't made yet: don't change files in ${folder}.${rest}`;
  return `You work in your own worktree ${workspace.worktree} on branch ${workspace.branch}; change files only there; the main checkout (${folder}) is read-only.\nYour commands start there. Commit on your branch as you go; never push unless the user asks.${rest}`;
}

function rule(project: Project, inTask: boolean): string {
  if (project.kind === "none") return "";
  const folder = projects.folder(project) ?? "";
  if (inTask) return `You're one task in this project: change files only in your own task folder (your worktree), never in ${folder} itself.`;
  if (project.kind === "github") return `Look in ${folder}, but don't change it: start a task for any change.\nEach task gets its own branch (tot/…) and folder.`;
  // A folder on the user's Mac: on the agent's computer, ~ is its own home, so it gets the full path.
  if (!project.folderGranted) return "The user hasn't let agents into this folder yet, so you can't open it: ask them to allow it on the project's page in TOT.";
  const look = `Look in ${folder} (the full path: ~ on your computer is your own home), but don't change it`;
  if (gitState(folder) !== "repo") return `${look}. It isn't a git repo of its own, so tasks can't start in it.`;
  return `${look}: start a task for any change.\nEach task gets its own branch (tot/…), which shows up in the user's own repo, and its own folder.`;
}

export function projectSection(
  project: Project,
  { inTask = false, workspace = null }: { inTask?: boolean; workspace?: ChatWorkspace | null } = {},
): string {
  const brain = brains.get(project.brainId);
  const overview = brain ? wiki.overview(brain.id).content.trim() : "";
  const instructions = project.instructions.trim().replace(/\n{2,}/g, "\n");
  // Module 11: a project with several repos lists them (one repo reads as it did before).
  const repos = projectRepos.list(project.id);
  const several = repos.length > 1;
  // A chat's checkout or worktree is in the primary repo; a folder the user hasn't allowed yet reads as before.
  const primary = repos[0] && (repos[0].kind !== "folder" || repos[0].folderGranted) ? repos[0] : null;
  const lines = [
    several ? reposWhere(repos) : where(project),
    instructions && `Instructions: ${instructions}`,
    brain &&
      (overview
        ? `Brain: "${brain.name}" (its Overview is below; search it with wiki_search).`
        : `Brain: "${brain.name}", empty so far: when you learn something durable about this project, write it there (wiki_write).`),
    (!inTask && primary && workspaceRule(workspace, projectRepos.folder(primary), several)) ||
      (several ? reposRule(repos, inTask) : rule(project, inTask)),
    overview &&
      `Overview:\n${overview.length > OVERVIEW_MAX ? `${overview.slice(0, OVERVIEW_MAX).trimEnd()}\n… (truncated: wiki_read for the rest)` : overview}`,
  ].filter(Boolean);
  return `# Project: ${project.name}\n<project>\n${lines.join("\n")}\n</project>`;
}

function kindLine(project: Project): string {
  const repos = project.repos ?? [];
  if (repos.length > 1) return `${repos.length} repos: ${repos.map((repo) => repo.name).join(", ")}`;
  if (project.kind === "github") return `GitHub ${project.source}`;
  if (project.kind === "folder") return `folder ${tildePath(project.source ?? "")}`;
  return "topic, no files";
}

/** For a chat in no project: the user's projects, one line each, and when to file the chat; null when there are none. */
export function projectList(): string | null {
  const all = projects.list();
  if (!all.length) return null;
  const lines = all.slice(0, LIST_MAX).map((project) => `- ${project.name}: ${kindLine(project)}`);
  if (all.length > LIST_MAX) lines.push(`- … and ${all.length - LIST_MAX} more (chat_set_project takes any project's name)`);
  return `# Projects\n<projects>\nThis chat isn't in a project. The user's projects:\n${lines.join("\n")}\nIf this chat is clearly about one of these, file it with chat_set_project and say so; if it's unclear, ask.\n</projects>`;
}

/**
 * For a chat whose frozen prompt has another project block (moved in or out, or the project's details
 * changed): a one-time note for its next message, and the prompt to store instead. `block` is the
 * chat's project section, or for a chat in no project the project list (or null).
 */
export function projectNote(frozenPrompt: string | null, block: string | null): { note: string; prompt: string | null } {
  if (!frozenPrompt) return { note: "", prompt: null };
  const current = BLOCK.exec(frozenPrompt)?.[0] ?? null;
  if (current === block) return { note: "", prompt: null };
  const prompt = !current
    ? `${frozenPrompt}\n\n${block}`
    : block
      ? frozenPrompt.replace(current, () => block)
      : frozenPrompt.replace(current, "").replace(/\n{3,}/g, "\n\n");
  if (block && SECTION.test(block)) return { note: `[This chat is now in a project; this replaces any earlier project section:\n${block}]`, prompt };
  if (current && SECTION.test(current)) {
    // Only the user takes a chat out of a project: its agent shouldn't put it back on its own.
    return { note: "[This chat is no longer in a project: the user took it out, so don't file it again unless they ask. Ignore the earlier project section.]", prompt };
  }
  // Only the list of projects changed (one was added, renamed or archived): no need to say so.
  return { note: "", prompt };
}
