import { randomUUID } from "node:crypto";
import type { MessagePart, Project } from "../../shared/types.ts";
import { runRegistry } from "../agent/runs.ts";
import { appEvents } from "../app-events.ts";
import { conversations, toPublicConversation, type ConversationRecord } from "../data/conversations.ts";
import { messages } from "../data/messages.ts";
import { projects } from "./projects.ts";
import { detectTicket, ticketOrigin, type Ticket } from "./tickets.ts";

/**
 * Intake (module 06): where a project's work comes from. A Slack channel it lists, a ticket from a
 * Linear team it lists, or an issue or pull request of its own GitHub repo starts a chat in it, but
 * only when exactly one project matches. A project's name in the text doesn't count: "web" is too
 * common a word. TOT never files a chat silently: a notice in the chat says so, and Move undoes it.
 */

/** Incoming work: where it was posted, and the ticket it's about. */
export interface Work {
  /** e.g. "#web-bugs". */
  slackChannel?: string | null;
  ticket?: Ticket | null;
}

function takes(project: Project, work: Work): boolean {
  const channel = work.slackChannel?.trim().toLowerCase().replace(/^#?/, "#");
  if (channel && project.intake.slackChannels.includes(channel)) return true;
  const { ticket } = work;
  if (ticket?.kind === "linear") return project.intake.linearTeams.includes(ticket.key.split("-")[0]!);
  if (ticket?.kind === "github") {
    const repo = ticket.key.slice(0, ticket.key.lastIndexOf("#")).toLowerCase();
    // Module 11: an issue or PR of any of its GitHub repos.
    return (project.repos ?? []).some((each) => each.kind === "github" && each.source.toLowerCase() === repo);
  }
  return false;
}

/** The one project the work belongs to, or null when none or several match. */
function only(work: Work): Project | null {
  const found = intake.match(work);
  return found.length === 1 ? found[0]! : null;
}

export const intake = {
  /** Every (active) project whose intake the work comes from. */
  match(work: Work): Project[] {
    return projects.list().filter((project) => takes(project, work));
  },

  /** Files a chat (and its tasks) under a project, and says so in the chat. */
  file(chatId: string, project: Project): void {
    projects.moveChat(chatId, project.id);
    intake.notice(chatId, project);
  },

  /** "Filed under web": in the reply being written when there is one, else as a message of its own. */
  notice(chatId: string, project: Project): void {
    const part: MessagePart = { type: "notice", id: `n_${randomUUID().slice(0, 12)}`, kind: "info", text: `Filed under ${project.name}`, projectId: project.id };
    const run = runRegistry.activeFor(chatId);
    if (run?.addPart) return run.addPart(part);
    messages.insert({ id: randomUUID(), conversationId: chatId, role: "assistant", parts: [part], status: "complete", createdAt: Date.now() });
    const record = conversations.update(chatId, {}, true);
    if (record) appEvents.publish({ type: "conversation", conversation: toPublicConversation(record) });
  },

  /** A chat that just came in from Slack or email: filed when its channel, or the ticket in its text, is one project's intake. */
  fileNew(chatId: string, from: { slackChannel?: string | null; text: string }): Project | null {
    const project = only({ slackChannel: from.slackChannel, ticket: detectTicket(from.text) });
    if (project) intake.file(chatId, project);
    return project;
  },

  /**
   * A new chat's first message (chats from Slack and email had their intake when they were made): a
   * ticket link in it becomes the chat's origin, and files the chat when it's one project's intake.
   * Returns the project it was filed under; the caller posts the notice once the reply has started.
   */
  firstMessage(chat: ConversationRecord, text: string): Project | null {
    if (chat.kind !== "chat" || chat.origin) return null;
    const ticket = detectTicket(text);
    if (!ticket) return null;
    const updated = conversations.update(chat.id, { origin: ticketOrigin(ticket) });
    if (updated) appEvents.publish({ type: "conversation", conversation: toPublicConversation(updated) });
    const project = chat.projectId ? null : only({ ticket });
    if (project) projects.moveChat(chat.id, project.id);
    return project;
  },
};
