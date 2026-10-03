import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Role } from "../../shared/types.ts";
import { conversations, type ConversationRecord } from "../data/conversations.ts";
import { guarded, reply } from "../mcp/results.ts";
import { handoffs } from "../orchestration/handoff.ts";
import { ROLE_NAMES, toResult } from "../orchestration/roles.ts";
import { spawnMany, type SpawnSpec } from "../orchestration/spawn.ts";
import { markResultsRead, MAX_DEPTH } from "./prompt.ts";
import { taskStore, type TaskRecord } from "./store.ts";
import { tasks } from "./tasks.ts";

/**
 * The agent's task tools on TOT's MCP server. In a chat (and in a task that may start tasks of
 * its own): start sessions and keep an eye on them (task_start, task_spawn_many, task_list,
 * task_status, task_message). Inside a task: report progress, write handoffs, and finish
 * (task_update, handoff_write, task_finish).
 */

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function describe(task: TaskRecord): string {
  const { status, progress, plan, question, repo, queuePosition, summary, role, tier } = task.task;
  const lines = [
    `- ${task.id} · “${task.title}”${role ? ` · ${role}${tier ? ` (${tier})` : ""}` : ""} · ${status}${status === "queued" && queuePosition ? ` (#${queuePosition} in line)` : ""}`,
  ];
  if (repo) lines.push(`  repo ${repo.source} · branch ${repo.branch}`);
  if (plan.length) lines.push(`  plan: ${plan.filter((step) => step.done).length}/${plan.length} steps done`);
  if (progress) lines.push(`  now: ${progress}`);
  if (question) lines.push(`  waiting for the user: ${question}`);
  if (summary) lines.push(`  result: ${summary}`);
  return lines.join("\n");
}

/** A task this conversation started, or null. */
function child(conversation: ConversationRecord, id: string): TaskRecord | null {
  const task = taskStore.get(id);
  return task && task.parentId === conversation.id ? task : null;
}

const role = z.enum(ROLE_NAMES as [Role, ...Role[]]).optional();
const sessionShape = {
  title: z.string().min(1).max(80).describe('Short title for the card, e.g. "Fix flaky checkout test"'),
  goal: z.string().min(1).max(4000).describe("What to do, self-contained: the session doesn't see this conversation"),
  role: role.describe(
    "explorer (where/how, fast), planner, implementer (makes the change), tester, reviewer (runs on the other provider), researcher, writer",
  ),
  tier: z.enum(["fast", "standard", "deep"]).optional().describe("Model tier; defaults to the role's (Settings → Models)"),
  provider: z.enum(["claude", "chatgpt"]).optional().describe("Run on this provider when it can"),
  repo: z.string().optional().describe('For code: GitHub "owner/name", a git URL, or a folder on your computer like ~/repos/web'),
  base_branch: z.string().optional().describe("Branch to start from (default: the repo's default branch)"),
  constraints: z.array(z.string()).max(20).optional().describe("Rules it must follow"),
  context: z.array(z.string()).max(20).optional().describe("Brain pages, files and links to read first"),
  done: z.string().max(1000).optional().describe("What done means"),
};
type SessionInput = { [K in keyof typeof sessionShape]?: z.infer<(typeof sessionShape)[K]> } & { title: string; goal: string };

const toSpec = (input: SessionInput): SpawnSpec => ({
  title: input.title,
  goal: input.goal,
  role: input.role,
  tier: input.tier,
  provider: input.provider,
  repo: input.repo,
  baseBranch: input.base_branch,
  constraints: input.constraints,
  context: input.context,
  done: input.done,
});

export function registerTaskTools(server: McpServer, conversation: ConversationRecord): void {
  const inTask = conversation.kind === "task" && conversation.task;
  if (inTask) registerInsideTask(server, conversation.id);
  // Tasks start tasks of their own only up to the depth limit.
  if (inTask && conversation.task!.depth >= MAX_DEPTH) return;

  server.registerTool(
    "task_start",
    {
      title: "Start a task",
      description:
        "Start a task: work that runs in the background until it's done (on your computer; with `repo`, on its own git branch and worktree), shown as a live card here, reporting a structured result back. Use it for real work that takes more than a few minutes — a code change, research across sources, a report. The task gets a brief, not this conversation: make the goal self-contained.",
      inputSchema: sessionShape,
    },
    (input) =>
      guarded(async () => {
        const [task] = spawnMany(conversation.id, [toSpec(input)], { cards: { kind: "reply" } });
        const where = task!.task.status === "queued" ? `queued (#${task!.task.queuePosition} in line; it starts when a slot frees up)` : task!.task.status;
        return reply(
          `Started task ${task!.id} “${task!.title}”${task!.task.role ? ` as ${task!.task.role} (${task!.task.tier})` : ""}: ${where}.${task!.task.repo ? ` It works on branch ${task!.task.repo.branch} in ${task!.task.repo.worktree}.` : ""} Its card is here, and its result comes back when it finishes. Check on it with task_status.`,
        );
      }),
  );

  server.registerTool(
    "task_spawn_many",
    {
      title: "Start several tasks",
      description:
        'Fan out: start several sessions at once for independent parts of the work (e.g. one researcher per vendor), each with its own role and brief. With then: "synthesize", you get one turn with all their results to combine once the last one finishes. Don\'t use it for small or sequential work.',
      inputSchema: {
        sessions: z.array(z.object(sessionShape)).min(1).max(6).describe("One entry per session"),
        then: z.enum(["synthesize"]).optional().describe('"synthesize": combine their results in one turn here when they\'re all done'),
      },
    },
    ({ sessions, then }) =>
      guarded(async () => {
        const started = spawnMany(conversation.id, sessions.map(toSpec), { then, cards: { kind: "reply" } });
        return reply(
          `Started ${plural(started.length, "task")}:\n${started.map(describe).join("\n")}\n${then ? "You'll get their results in one turn when they've all finished." : "Their results come back as they finish."}`,
        );
      }),
  );

  server.registerTool(
    "task_list",
    {
      title: "List tasks",
      description: "List the tasks started from here, with their status, progress and results.",
      inputSchema: {},
    },
    () =>
      guarded(async () => {
        const list = conversations.tasks({ parentId: conversation.id }) as TaskRecord[];
        if (!list.length) return reply("No tasks have been started from here.");
        return reply(`${plural(list.length, "task")}:\n${list.map(describe).join("\n")}`);
      }),
  );

  server.registerTool(
    "task_status",
    {
      title: "Check a task",
      description: "The status, plan, progress and result of one task started from here.",
      inputSchema: { id: z.string().min(1).describe("The task id from task_start or task_list") },
    },
    ({ id }) =>
      guarded(async () => {
        const task = child(conversation, id);
        if (!task) return reply(`No task with id ${id} was started from here.`, true);
        // Its result has been seen now: no wake-up or next-turn note repeats it.
        markResultsRead(conversation.id, [id]);
        const plan = task.task.plan.map((step) => `  - [${step.done ? "x" : " "}] ${step.text}`).join("\n");
        const result = task.task.result;
        const extra = result
          ? `\n  findings: ${result.findings.join("; ") || "—"}\n  sources: ${result.sources.join(", ") || "—"}\n  confidence: ${result.confidence}`
          : "";
        return reply(`${describe(task)}${plan ? `\n  checklist:\n${plan}` : ""}${extra}`);
      }),
  );

  server.registerTool(
    "task_message",
    {
      title: "Message a task",
      description:
        "Add an instruction to a task started from here. A running task gets it mid-run (as a note from the user); a finished or paused one picks up again with it.",
      inputSchema: {
        id: z.string().min(1).describe("The task id"),
        text: z.string().min(1).max(4000).describe("The instruction, e.g. “Also cover pricing for teams over 50”"),
      },
    },
    ({ id, text }) =>
      guarded(async () => {
        const task = child(conversation, id);
        if (!task) return reply(`No task with id ${id} was started from here.`, true);
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
    "handoff_write",
    {
      title: "Write a handoff",
      description:
        "Checkpoint your task: everything another session or provider would need to carry on without this conversation. Write one at natural checkpoints in long work. Be concise and factual.",
      inputSchema: {
        goal: z.string().min(1),
        doneSoFar: z.array(z.string()).describe("What's done, concisely"),
        decisions: z.array(z.object({ decision: z.string().min(1), why: z.string() })),
        plan: z.array(z.object({ text: z.string().min(1), done: z.boolean() })),
        files: z.array(z.object({ path: z.string().min(1), change: z.string() })).describe("Files changed and how"),
        tests: z.array(z.object({ command: z.string().min(1), status: z.enum(["pass", "fail", "not-run"]), note: z.string().optional() })),
        openQuestions: z.array(z.string()),
        nextStep: z.string().min(1).describe("The one thing to do next"),
      },
    },
    (packet) =>
      guarded(async () => {
        handoffs.save(taskId, packet);
        return reply("Handoff saved. If this task moves to another session or provider, it starts from it.");
      }),
  );

  server.registerTool(
    "task_finish",
    {
      title: "Finish the task",
      description:
        'End the task when its goal is met ("done") or can\'t be met ("failed"). The summary is your report to whoever asked: what you did, the result, and where to find it. Fill in findings, files_changed, open_questions, sources and confidence where they apply: they go back as a structured result.',
      inputSchema: {
        outcome: z.enum(["done", "failed"]),
        summary: z.string().min(1).max(20_000).describe("Your report"),
        findings: z.array(z.string()).max(30).optional().describe("Key findings, one per item"),
        files_changed: z.array(z.string()).max(200).optional().describe("Paths you changed"),
        open_questions: z.array(z.string()).max(30).optional(),
        sources: z.array(z.string()).max(50).optional().describe("URLs and documents you relied on"),
        confidence: z.enum(["low", "medium", "high"]).optional(),
      },
    },
    ({ outcome, summary, ...rest }) =>
      guarded(async () => {
        const task = tasks.finish(taskId, outcome, summary, toResult(summary, rest));
        return reply(`Task ${task.task.status}. Your report goes back to whoever asked. You can end your turn now.`);
      }),
  );
}
