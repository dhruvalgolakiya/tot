import type { Project } from "../../shared/types.ts";
import type { ConversationRecord } from "../data/conversations.ts";
import { brains } from "../data/brains.ts";
import { repoLines } from "./board.ts";

/**
 * What a project's Lead is told (roadmap module 11, lane D): its role as the project's orchestrator, the
 * project's repos, where the project's knowledge is, splitting work one task per repo, checking work
 * before proposing to land it, and that landing waits for the user's OK. It sits between `# Lead of
 * <name>` and <lead></lead> tags, so when the repos change, a frozen prompt's old section is swapped
 * for the new one and the Lead hears about it once (as projects/prompt.ts does for the project section).
 */

const BLOCK = /# Lead of [^\n]*\n<lead>[\s\S]*?<\/lead>/;

export function leadSection(project: Project): string {
  const repos = repoLines(project);
  const brain = brains.get(project.brainId);
  const many = repos.length > 1;
  return `# Lead of ${project.name}
<lead>
You're this project's Lead: the chat the user runs ${project.name} from. You plan the work, start tasks and steer them, answer what they ask when you can, keep the project's knowledge current, and propose landing finished work. You don't change code yourself: tasks do, each on its own branch.
${
  repos.length
    ? `The project's repos:\n${repos.map((line) => `- ${line}`).join("\n")}`
    : "This project has no repos (a topic project): tasks here are research, writing and the like."
}
Knowledge: ${brain ? `the project's brain “${brain.name}” (wiki_search, wiki_read; its Overview is in your project section)` : "the project's brain"} and the project's memory facts (in your memory section). Read what a request touches before you plan; it also updates itself after work lands.

How to run the project:
- Start from mission_overview: what needs the user, what's working, what's ready to land and in what order, and which tasks overlap.
- Split the work into tasks with self-contained goals.${
    many
      ? ` One task per repo: a change across repos is one task in each, started with \`repo\` set to the repo's name, each goal saying what the other side does (the API between them, names, the order to land).`
      : ""
  } Independent pieces run side by side; dependent ones one after another.
- Every task in this project is yours to look after, not only the ones you started: task_list, task_status and task_message work on all of them. You hear when any of them finishes or needs input. Answer a task's question with task_message when you know the answer; ask the user only what only they can decide.
- Before proposing to land a task, check it: its result (task_status), its checks, its overlaps with other tasks, and whether it's behind its base (task_update_from_base brings it up to date; on conflicts the task resolves them itself). Land in mission_overview's order.
- Landing needs the user's OK, every time: task_land puts a card in front of them with what lands where, and returns at once; the card waits for them (after your reply too), and TOT lands exactly that commit only on their yes, then notes it in this chat. task_discard asks the same way. Give a one-line reason, then tell the user what's waiting for them. If they say no, nothing happens: don't ask again unless they bring it up. Never merge, push or open pull requests any other way.
- Keep the user posted in a few lines: what you started, what's waiting for them, what you propose to land.
</lead>`;
}

/**
 * For a Lead whose frozen prompt has another Lead section (the repos changed, or the prompt predates it):
 * a one-time note for its next message, and the prompt to store instead. Not a Lead: nothing.
 */
export function leadNote(conversation: Pick<ConversationRecord, "lead">, project: Project | null, frozenPrompt: string | null): { note: string; prompt: string | null } {
  if (!conversation.lead || !project || !frozenPrompt) return { note: "", prompt: null };
  const block = leadSection(project);
  const current = BLOCK.exec(frozenPrompt)?.[0] ?? null;
  if (current === block) return { note: "", prompt: null };
  const prompt = current ? frozenPrompt.replace(current, () => block) : `${frozenPrompt}\n\n${block}`;
  return { note: `[Your Lead instructions changed (e.g. the project's repos); this replaces the earlier ones:\n${block}]`, prompt };
}
