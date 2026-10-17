import type { Conversation } from "@tot/shared/types";
import { navigateToConversation, selectActiveAgentId, useStore } from "../store";
import { groupConversations, listedChats } from "./conversations";
import { useProjects } from "./projects";

/** The active agent's chats in the order the list shows them: pinned, then newest first. */
export function sidebarChats(): Conversation[] {
  const s = useStore.getState();
  const { looseChats } = listedChats(s.conversations, selectActiveAgentId(s), useProjects.getState());
  return groupConversations(looseChats, "").flatMap((group) => group.items);
}

/** The next (1) or previous (-1) chat in the list, wrapping around; from outside the list, the first or the last. */
export function stepChat(by: 1 | -1): void {
  const chats = sidebarChats();
  if (!chats.length) return;
  const at = chats.findIndex((c) => c.id === useStore.getState().currentId);
  const next = at < 0 ? (by > 0 ? 0 : chats.length - 1) : (at + by + chats.length) % chats.length;
  navigateToConversation(chats[next]!.id);
}

/** The nth chat in the list (1 is the top one), if there's one. */
export function openNthChat(n: number): void {
  const chat = sidebarChats()[n - 1];
  if (chat) navigateToConversation(chat.id);
}
