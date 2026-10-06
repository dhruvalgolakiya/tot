import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TaskLandOptions } from "../../shared/types.ts";
import { askUser } from "../agent/approvals.ts";
import type { ConversationRecord } from "../data/conversations.ts";
import { landing } from "../landing/land.ts";
import { guarded, reply } from "../mcp/results.ts";
import { missionOverview } from "../mission/overview.ts";
import { projects } from "../projects/projects.ts";
import { taskStore, type TaskRecord } from "../tasks/store.ts";
import { projectBoardText } from "./board.ts";

/**
 * Module 11 (docs/roadmap/11-workspaces.md), lane D: the Lead's tools, only in a project's Lead chat.
 * mission_overview reads the project's board; task_land and task_discard ask the user on an approval card
 * first (askUser) and act only on their yes, landing exactly the head the card showed; task_update_from_base
 * brings a branch up to date. (task_list, task_status and task_message reach every task in the project for
 * a Lead too: tasks/tools.ts.)
 */

/** What the card says when the user doesn't answer, says no, or there's no turn to ask in. */
const NOT_LANDED = "The user said no, or didn't answer in time: nothing landed. Don't ask again unless they bring it up.";
const NOT_DISCARDED = "The user said no, or didn't answer in time: nothing was discarded.";
const NO_TURN = "Couldn't ask the user (no reply of yours is running here), so nothing happened.";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
        "Propose landing a finished task: the user sees a card (what lands where, its changes and checks, your reason) and it lands only if they approve: merged into the project's folder on their Mac, or pushed as a draft PR for a GitHub repo. Exactly the commit the card showed lands. If they say no or don't answer, nothing lands. Check the task first (result, checks, overlaps, behind its base).",
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
          // Why not, in the project's own way of landing: a merge for a folder on this Mac, else a draft PR.
          const why = projects.get(projectId)?.kind === "folder" ? options.merge.reason : options.pr.reason;
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
        const yes = await askUser(conversation.id, "Lead", message, extra.signal);
        if (yes === null) return reply(NO_TURN, true);
        if (!yes) return reply(NOT_LANDED);
        try {
          const landed = (await landing.land(task.id, { method: how, headSha })).task.landing;
          if (landed?.kind === "pr") return reply(`Opened draft PR #${landed.pr?.number ?? "?"} for “${task.title}” against ${landed.target ?? base}: ${landed.pr?.url ?? ""}`.trim());
          return reply(`Merged “${task.title}” into ${landed?.target ?? base}${landed?.sha ? ` (${landed.sha.slice(0, 7)})` : ""}. Its worktree is gone.`);
        } catch (err) {
          return reply(`The user approved, but it didn't land: ${errorText(err)} Nothing changed.`, true);
        }
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
        "Propose throwing a task's work away: the user sees a card and it happens only if they approve. Stops it if it's running, removes its worktree, deletes its branch unless it was pushed.",
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
        const yes = await askUser(conversation.id, "Lead", message, extra.signal);
        if (yes === null) return reply(NO_TURN, true);
        if (!yes) return reply(NOT_DISCARDED);
        try {
          await landing.discard(task.id);
          return reply(`Discarded “${task.title}”.`);
        } catch (err) {
          return reply(`The user approved, but it wasn't discarded: ${errorText(err)}`, true);
        }
      }),
  );
}
