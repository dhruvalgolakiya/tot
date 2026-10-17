import type { MessagePart, RewindPreview, RewindResponse } from "@tot/shared/types";
import { HttpError } from "../agent/orchestrator.ts";
import { runRegistry } from "../agent/runs.ts";
import { appEvents } from "../app-events.ts";
import { conversations, toPublicConversation, type ConversationRecord } from "../data/conversations.ts";
import { messages, messageText } from "../data/messages.ts";
import { db, statement, type Row } from "../db.ts";
import { checkpoints } from "./checkpoints.ts";

/**
 * Rewinding a chat to one of the user's messages: that message and everything after it go, and its text and
 * attachments go back to the composer to edit and send again. When asked, a chat with a workspace also gets its files
 * back as they were before the first of those turns changed any (chats/checkpoints.ts). The agent forgets the turns
 * that went: the next turn carries on from a copy of the provider session cut after the reply the chat now ends with,
 * as a fork's first turn does (chats/fork.ts nativeStart), or when that can't be (another account wrote it, or the copy
 * fails) a fresh session seeded with what's left of the chat.
 */

function loaded(conversationId: string, messageId: string) {
  const chat = conversations.get(conversationId);
  if (!chat) throw new HttpError(404, "Chat not found.");
  if (chat.kind === "task") throw new HttpError(400, "Tasks can't be rewound; rewind the chat that started it.");
  const history = messages.listByConversation(conversationId);
  const at = history.findIndex((m) => m.id === messageId);
  if (at === -1) throw new HttpError(404, "That message isn't in this chat.");
  const target = history[at]!;
  if (target.role !== "user" || target.auto || target.steered) throw new HttpError(400, "A chat rewinds to one of your messages.");
  const removed = history.slice(at);
  return { chat, target, kept: history.slice(0, at), removed, replyIds: removed.filter((m) => m.role === "assistant").map((m) => m.id) };
}

function publish(record: ConversationRecord | null): void {
  if (record) appEvents.publish({ type: "conversation", conversation: toPublicConversation(record) });
}

export const rewinds = {
  /** What rewinding to `messageId` would take away, and whether the chat's files can go back too. */
  preview(conversationId: string, messageId: string): RewindPreview {
    const { chat, removed, replyIds } = loaded(conversationId, messageId);
    const files = checkpoints.reachable(chat) && checkpoints.earliest(chat.id, replyIds) !== null;
    return { messages: removed.length, files };
  },

  async rewind(conversationId: string, messageId: string, { restoreFiles = false } = {}): Promise<RewindResponse> {
    const { chat, target, kept, removed, replyIds } = loaded(conversationId, messageId);
    if (runRegistry.activeFor(chat.id)) throw new HttpError(409, "Wait for the reply to finish (or stop it), then rewind.");
    // Files first: when they can't go back, the chat stays as it was.
    const checkpoint = restoreFiles ? checkpoints.earliest(chat.id, replyIds) : null;
    if (checkpoint) await checkpoints.restore(chat, checkpoint.sha);
    if (runRegistry.activeFor(chat.id)) throw new HttpError(409, "A reply started meanwhile; the chat wasn't rewound.");

    messages.remove(chat.id, removed.map((m) => m.id));
    void checkpoints.drop(chat, replyIds);
    // Where the next turn picks the provider session up: the last reply left (not a notice TOT posted).
    const last = kept.findLast((m) => m.role === "assistant" && m.parts.some((part) => part.type !== "notice"));
    db.prepare(`INSERT OR REPLACE INTO chat_rewinds (conversation_id, message_id, at) VALUES (?, ?, ?)`).run(chat.id, last?.id ?? null, Date.now());
    // With no reply left, the next turn starts the chat over: no session, and no transcript to carry.
    const updated = conversations.update(chat.id, { providerSessionId: null, ...(last ? {} : { provider: null, providerAccount: null }) }, true);
    publish(updated);
    appEvents.agentChanged(chat.agentId);

    const attachments = target.parts.flatMap((part: MessagePart) => (part.type === "file" ? [part.attachment] : []));
    return {
      conversation: toPublicConversation(updated!),
      draft: { text: messageText(target), attachments, contextChats: target.contextChats ?? [] },
      filesRestored: Boolean(checkpoint),
    };
  },

  /** Where a rewound chat's next turn picks its provider session up: the reply it ends with (null: none). Null when it wasn't rewound. */
  point(conversationId: string): { messageId: string | null } | null {
    const row = statement(`SELECT message_id FROM chat_rewinds WHERE conversation_id = ?`).get(conversationId) as Row | undefined;
    return row ? { messageId: (row.message_id as string | null) ?? null } : null;
  },
};
