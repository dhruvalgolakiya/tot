import type { TaskInfo } from "../../shared/types.ts";
import { conversations, type ConversationRecord } from "../data/conversations.ts";

/** What the agent is told about tasks: in a chat (it can start them) and inside one (how to work). */

export const TASK_SECTION_TITLE = "# Your task";

/** For chats: when to hand work to a task instead of doing it inline. */
export function chatTasksSection(): string {
  return `# Tasks
For real work that takes more than a few minutes — a change to a codebase, research across several sources, a report or comparison — start a task with task_start instead of doing it here. A task runs in the background on your computer (a coding task on its own git branch and worktree), shows in this chat as a live card, and reports its result back here when it finishes; the user can close the tab meanwhile. Start several at once for independent pieces of work (say, one per vendor to research). Keep quick questions and small edits inline.
- Give each task a short title and a goal that stands on its own: the task doesn't see this chat, so include what it needs to know and what "done" means.
- For code, pass \`repo\` (GitHub "owner/name", a git URL, or a folder on your computer such as ~/repos/web).
- After starting tasks, tell the user in a sentence what you started; don't wait for them. task_list and task_status show how they're doing; task_message adds an instruction to a running one.`;
}

/** Inside a task: its goal, where to work, and how to report. */
export function taskSection(task: Pick<TaskInfo, "goal" | "repo">): string {
  const { repo } = task;
  const code = repo
    ? `
Repository: ${repo.source}, on your computer at ${repo.folder}.
Your branch: ${repo.branch}${repo.baseBranch ? ` (from ${repo.baseBranch})` : ""}, checked out in its own git worktree: ${repo.worktree}
- That worktree is your working directory: computer_exec starts there unless you pass a \`cwd\` (relative to your home folder), and relative paths in computer_read_file / computer_write_file resolve there. Keep every change inside it.
- Other tasks may be working on the same repo at the same time, each in its own worktree. Never touch other worktrees, the main checkout in ${repo.folder}, or the base branch.
- Commit your work on your branch in small steps with clear messages. Never push or open pull requests: TOT handles that separately.`
    : "";
  return `${TASK_SECTION_TITLE}
You're working on a task. It runs in the background: work through it on your own until it's done. TOT keeps sending you turns while you make progress, and the user may read along and add notes.
Goal: ${task.goal}${code}

How to work:
- First write a short plan with task_update({ plan }): 3 to 8 concrete steps. Keep it current — tick steps as you finish them, and set \`progress\` to one line about what you're doing now.
- Work end to end without asking. Only if you truly can't continue without the user (a decision only they can make, access you don't have), call task_update with a \`question\`, say it in your reply, and end your turn.
- When the goal is met, or turns out impossible, call task_finish with outcome "done" or "failed" and a summary for whoever asked: what you did, the result, and where to find it (files, branch, links, sources). That summary is your report, so make it complete.`;
}

const checklist = (plan: TaskInfo["plan"]) => (plan.length ? plan.map((step) => `- [${step.done ? "x" : " "}] ${step.text}`).join("\n") : "(no plan yet — write one with task_update)");

const clipped = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

/** The instructions on a turn TOT sends to keep a task going. */
export function continuationPreamble(
  task: TaskInfo,
  opts: { turn: number; notes: string[]; restarted: boolean; fresh: boolean; lastReply: string; firstTurnOfConvertedChat?: boolean },
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
  lines.push(`Plan so far:\n${checklist(task.plan)}`);
  if (task.progress) lines.push(`Latest progress: ${task.progress}`);
  lines.push("Carry on with the next unchecked step. When the goal is met, call task_finish with your report; if you can't continue without the user, call task_update with a question.]");
  return lines.join("\n");
}

/** Results of a chat's tasks that finished since its model last heard, as a note for its next turn; "" when none. */
export function childResultsNote(conversation: Pick<ConversationRecord, "id" | "childResults">): string {
  if (!conversation.childResults.length) return "";
  const lines: string[] = [];
  for (const id of conversation.childResults) {
    const child = conversations.get(id);
    if (child?.kind !== "task" || !child.task) continue;
    lines.push(`- “${child.title}” (${child.id}) — ${child.task.status}: ${clipped(child.task.summary ?? "(no summary)", 6000)}`);
  }
  conversations.update(conversation.id, { childResults: [] });
  return lines.length ? `[Tasks you started have finished since your last reply:\n${lines.join("\n")}\nUse their results where they matter; the user can see each one on its card.]` : "";
}
