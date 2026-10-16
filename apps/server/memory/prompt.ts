import type { Memory } from "@tot/shared/types";
import { memories } from "../data/memories.ts";
import { projects } from "../projects/projects.ts";
import { hideSecrets } from "../trust/secrets.ts";
import { importDone, legacyMemories } from "./legacy.ts";
import { assignKeys, ENTRY_FILE, parseEntries, projectRepoId, promptView, readFile, repoExists, YOU } from "./repo.ts";

/**
 * Memory in a new chat's prompt (roadmap module 10). The first turn of a chat or a task loads you/MEMORY.md (up
 * to 4000 characters) and its project's MEMORY.md (up to 3000), then entries from the other files: those most
 * related to the first message, then the newest, in 2000 characters plus whatever the MEMORY.md files left
 * unused. Each entry has its id so the agent can fix or forget it. Everything is scrubbed of what looks like a
 * secret: lines written by hand or synced in from another device were never checked. Until the one-time import
 * lands, the old memories stand in for you/MEMORY.md, read-only.
 */

export interface PromptMemory {
  /** you/MEMORY.md, ready for the prompt. */
  you: string;
  project: { name: string; repo: string; content: string } | null;
  /** Entries from the other files, most related to the first message first. */
  related: Memory[];
  /** Then the newest entries from the other files, as far as room allows. */
  recent: Memory[];
}

const YOU_BUDGET = 4000;
const PROJECT_BUDGET = 3000;
const OTHER_BUDGET = 2000;

function clipAt(text: string, max: number, more: string): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  return `${text.slice(0, cut > 0 ? cut : max).trimEnd()}\n${more}`;
}

/** A MEMORY.md for the prompt: each entry as "- text (id)", without the rest of its metadata. */
function forPrompt(repo: string, max: number): string {
  const content = repoExists(repo) ? readFile(repo, ENTRY_FILE) : null;
  if (!content?.trim()) return "";
  // MEMORY.md comes first in a repo, so its keys are its own.
  return clipAt(hideSecrets(promptView(content, assignKeys(parseEntries(ENTRY_FILE, content)))), max, "… (more in the file: memory_read MEMORY.md)");
}

/** The memories from before the repo while their import hasn't landed: newest first, without ids (read-only). */
function legacyForPrompt(max: number): string {
  const lines = legacyMemories().map((memory) => hideSecrets(`- ${memory.content}`));
  if (!lines.length) return "";
  return clipAt(`(Saved before memory became a repo; read-only until they're imported, newest first.)\n${lines.join("\n")}`, max, "… (and older ones)");
}

/** An entry from another file, as the prompt lists it. */
const otherLine = (memory: Memory) => hideSecrets(`- ${memory.content} (${memory.id}) — ${memory.repo}/${memory.path}`);

export function promptMemory(projectId: string | null | undefined, firstMessage: string): PromptMemory {
  const project = projects.get(projectId);
  const projectRepo = project ? projectRepoId(project.slug) : null;
  const imported = importDone();
  const you = imported ? forPrompt(YOU, YOU_BUDGET) : legacyForPrompt(YOU_BUDGET);
  const projectContent = projectRepo ? forPrompt(projectRepo, PROJECT_BUDGET) : "";
  let room = OTHER_BUDGET + (YOU_BUDGET - you.length) + (projectRepo ? PROJECT_BUDGET - projectContent.length : 0);
  const repos = [...(imported ? [YOU] : []), ...(projectRepo ? [projectRepo] : [])];
  const taken = new Set<string>();
  const take = (list: Memory[], memory: Memory) => {
    const cost = otherLine(memory).length + 1;
    if (cost > room) return false;
    room -= cost;
    list.push(memory);
    taken.add(`${memory.repo}/${memory.id}`);
    return true;
  };
  const related: Memory[] = [];
  const recent: Memory[] = [];
  if (repos.length && firstMessage.trim()) {
    for (const memory of memories.search(firstMessage, { repos, excludePaths: [ENTRY_FILE], limit: 20 })) if (!take(related, memory)) break;
  }
  if (repos.length) {
    for (const memory of memories.recent({ repos, excludePaths: [ENTRY_FILE], limit: 200 })) {
      if (!taken.has(`${memory.repo}/${memory.id}`) && !take(recent, memory)) break;
    }
  }
  return {
    you,
    project: project && projectRepo ? { name: project.name, repo: projectRepo, content: projectContent } : null,
    related,
    recent,
  };
}

export function memoryPromptSection(memory: PromptMemory | undefined): string {
  const project = memory?.project;
  const related = memory?.related ?? [];
  const recent = memory?.recent ?? [];
  return `# Memory
You have long-term memory: git repos of short markdown entries, one fact per line, shared by all of the user's agents (and their other devices). It lasts across chats.
- About the user (memory_save with scope "you", the default): durable preferences, facts about them or their goals, and anything they ask you to remember about them. One short sentence each (e.g. "Prefers TypeScript over Python").${
    project
      ? `
- About this project, ${project.name} (scope "project"): what the next chat or task here should know about the code and the work — how to build, test and deploy, conventions, gotchas (e.g. "Tests need TZ=UTC"). Every chat and task in the project reads it.`
      : ""
  }
- MEMORY.md is loaded below; other files hold more. memory_search finds entries, memory_read reads a file or follows a [[link]], memory_update fixes an entry that's out of date, memory_delete forgets one (each entry's id is in parentheses) — do it whenever the user asks you to forget something. Pass \`file\` to memory_save to keep a topic in its own file (e.g. "people.md").
- Don't save secrets or one-off details. Use what you know naturally; don't recite it. Long documents (how a system works, decisions, runbooks) belong in the wiki, not memory.
- When the user asks you to remember something, or to put something in the wiki, do exactly that right away: don't debate where it belongs, pick the place yourself, and say in a few words where it went.

## About the user (you/MEMORY.md)
${memory?.you || "(nothing yet)"}${
    project
      ? `

## ${project.name} (${project.repo}/MEMORY.md)
${project.content || "(nothing yet)"}`
      : ""
  }${
    related.length
      ? `

## Related entries from other files
${related.map(otherLine).join("\n")}`
      : ""
  }${
    recent.length
      ? `

## Recent entries from other files
${recent.map(otherLine).join("\n")}`
      : ""
  }`;
}
