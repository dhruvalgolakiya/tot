import type { Conversation, Project } from "@tot/shared/types";
import { dateGroup, type DateGroup } from "./format";

export type ConversationGroup = { label: "Pinned" | DateGroup; items: Conversation[] };

const GROUP_ORDER: ConversationGroup["label"][] = ["Pinned", "Today", "Yesterday", "Previous 7 days", "Older"];

export function conversationTitle(conversation: Conversation): string {
  return conversation.title.trim() || "New chat";
}

/** Filter by title and bucket into Pinned / Today / Yesterday / Previous 7 days / Older (newest first in each). */
export function groupConversations(conversations: Conversation[], query: string): ConversationGroup[] {
  const needle = query.trim().toLowerCase();
  const now = new Date();
  const buckets = new Map<ConversationGroup["label"], Conversation[]>();

  for (const conversation of conversations) {
    if (needle && !conversationTitle(conversation).toLowerCase().includes(needle)) continue;
    const label = conversation.pinned ? "Pinned" : dateGroup(conversation.updatedAt, now);
    const bucket = buckets.get(label);
    if (bucket) bucket.push(conversation);
    else buckets.set(label, [conversation]);
  }

  // Pinned chats in the order they were dragged into (a newly pinned one on top); ones pinned before that, after.
  buckets.get("Pinned")?.sort((a, b) => (a.pinPosition ?? Infinity) - (b.pinPosition ?? Infinity));

  return GROUP_ORDER.flatMap((label) => {
    const items = buckets.get(label);
    return items ? [{ label, items }] : [];
  });
}

/** Archived, or snoozed until later: out of the chat list (the palette and the Archived dialog still find it). */
export function isHiddenChat(conversation: Conversation, now = Date.now()): boolean {
  return Boolean(conversation.archivedAt) || (conversation.snoozedUntil ?? 0) > now;
}

/**
 * The chats the list shows for an agent (not its tasks, nor chats filed in a live project, which show under it), and
 * the ones it keeps out of sight (archived, snoozed).
 */
export function listedChats(
  conversations: Conversation[],
  agentId: string | null,
  projects: { projects: Pick<Project, "id" | "archived">[]; state: string },
  now = Date.now(),
): { agentChats: Conversation[]; looseChats: Conversation[]; hidden: Conversation[] } {
  const filed = new Set(projects.projects.filter((p) => !p.archived).map((p) => p.id));
  const mine = conversations.filter((c) => c.kind !== "task" && (!agentId || c.agentId === agentId));
  const agentChats = mine.filter((c) => !isHiddenChat(c, now));
  // While projects load, a chat with a project waits rather than flashing in the loose list.
  const looseChats = agentChats.filter((c) => !c.projectId || (projects.state !== "loading" && !filed.has(c.projectId)));
  return { agentChats, looseChats, hidden: mine.filter((c) => !c.lead && isHiddenChat(c, now)) };
}
