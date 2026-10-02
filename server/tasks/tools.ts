import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { conversations, type ConversationRecord } from "../data/conversations.ts";
import { guarded, reply } from "../mcp/results.ts";
import { taskStore, type TaskRecord } from "./store.ts";
import { tasks } from "./tasks.ts";

/**
 * The agent's task tools on TOT's MCP server. In a chat: start tasks and keep an eye on them
 * (task_start, task_list, task_status, task_message). Inside a task: report progress and
 * finish (task_update, task_finish).
 */

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function describe(task: TaskRecord): string {
  const { status, progress, plan, question, repo, queuePosition, summary } = task.task;
  const lines = [`- ${task.id} · “${task.title}” · ${status}${status === "queued" && queuePosition ? ` (#${queuePosition} in line)` : ""}`];
  if (repo) lines.push(`  repo ${repo.source} · branch ${repo.branch}`);
  if (plan.length) lines.push(`  plan: ${plan.filter((step) => step.done).length}/${plan.length} steps done`);
  if (progress) lines.push(`  now: ${progress}`);
  if (question) lines.push(`  waiting for the user: ${question}`);
  if (summary) lines.push(`  result: ${summary}`);
  return lines.join("\n");
}

/** A child of this chat, or null. */
function child(conversation: ConversationRecord, id: string): TaskRecord | null {
  const task = taskStore.get(id);
  return task && task.parentId === conversation.id ? task : null;
}

export function registerTaskTools(server: McpServer, conversation: ConversationRecord): void {
  if (conversation.kind === "task") {
    registerInsideTask(server, conversation.id);
    return;
  }

  server.registerTool(
    "task_start",
    {
      title: "Start a task",
      description:
        "Start a task: work that runs in the background until it's done (on your computer; with `repo`, on its own git branch and worktree), shown as a live card in this chat, reporting its result back here. Use it for real work that takes more than a few minutes — a code change, research across sources, a report. Several tasks can run at once. The task doesn't see this chat, so make the goal self-contained.",
      inputSchema: {
        title: z.string().min(1).max(80).describe('Short title for the card, e.g. "Fix flaky checkout test"'),
        goal: z
          .string()
          .min(1)
          .max(4000)
          .describe("What to do and what done means, with everything the task needs to know (it doesn't see this chat)"),
        repo: z.string().optional().describe('For code: GitHub "owner/name", a git URL, or a folder on your computer like ~/repos/web'),
        base_branch: z.string().optional().describe("Branch to start from (default: the repo's default branch)"),
        model: z.string().optional().describe('Model id, e.g. "claude:claude-opus-5-5" (default: this chat\'s model)'),
      },
    },
    ({ title, goal, repo, base_branch, model }) =>
      guarded(async () => {
        const task = tasks.startFromChat(conversation.id, { title, goal, repo, baseBranch: base_branch, modelId: model }, "agent");
        const where = task.task.status === "queued" ? `queued (#${task.task.queuePosition} in line; it starts when a slot frees up)` : task.task.status;
        return reply(
          `Started task ${task.id} “${task.title}”: ${where}.${task.task.repo ? ` It works on branch ${task.task.repo.branch} in ${task.task.repo.worktree}.` : ""} Its card is in this chat, and its result comes back here when it finishes. Check on it with task_status.`,
        );
      }),
  );

  server.registerTool(
    "task_list",
    {
      title: "List tasks",
      description: "List the tasks started from this chat, with their status, progress and results.",
      inputSchema: {},
    },
    () =>
      guarded(async () => {
        const list = conversations.tasks({ parentId: conversation.id }) as TaskRecord[];
        if (!list.length) return reply("No tasks have been started from this chat.");
        return reply(`${plural(list.length, "task")}:\n${list.map(describe).join("\n")}`);
      }),
  );

  server.registerTool(
    "task_status",
    {
      title: "Check a task",
      description: "The status, plan, progress and result of one task started from this chat.",
      inputSchema: { id: z.string().min(1).describe("The task id from task_start or task_list") },
    },
    ({ id }) =>
      guarded(async () => {
        const task = child(conversation, id);
        if (!task) return reply(`No task with id ${id} was started from this chat.`, true);
        const plan = task.task.plan.map((step) => `  - [${step.done ? "x" : " "}] ${step.text}`).join("\n");
        return reply(`${describe(task)}${plan ? `\n  checklist:\n${plan}` : ""}`);
      }),
  );

  server.registerTool(
    "task_message",
    {
      title: "Message a task",
      description:
        "Add an instruction to a task started from this chat. A running task gets it mid-run (as a note from the user); a finished or paused one picks up again with it.",
      inputSchema: {
        id: z.string().min(1).describe("The task id"),
        text: z.string().min(1).max(4000).describe("The instruction, e.g. “Also cover pricing for teams over 50”"),
      },
    },
    ({ id, text }) =>
      guarded(async () => {
        const task = child(conversation, id);
        if (!task) return reply(`No task with id ${id} was started from this chat.`, true);
        const result = await tasks.message(id, { text });
        return reply("steered" in result ? `Sent to “${task.title}” while it runs.` : `“${task.title}” picked up again with your message.`);
      }),
  );
}

function registerInsideTask(server: McpServer, taskId: string): void {
  server.registerTool(
    "task_update",
    {
      title: "Update the task",
      description:
        "Report on your task: `plan` replaces your checklist (3–8 concrete steps; tick them with done: true as you go), `progress` is one line on what you're doing now. Only when you can't continue without the user, pass `question` — the task then waits for their answer, so end your turn after asking.",
      inputSchema: {
        progress: z.string().max(300).optional().describe("One line: what you're doing now"),
        plan: z
          .array(z.object({ text: z.string().min(1).max(200), done: z.boolean() }))
          .max(30)
          .optional()
          .describe("Your whole checklist, in order"),
        question: z.string().max(1000).optional().describe("Something only the user can answer, that blocks you"),
      },
    },
    ({ progress, plan, question }) =>
      guarded(async () => {
        const task = tasks.update(taskId, { progress, plan, question });
        const { plan: steps } = task.task;
        const done = steps.filter((step) => step.done).length;
        return reply(
          question
            ? "Asked the user. End your turn now; the task continues when they answer."
            : `Updated.${steps.length ? ` Plan: ${done}/${steps.length} steps done.` : ""}`,
        );
      }),
  );

  server.registerTool(
    "task_finish",
    {
      title: "Finish the task",
      description:
        'End the task when its goal is met ("done") or can\'t be met ("failed"). The summary is your report to whoever asked: what you did, the result, and where to find it (files, branch, links, sources).',
      inputSchema: {
        outcome: z.enum(["done", "failed"]),
        summary: z.string().min(1).max(20_000).describe("Your report"),
      },
    },
    ({ outcome, summary }) =>
      guarded(async () => {
        const task = tasks.finish(taskId, outcome, summary);
        return reply(`Task ${task.task.status}. Your report goes back to whoever asked. You can end your turn now.`);
      }),
  );
}
