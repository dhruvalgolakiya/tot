import { randomUUID } from "node:crypto";
import type { MessagePart, Project } from "../../shared/types.ts";
import { runRegistry } from "../agent/runs.ts";
import { appEvents } from "../app-events.ts";
import { conversations, toPublicConversation, type ConversationRecord } from "../data/conversations.ts";
import { messages } from "../data/messages.ts";
import { scrub } from "../trust/secrets.ts";
import { leadInbox } from "../lead/inbox.ts";
import { projects } from "./projects.ts";
import { detectTicket, ticketOrigin, type Ticket } from "./tickets.ts";

/**
 * Intake (module 06): where a project's work comes from. A Slack channel it lists, a ticket from a
 * Linear team it lists, or an issue or pull request of its own GitHub repo starts a chat in it, but
 * only when exactly one project matches. A project's name in the text doesn't count: "web" is too
 * common a word. TOT never files a chat silently: a notice in the chat says so, and Move undoes it.
 * Module 12: work for a project with a Lead goes to the Lead as a `ticket` signal instead (toLead).
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

/** Work from outside for a project's Lead (module 12): who sent it, where (e.g. "in #web-bugs", "by email"), and a link. */
export interface OutsideWork {
  slackChannel?: string | null;
  text: string;
  who: string;
  where: string;
  url?: string | null;
  /** Names this request, so seeing it twice (a retry, a restart) gives the Lead one ticket. */
  key: string;
}

const MAX_TICKET = 3000;

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

  /**
   * Module 12: work from outside (a Slack thread, an email) that's one project's intake, when that project has a Lead,
   * goes to the Lead as a `ticket` signal (who, where, the text, the link) instead of a chat of its own. Returns the
   * project it went to; null when no single project takes it or it has no Lead yet (the caller starts a chat, as before).
   */
  toLead(request: OutsideWork): Project | null {
    const ticket = detectTicket(request.text);
    const project = only({ slackChannel: request.slackChannel, ticket });
    if (!project?.leadChatId) return null;
    const text = request.text.trim();
    leadInbox.post(
      project.id,
      {
        kind: "ticket",
        title: `${ticket ? ticket.key : "A request"} from ${request.who} ${request.where}`,
        // Kept for days and shown to the Lead: no keys or passwords someone pasted.
        detail: scrub(text.length > MAX_TICKET ? `${text.slice(0, MAX_TICKET - 1).trimEnd()}…` : text),
        url: ticket?.url ?? request.url ?? null,
        repoName: null,
        taskId: null,
        prNumber: null,
      },
      { key: `ticket:${request.key}` },
    );
    return project;
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
