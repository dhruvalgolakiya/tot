import type { Memory } from "../../shared/types.ts";
import { memories } from "../data/memories.ts";
import { projects } from "../projects/projects.ts";
import { ENTRY_FILE, parseEntries, projectRepoId, readFile, repoExists, YOU } from "./repo.ts";

/**
 * Memory in a new chat's prompt (roadmap module 10). The first turn of a chat or a task loads you/MEMORY.md (up
 * to 4000 characters), its project's MEMORY.md (up to 3000) and the entries from other files most related to
 * the first message (up to 2000), each entry with its id so the agent can fix or forget it, and says how and
 * where to remember more.
 */

export interface PromptMemory {
  /** you/MEMORY.md, ready for the prompt. */
  you: string;
  project: { name: string; repo: string; content: string } | null;
  /** Entries from the other files, most related to the first message first. */
  related: Memory[];
}

const YOU_BUDGET = 4000;
const PROJECT_BUDGET = 3000;
const RELATED_BUDGET = 2000;

/** A MEMORY.md for the prompt: each entry as "- text (id)", without the rest of its metadata. */
function forPrompt(repo: string, max: number): string {
  const content = repoExists(repo) ? readFile(repo, ENTRY_FILE) : null;
  if (!content?.trim()) return "";
  const lines = content.split("\n");
  for (const entry of parseEntries(ENTRY_FILE, content)) lines[entry.line] = `${entry.indent}- ${entry.text} (${entry.id})`;
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  return `${text.slice(0, cut > 0 ? cut : max).trimEnd()}\n… (more in the file: memory_read MEMORY.md)`;
}

export function promptMemory(projectId: string | null | undefined, firstMessage: string): PromptMemory {
  const project = projects.get(projectId);
  const projectRepo = project ? projectRepoId(project.slug) : null;
  const related: Memory[] = [];
  let used = 0;
  const hits = firstMessage.trim()
    ? memories.search(firstMessage, { repos: projectRepo ? [YOU, projectRepo] : [YOU], excludePaths: [ENTRY_FILE], limit: 20 })
    : [];
  for (const memory of hits) {
    if ((used += memory.content.length + 40) > RELATED_BUDGET) break;
    related.push(memory);
  }
  return {
    you: forPrompt(YOU, YOU_BUDGET),
    project: project && projectRepo ? { name: project.name, repo: projectRepo, content: forPrompt(projectRepo, PROJECT_BUDGET) } : null,
    related,
  };
}

export function memoryPromptSection(memory: PromptMemory | undefined): string {
  const project = memory?.project;
  const related = memory?.related ?? [];
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
${related.map((m) => `- ${m.content} (${m.id}) — ${m.repo}/${m.path}`).join("\n")}`
      : ""
  }`;
}
