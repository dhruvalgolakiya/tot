import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TaskLandOptions } from "../../shared/types.ts";
import type { ConversationRecord } from "../data/conversations.ts";
import { landing } from "../landing/land.ts";
import { guarded, reply } from "../mcp/results.ts";
import { missionOverview } from "../mission/overview.ts";
import { projects } from "../projects/projects.ts";
import { projectRepos } from "../projects/repos.ts";
import { taskStore, type TaskRecord } from "../tasks/store.ts";
import { leadAsks } from "./asks.ts";
import { projectBoardText } from "./board.ts";

/**
 * Module 11 (docs/roadmap/11-workspaces.md), lane D: the Lead's tools, only in a project's Lead chat.
 * mission_overview reads the project's board; task_land and task_discard put a request on a card for the user
 * (asks.ts) and return: it waits as long as the user takes, and only their yes lands (exactly the head the card
 * showed) or discards; task_update_from_base
 * brings a branch up to date. (task_list, task_status and task_message reach every task in the project for
 * a Lead too: tasks/tools.ts.)
 */

const NO_TURN = "Couldn't ask the user (no reply of yours is running here), so nothing happened.";

/** One line on the change, for the card: "+14 −1 · 3 files · checks passing · 2 commits behind main · overlaps “Refactor cart”". */
function changeLine(task: TaskRecord, options: TaskLandOptions, base: string): string {
  const { stats, checks, repo } = task.task;
  const parts: string[] = [];
  if (stats) parts.push(`+${stats.added} −${stats.removed} · ${stats.files} file${stats.files === 1 ? "" : "s"}`);
  if (checks) {
    const state = { running: "checks running", passing: "checks passing", failing: "checks failing", none: "no checks" }[checks.state];
    parts.push(checks.headSha && repo?.headSha && checks.headSha !== repo.headSha ? `${state} (older commit)` : state);
  }
  if (options.behind) parts.push(`${options.behind} commit${options.behind === 1 ? "" : "s"} behind ${base}`);
  const overlaps = missionOverview({ projectId: task.projectId }).tasks.find((t) => t.conversation.id === task.id)?.overlaps ?? [];
  if (overlaps.length) parts.push(`overlaps ${overlaps.map((o) => `“${taskStore.get(o.taskId)?.title ?? "another task"}”`).join(", ")}`);
  return parts.join(" · ");
}

