import type { Conversation } from "@tot/shared/types";

/** Chats attached to a message as reference (module 05): at most three, from the same agent. */
export const MAX_ATTACHED_CHATS = 3;

/** Drag type of a sidebar chat dropped on the composer. */
export const CHAT_DRAG_TYPE = "application/x-tot-chat";

/** The "@query" being typed just before the caret (after a space or at the start), or null. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|\s)@([^\s@]{0,40})$/.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[2]!.length - 1, query: match[2]! };
}

/** Chats the picker offers for `query`: the agent's other chats (not tasks), title matches first, newest first. */
export function chatMatches(conversations: Conversation[], opts: { agentId: string | null; exclude: string[]; query: string; limit?: number }): Conversation[] {
  const needle = opts.query.trim().toLowerCase();
  return conversations
    .filter((c) => c.kind === "chat" && c.agentId === opts.agentId && !opts.exclude.includes(c.id))
    .filter((c) => !needle || c.title.toLowerCase().includes(needle))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, opts.limit ?? 6);
}
