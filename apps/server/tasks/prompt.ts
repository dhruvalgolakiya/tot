import type { HandoffPacket, TaskInfo } from "@tot/shared/types";
import { conversations, type ConversationRecord } from "../data/conversations.ts";
import { ROLES } from "../orchestration/roles.ts";
import { signalsNote } from "../signals/note.ts";
import { leadSignals } from "../signals/store.ts";
import { worktreeNotes } from "../worktrees/prompt.ts";

/** Tasks can start tasks this many levels below the user's chat. */
export const MAX_DEPTH = 2;

/**
 * Where a task keeps its own plan: a markdown file in the agent's home folder on its computer, outside every repo,
 * so it's never committed. The agent writes and ticks it; TOT shows it on the task's Plan tab (GET /tasks/:id/plan).
 */
export const planPath = (taskId: string) => `~/tot-tasks/${taskId}/PLAN.md`;

/** What the agent is told about tasks: in a chat (it can start them) and inside one (how to work). */

export const TASK_SECTION_TITLE = "# Your task";

/** For chats: when to hand work to a task instead of doing it inline. */
export function chatTasksSection(): string {
  return `# Tasks
For real work that takes more than a few minutes — a change to a codebase, research across several sources, a report or comparison — start a task with task_start instead of doing it here. A task runs in the background on your computer (a coding task on its own git branch and worktree), shows in this chat as a live card, and reports its result back here when it finishes; the user can close the tab meanwhile. Start several at once for independent pieces of work (say, one per vendor to research). Keep quick questions and small edits inline.
- Give each task a short title and a goal that stands on its own: the task doesn't see this chat, so include what it needs to know and what "done" means.
- For code, pass \`repo\` (GitHub "owner/name", a git URL, or a folder on your computer such as ~/repos/web).
- After starting tasks, tell the user in a sentence what you started; don't wait for them: when they finish, you get their results here and a turn to tell the user. For a quick one whose result you need for this answer, pass \`wait: true\` and get it in the same call. task_list and task_status show how they're doing; task_message adds an instruction to a running one.
- When the user follows up about a task that's still running ("also check mobile", "use the staging database"), pass it on with task_message rather than starting the work again here.
- You decide when work needs a task; the user doesn't switch modes for it. In a project, your project section says where you may change code: a chat working in the main checkout or its own worktree makes small changes there itself; otherwise the project's folders are read-only in a chat, and any change to code goes in a task.
- For work big enough to need a plan before you split it up, write the plan as a markdown file in your home folder (e.g. ~/plans/<topic>.md), keep it current, and give each task the plan file's path in its \`context\`. Each task also keeps its own plan.
${FAN_OUT}`;
}

/** When to split work across several sessions, and when not to (module 02). */
const FAN_OUT = `When to fan out with task_spawn_many: independent sub-questions (one researcher per vendor), a search across many files or sources, or work bigger than one sitting. Give each session a role — explorer (where/how, fast), planner, implementer (makes the change), tester, reviewer (runs on the other provider), researcher, writer — and pass then: "synthesize" to get one turn here with all their results to combine. Don't fan out for small or sequential work, or while the user is mid-conversation with you; at most 6 tasks per chat.`;

