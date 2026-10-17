import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FolderGrant } from "../computer/types.ts";
import { reply } from "../mcp/results.ts";

/**
 * Plan mode: a message sent with `plan` asks the agent to look into the work and say how it would do it, not to do it.
 * The turn runs under the provider's own read-only mode where it has one (Claude Code's "plan" permission mode, with
 * these instructions as its workflow; Codex threads already run read-only, so the note says it), and TOT's own tools
 * hold the line for both, since that's where an agent changes things: while a plan turn runs, the tools that change
 * something refuse, and a local computer's commands may read the project's folder but not write to it.
 */

/** The note in front of a plan turn's message. */
export const PLAN_NOTE =
  "[Plan mode: the user wants a plan before any changes. Investigate as much as you need, read-only: read files, search, " +
  "and run only commands that look (ls, grep, git log/diff/status, reading configs). Don't edit or create files, commit, " +
  "start tasks or change anything else. Then reply with a concise plan: what you found, the changes you'd make (files " +
  "and steps), and risks or open questions. The user will tell you when to go ahead.]";

/** Claude Code's plan-mode workflow, replaced: TOT's tools work on the agent's computer, and the reply is the plan. */
export const PLAN_WORKFLOW =
  "Investigate with read-only tools: computer_read_file, and computer_exec only for commands that look (ls, grep, " +
  "git log/diff/status). Don't write a plan file: reply with the plan itself, concise and concrete (what you found, the " +
  "files and steps you'd change, risks and open questions), and stop there. The user decides when to implement it.";

/** TOT tools that change something (files, the desktop, tasks, mail, routines, the wiki): refused in a plan turn. */
export const CHANGING_TOOLS = new Set([
  "computer_write_file",
  "computer_expose_port",
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_scroll",
  "task_start",
  "task_spawn_many",
  "task_message",
  "task_land",
  "task_discard",
  "task_pause",
  "task_resume",
  "task_stop",
  "task_update_from_base",
  "task_preview_start",
  "task_preview_stop",
  "handoff_write",
  "ticket_link",
  "chat_set_project",
  "email_send",
  "email_reply",
  "routine_create",
  "routine_delete",
  "wiki_write",
  "wiki_edit",
  "wiki_delete",
]);

export const PLAN_REFUSAL = "Plan mode is on: this turn only investigates and proposes a plan, so nothing is changed. Put this step in the plan instead.";

/** Chats with a plan turn running, by how many (a chat has one turn at a time, so this is 0 or 1). */
const running = new Map<string, number>();

export const planTurns = {
  begin(conversationId: string): void {
    running.set(conversationId, (running.get(conversationId) ?? 0) + 1);
  },

  end(conversationId: string): void {
    const left = (running.get(conversationId) ?? 1) - 1;
    if (left > 0) running.set(conversationId, left);
    else running.delete(conversationId);
  },

  active(conversationId: string): boolean {
    return running.has(conversationId);
  },

  /** A command's folder grant in a plan turn: the same folders, readable only. */
  readOnly(conversationId: string, grant: FolderGrant | null): FolderGrant | null {
    if (!grant || !running.has(conversationId)) return grant;
    return { folder: grant.folder, ...(grant.reads ? { reads: grant.reads } : {}) };
  },

  /** Makes the chat's MCP server refuse the changing tools while a plan turn runs (checked on each call). */
  guard(server: McpServer, conversationId: string): void {
    const register = server.registerTool.bind(server) as (name: string, config: unknown, handler: (...args: unknown[]) => unknown) => unknown;
    (server as unknown as { registerTool: typeof register }).registerTool = (name, config, handler) =>
      register(name, config, (...args) => (CHANGING_TOOLS.has(name) && running.has(conversationId) ? reply(PLAN_REFUSAL, true) : handler(...args)));
  },
};
