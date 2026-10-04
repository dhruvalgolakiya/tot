import type { Project } from "../../shared/types.ts";
import { brains } from "../data/brains.ts";
import { wiki } from "../data/wiki.ts";
import { projects, tildePath } from "./projects.ts";

/**
 * What a chat or task in a project is told about it (module 06): one short section, always the same
 * shape, so every agent reads it the same way. It sits between `# Project: <name>` and the
 * <project></project> tags, which is how a frozen prompt's old section is found and replaced.
 */

const OVERVIEW_MAX = 4000;
const SECTION = /# Project: [^\n]*\n<project>[\s\S]*?<\/project>/;

function where(project: Project): string {
  const folder = projects.folder(project);
  const branch = `base branch ${project.defaultBranch ?? "is the repo's default"}`;
  if (project.kind === "github") return `GitHub ${project.source} · ${branch} · files at ${folder}`;
  if (project.kind === "folder") return `Folder on the user's Mac, ${tildePath(project.source ?? "")} · ${branch}`;
  return "No code.";
}

function rule(project: Project, inTask: boolean): string {
  const folder = projects.folder(project);
  if (project.kind === "none") {
    return folder ? `Shared files at ${folder} (drafts, notes, exports); edit them freely.` : "";
  }
  const shown = project.kind === "folder" ? tildePath(folder ?? "") : folder;
  return inTask
    ? `You're one task in this project: change files only in your own task folder (your worktree), never in ${shown} itself.`
    : `Look in ${shown}, but don't change it: start a task for any change.\nEach task gets its own branch (tot/…) and folder.`;
}

export function projectSection(project: Project, { inTask = false }: { inTask?: boolean } = {}): string {
  const brain = brains.get(project.brainId);
  const overview = brain ? wiki.overview(brain.id).content.trim() : "";
  const instructions = project.instructions.trim().replace(/\n{2,}/g, "\n");
  const lines = [
    where(project),
    instructions && `Instructions: ${instructions}`,
    brain &&
      (overview
        ? `Brain: "${brain.name}" (its Overview is below; search it with wiki_search).`
        : `Brain: "${brain.name}", empty so far: when you learn something durable about this project, write it there (wiki_write).`),
    rule(project, inTask),
    overview &&
      `Overview:\n${overview.length > OVERVIEW_MAX ? `${overview.slice(0, OVERVIEW_MAX).trimEnd()}\n… (truncated: wiki_read for the rest)` : overview}`,
  ].filter(Boolean);
  return `# Project: ${project.name}\n<project>\n${lines.join("\n")}\n</project>`;
}

/**
 * For a chat whose frozen prompt has another project section (moved in or out, or the project's
 * details changed): a one-time note for its next message, and the prompt to store instead.
 */
export function projectNote(frozenPrompt: string | null, section: string | null): { note: string; prompt: string | null } {
  if (!frozenPrompt) return { note: "", prompt: null };
  const current = SECTION.exec(frozenPrompt)?.[0] ?? null;
  if (current === section) return { note: "", prompt: null };
  if (!section) {
    return {
      note: "[This chat is no longer in a project. Ignore the earlier project section.]",
      prompt: frozenPrompt.replace(SECTION, "").replace(/\n{3,}/g, "\n\n"),
    };
  }
  return {
    note: `[This chat is now in a project; this replaces any earlier project section:\n${section}]`,
    prompt: current ? frozenPrompt.replace(current, () => section) : `${frozenPrompt}\n\n${section}`,
  };
}