/** Inside a task: its goal, role, where to work, and how to report. */
export function taskSection(task: Pick<TaskInfo, "goal" | "repo" | "role" | "depth" | "ports" | "setup">, taskId: string): string {
  const { repo, role } = task;
  const plan = planPath(taskId);
  const code = repo
    ? `
Repository: ${repo.source}, on your computer at ${repo.folder}.
Your branch: ${repo.branch}${repo.baseBranch ? ` (from ${repo.baseBranch})` : ""}, checked out in its own git worktree: ${repo.worktree}
- That worktree is your working directory: computer_exec starts there unless you pass a \`cwd\` (relative to your home folder), and relative paths in computer_read_file / computer_write_file resolve there. Keep every change inside it.
- Other tasks may be working on the same repo at the same time, each in its own worktree. Never touch other worktrees, the main checkout in ${repo.folder}, or the base branch.
- Commit your work on your branch in small steps with clear messages. Never push or open pull requests: TOT handles that separately.
${worktreeNotes(task)}`
    : "";
  return `${TASK_SECTION_TITLE}
You're working on a task. It runs in the background: work through it on your own until it's done. TOT keeps sending you turns while you make progress, and the user may read along and add notes.
Goal: ${task.goal}${role ? `\nYour role: ${ROLES[role].label.toLowerCase()}. ${ROLES[role].instructions}` : ""}${code}

How to work:
- Keep your own plan in ${plan} (create the folder): for anything beyond a couple of steps, write it first as a markdown checklist, tick steps (- [x]) as you finish them, and add what you learn that the rest of the work needs. It's outside the repo, so it's never committed, and it carries over if your session is restarted. The user reads it on the task's Plan tab.
- Set \`progress\` with task_update to one line about what you're doing now, whenever that changes.
- Work end to end without asking. Only if you truly can't continue without the user (a decision only they can make, access you don't have), call task_update with a \`question\`, say it in your reply, and end your turn.
- When the goal is met, or turns out impossible, call task_finish with outcome "done" or "failed" and a summary for whoever asked: what you did, the result, and where to find it (files, branch, links, sources). That summary is your report, so make it complete. Also fill in \`findings\`, \`files_changed\`, \`open_questions\`, \`sources\` and \`confidence\` where they apply: whoever asked gets them as a structured result.
- At natural checkpoints in long work, call handoff_write with where things stand, so another session could carry on from it.${
    task.depth < MAX_DEPTH
      ? `\n- You can split off sessions of your own with task_start or task_spawn_many (a task can't go deeper than ${MAX_DEPTH} levels). Their results come to your next turn; TOT waits for them before continuing you.\n${FAN_OUT}`
      : ""
  }`;
}

/** A checklist from before tasks kept their plan in a file (tasks still running across the upgrade). */
const checklist = (plan: TaskInfo["plan"]) => plan.map((step) => `- [${step.done ? "x" : " "}] ${step.text}`).join("\n");

const clipped = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

/** The instructions on a turn TOT sends to keep a task going. */
export function continuationPreamble(
  task: TaskInfo,
  taskId: string,
  opts: { turn: number; notes: string[]; restarted: boolean; fresh: boolean; lastReply: string; firstTurnOfConvertedChat?: boolean; handedOff?: boolean },
): string {
  const lines: string[] = [];
  if (opts.firstTurnOfConvertedChat) {
    lines.push(`[This chat is now a task. Work on it on your own until it's done, following the task instructions in your system prompt. Goal: ${task.goal}`);
  } else {
    lines.push(`[TOT is keeping this task going (turn ${opts.turn}). You haven't called task_finish yet.`);
  }
  if (opts.restarted) lines.push("TOT restarted while you were working, so your last turn was cut off. Check where things stand (your worktree, files, running processes) before you carry on.");
  if (opts.fresh) {
    lines.push(
      `You're continuing in a fresh session because the conversation got long. Goal: ${task.goal}${
        task.repo ? `\nWork in your worktree ${task.repo.worktree} on branch ${task.repo.branch}.` : ""
      }${opts.lastReply ? `\nWhere you left off (your last reply):\n<last_reply>\n${clipped(opts.lastReply, 4000)}\n</last_reply>` : ""}`,
    );
  }
  for (const note of opts.notes) lines.push(`The user added while you worked: “${note}” — take it into account from now on.`);
  lines.push(`Your plan: ${planPath(taskId)}${opts.fresh || opts.restarted || opts.handedOff ? " (read it first)" : ""}.`);
  if (task.plan.length) lines.push(`Your checklist from before:\n${checklist(task.plan)}`);
  if (task.progress) lines.push(`Latest progress: ${task.progress}`);
  lines.push("Carry on with the next unchecked step, and tick it in the plan when it's done. When the goal is met, call task_finish with your report; if you can't continue without the user, call task_update with a question.]");
  return lines.join("\n");
}