export function registerLeadTools(server: McpServer, conversation: ConversationRecord): void {
  if (!conversation.lead || !conversation.projectId) return;
  const projectId = conversation.projectId;

  /** A task in this project, else an error the model can read. */
  const inProject = (id: string): TaskRecord => {
    const task = taskStore.get(id);
    if (!task || task.projectId !== projectId) throw new Error(`No task with id ${id} in this project.`);
    return task;
  };

  server.registerTool(
    "mission_overview",
    {
      title: "The project's board",
      description:
        "The project's board right now: its repos; tasks that need the user, are working, are ready to land (with their changes, checks and overlaps, in the order to land them), and what landed today. Start here before planning or landing.",
      inputSchema: {},
    },
    () =>
      guarded(async () => {
        const project = projects.get(projectId);
        if (!project) return reply("This project isn't there anymore.", true);
        return reply(projectBoardText(project, conversation.id));
      }),
  );

  server.registerTool(
    "task_land",
    {
      title: "Land a task (asks the user)",
      description:
        "Propose landing a finished task: the user gets a card (what lands where, its changes and checks, your reason) and it lands only when they approve: merged into the project's folder on their Mac, or pushed as a draft PR for a GitHub repo. The card waits for them as long as it takes; this tool returns at once. On their yes TOT lands exactly the commit the card showed and notes it in this chat; on no, nothing lands. Never land a task any other way. Check the task first (result, checks, overlaps, behind its base).",
      inputSchema: {
        task_id: z.string().min(1).describe("The task to land"),
        method: z.enum(["merge", "pr"]).optional().describe("merge (a folder on the user's Mac) or pr (a draft PR on GitHub); default: whichever the project can do"),
        reason: z.string().min(1).max(500).describe("One line for the user on why it's ready, e.g. “Fixes the cart total; tests pass; no overlaps.”"),
      },
    },
    ({ task_id, method, reason }, extra) =>
      guarded(async () => {
        const task = inProject(task_id);
        const repo = task.task.repo;
        if (!repo) return reply(`“${task.title}” has no code to land.`, true);
        const options = await landing.options(task.id);
        const how = method ?? (options.merge.available ? "merge" : options.pr.available ? "pr" : null);
        if (!how) {
          // Why not, in the task's repo's own way of landing: a merge for a folder on this Mac, else a draft PR.
          const kind = projectRepos.forTask(task)?.kind ?? projects.get(projectId)?.kind;
          const why = kind === "folder" ? options.merge.reason : options.pr.reason;
          return reply(`“${task.title}” can't land right now, so the user wasn't asked: ${why ?? "there's no way to land it here."}`, true);
        }
        const option = options[how];
        if (!option.available) return reply(`“${task.title}” can't land as a ${how === "merge" ? "merge" : "draft PR"} right now, so the user wasn't asked: ${option.reason}`, true);
        const base = how === "merge" ? (options.merge.target ?? repo.baseBranch ?? "main") : options.pr.base;
        // The head the card describes is the one that lands: the landing API refuses it if the branch moved since.
        const headSha = repo.headSha ?? undefined;
        if (!headSha) return reply(`“${task.title}” has no known head commit yet, so the user wasn't asked. Check it again once it has finished.`, true);
        const question = how === "merge" ? `Merge “${task.title}” into ${base}?` : `Open a draft PR for “${task.title}” against ${base}?`;
        const line = changeLine(task, options, base);
        const message = `${question}${line ? ` · ${line}` : ""}\n${repo.repoName ? `${repo.repoName} · ` : ""}${repo.branch} @ ${headSha.slice(0, 7)}\n${reason.trim()}`;
        if (leadAsks.openFor(task.id, "land", headSha)) return reply(`The user has a card for landing “${task.title}” at ${headSha.slice(0, 7)} already; it's waiting for their answer. Don't ask again.`);
        const asked = leadAsks.post(conversation.id, { taskId: task.id, action: "land", method: how, headSha, message });
        if (!asked) return reply(NO_TURN, true);
        return reply(
          `Asked the user on a card. It waits for them, after this reply too; on their yes TOT lands “${task.title}” at ${headSha.slice(0, 7)} (${how === "merge" ? `a merge into ${base}` : `a draft PR against ${base}`}) and notes it in this chat. Nothing has landed yet: tell the user it's waiting for their OK, and don't ask again for this commit.`,
        );
      }),
  );

  server.registerTool(
    "task_update_from_base",
    {
      title: "Update a task from its base",
      description:
        "Rebase a finished task's branch onto its base branch (fetched first for a GitHub repo), in its own worktree. When that conflicts, the task gets a turn to resolve the conflicts itself; you hear when it's done.",
      inputSchema: { task_id: z.string().min(1).describe("The task to update") },
    },
    ({ task_id }) =>
      guarded(async () => {
        const before = inProject(task_id);
        const after = await landing.updateFromBase(before.id);
        const base = after.task.repo?.baseBranch ?? "its base";
        if (after.task.status === "running" || after.task.status === "queued") {
          return reply(`“${after.title}” needs a hand with ${base} (conflicts, or work not committed): it's resolving that itself now. You'll hear when it's done.`);
        }
        const head = after.task.repo?.headSha ?? null;
        if (head && head !== before.task.repo?.headSha) {
          return reply(`Rebased “${after.title}” onto ${base}: now at ${head.slice(0, 7)}.${after.task.checks?.state === "running" ? " Its checks are running again." : ""}`);
        }
        return reply(`“${after.title}” is already up to date with ${base}.`);
      }),
  );

  server.registerTool(
    "task_discard",
    {
      title: "Discard a task (asks the user)",
      description:
        "Propose throwing a task's work away: the user gets a card and it happens only when they approve (the card waits for them; this tool returns at once). Stops it if it's running, removes its worktree, deletes its branch unless it was pushed.",
      inputSchema: {
        task_id: z.string().min(1).describe("The task to discard"),
        reason: z.string().min(1).max(500).describe("One line for the user on why"),
      },
    },
    ({ task_id, reason }, extra) =>
      guarded(async () => {
        const task = inProject(task_id);
        if (!task.task.repo) return reply(`“${task.title}” has no code to discard.`, true);
        const landed = task.task.landing;
        if (landed?.kind === "discarded") return reply(`“${task.title}” is discarded already.`);
        if (landed) return reply(`“${task.title}” has landed already (${landed.kind === "pr" ? `draft PR #${landed.pr?.number ?? "?"}` : "merged"}); it can't be discarded.`, true);
        const message = `Discard “${task.title}”? Its worktree and branch ${task.task.repo.branch} go (a branch that was pushed stays).\n${reason.trim()}`;
        if (leadAsks.openFor(task.id, "discard", null)) return reply(`The user has a card for discarding “${task.title}” already; it's waiting for their answer.`);
        const asked = leadAsks.post(conversation.id, { taskId: task.id, action: "discard", headSha: null, message });
        if (!asked) return reply(NO_TURN, true);
        return reply(`Asked the user on a card. It waits for them; on their yes TOT discards “${task.title}” and notes it in this chat. Nothing is discarded yet.`);
      }),
  );
}
