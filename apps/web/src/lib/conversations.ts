import type { Conversation } from "@tot/shared/types";
import { dateGroup, type DateGroup } from "./format";

export type ConversationGroup = { label: "Pinned" | DateGroup; items: Conversation[] };

const GROUP_ORDER: ConversationGroup["label"][] = ["Pinned", "Today", "Yesterday", "Previous 7 days", "Older"];

export function conversationTitle(conversation: Conversation): string {
  return conversation.title.trim() || "New chat";
}

/** Filter by title and bucket into Pinned / Today / Yesterday / Previous 7 days / Older. */
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

  return GROUP_ORDER.flatMap((label) => {
    const items = buckets.get(label);
    return items ? [{ label, items }] : [];
  });
}