/** One finished task's result as structured data for a model: its summary plus findings, files and sources. */
export function resultBlock(child: ConversationRecord): string {
  const task = child.task!;
  // Stopped, or cut off by a restart: how it ended, and no result.
  if (task.status === "stopped" || task.status === "interrupted") {
    const note = task.status === "stopped" ? "Stopped before it finished: there's no result." : "Cut off when TOT restarted; it waits for the user to resume it. No result yet.";
    return JSON.stringify({ id: child.id, title: child.title, role: task.role, status: task.status, note, ...(task.repo ? { branch: task.repo.branch } : {}) }, null, 1);
  }
  // Waiting for input (a project's Lead hears about these too, module 11): what it asks, no result yet.
  if (task.status === "needs-input") {
    const note = task.question
      ? `It asks: ${clipped(task.question, 2000)}`
      : "It's waiting for the user's OK on a card in the task; only the user can answer that.";
    return JSON.stringify({ id: child.id, title: child.title, role: task.role, status: task.status, note, ...(task.repo ? { branch: task.repo.branch } : {}) }, null, 1);
  }
  const result = task.result;
  return JSON.stringify(
    {
      id: child.id,
      title: child.title,
      role: task.role,
      status: task.status,
      summary: clipped(result?.summary ?? task.summary ?? "(no summary)", 8000),
      ...(result
        ? { findings: result.findings, filesChanged: result.filesChanged, openQuestions: result.openQuestions, sources: result.sources, confidence: result.confidence }
        : {}),
      ...(task.repo ? { branch: task.repo.branch } : {}),
    },
    null,
    1,
  );
}

/** Finished tasks' results as a note for a model, opening with `heading`; "" when none of them is a task anymore. */
export function resultsNote(ids: string[], heading = "Tasks you started have finished."): string {
  const blocks: string[] = [];
  for (const id of ids) {
    const child = conversations.get(id);
    if (child?.kind !== "task" || !child.task) continue;
    blocks.push(resultBlock(child));
  }
  return blocks.length
    ? `[${heading} Their results:\n<task_results>\n${blocks.join("\n")}\n</task_results>\nUse them where they matter; the user can see each one on its card.]`
    : "";
}

/** Marks results as heard by the conversation's model (its next turn, a wake-up, or task_status). */
export function markResultsRead(conversationId: string, ids: string[]): void {
  const current = conversations.get(conversationId);
  if (!current || !ids.length) return;
  const unread = current.childResults.filter((id) => !ids.includes(id));
  if (unread.length !== current.childResults.length) conversations.update(conversationId, { childResults: unread });
}

/** A project's Lead (module 11) hears about every task in its project, not only those it started, and also when one needs input. */
export const LEAD_NEWS = "Tasks in this project have news: finished, or waiting for input.";

/**
 * Results of a chat's tasks that finished since its model last heard, as a note for its next turn; "" when none.
 * A project's Lead also gets its unread signals (module 12), which are then read.
 */
export function childResultsNote(conversation: Pick<ConversationRecord, "id" | "childResults" | "lead" | "projectId">, heard?: string[]): string {
  const signals = conversation.lead && conversation.projectId ? leadSignals.unread(conversation.projectId) : [];
  leadSignals.markRead(signals.map((signal) => signal.id));
  // The caller puts them back if the turn doesn't get through (agent/orchestrator.ts executeTurn).
  heard?.push(...signals.map((signal) => signal.id));
  if (!conversation.childResults.length) return signalsNote(signals);
  markResultsRead(conversation.id, conversation.childResults);
  const results = resultsNote(conversation.childResults, conversation.lead ? "Tasks in this project have news since your last reply: finished, or waiting for input." : "Tasks you started have finished since your last reply.");
  return [results, signalsNote(signals)].filter(Boolean).join("\n\n");
}

/** The opening of a fresh session that carries on from a handoff packet instead of the transcript, with the last exchange verbatim. */
export function handoffPreamble(packet: HandoffPacket, why: string, exchange = ""): string {
  return `[${why} You're continuing this task from a handoff packet written by ${packet.from.provider} (${packet.from.model}); you don't have the earlier conversation. Trust the packet, check the current state where it matters (your worktree, files), and carry on from its next step.
<handoff>
${JSON.stringify(packet, null, 1)}
</handoff>${exchange ? `\nThe last message from the user and the last reply before the handoff, verbatim:\n<last_exchange>\n${exchange}\n</last_exchange>` : ""}]`;
}
