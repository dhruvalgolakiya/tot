import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appEvents } from "../app-events.ts";
import { conversations, toPublicConversation, type ConversationRecord } from "../data/conversations.ts";
import { guarded, reply } from "../mcp/results.ts";
import { intake } from "./intake.ts";
import { projects } from "./projects.ts";
import { projectSection } from "./prompt.ts";
import { detectTicket, ticketOrigin } from "./tickets.ts";

/**
 * A chat's project tools on TOT's MCP server (module 06): file a chat that's in no project
 * (chat_set_project, only while there are projects), and link it to the ticket it's about
 * (ticket_link). Tasks have neither: a task is in its chat's project, and its branch is named
 * when it starts.
 */
export function registerProjectTools(server: McpServer, conversation: ConversationRecord): void {
  if (conversation.kind !== "chat") return;

  if (projects.list().length) {
    server.registerTool(
      "chat_set_project",
      {
        title: "File this chat in a project",
        description:
          "File this chat under one of the user's projects, when it's clearly about that project: it then gets the project's instructions, brain and repo. Only for a chat that isn't in a project yet; TOT shows the user a note, and they can move it. Say so in your reply. When it's unclear which project, ask the user instead of guessing.",
        inputSchema: { project: z.string().min(1).max(100).describe("The project's name (or slug), from the list in your instructions") },
      },
      ({ project }) =>
        guarded(async () => {
          const chat = conversations.get(conversation.id);
          if (!chat) return reply("This chat no longer exists.", true);
          const current = projects.get(chat.projectId);
          if (current) return reply(`This chat is already in ${current.name}; the user can move it.`, true);
          const target = projects.resolve(project);
          if (!target) {
            const names = projects.list().map((p) => p.name).join(", ");
            return reply(`There's no project called "${project}". The user's projects: ${names}.`, true);
          }
          intake.file(chat.id, target);
          return reply(
            `Filed this chat under ${target.name}; a note here tells the user, who can move it. Your instructions get this section from your next message on:\n${projectSection(projects.get(target.id)!)}`,
          );
        }),
    );
  }

  server.registerTool(
    "ticket_link",
    {
      title: "Link this chat to a ticket",
      description:
        "Record the Linear issue or GitHub issue / pull request this chat is about, when you find it some other way than a link in the first message. The chat shows it, and tasks you start from here get branches named after it (tot/eng-123-…). Only for a chat that isn't linked to anything yet.",
      inputSchema: {
        url: z.string().min(1).max(500).describe("The ticket's link, e.g. https://linear.app/acme/issue/ENG-123/… or https://github.com/acme/web/issues/42"),
      },
    },
    ({ url }) =>
      guarded(async () => {
        const chat = conversations.get(conversation.id);
        if (!chat) return reply("This chat no longer exists.", true);
        if (chat.origin) return reply(`This chat already comes from ${chat.origin.label}; nothing changed.`, true);
        const ticket = detectTicket(url);
        if (!ticket) return reply("That isn't a Linear issue link or a GitHub issue or pull request link.", true);
        const updated = conversations.update(chat.id, { origin: ticketOrigin(ticket) });
        if (updated) appEvents.publish({ type: "conversation", conversation: toPublicConversation(updated) });
        const home = chat.projectId ? [] : intake.match({ ticket });
        const hint = home.length === 1 ? ` It's from ${home[0]!.name}'s intake: if this chat is about that, file it there with chat_set_project.` : "";
        return reply(`Linked this chat to ${ticket.key}. Tasks you start from here get branches named after it.${hint}`);
      }),
  );
}
