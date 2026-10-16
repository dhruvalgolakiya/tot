import { randomUUID } from "node:crypto";
import type { Message } from "../../shared/types.ts";
import { contextMessages } from "../agent/context-select.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { runRegistry } from "../agent/runs.ts";
import { appEvents } from "../app-events.ts";
import { conversations, toPublicConversation, type ConversationRecord } from "../data/conversations.ts";
import { messages } from "../data/messages.ts";

/**
 * Forks (module 05). A fork is a new chat, "Fork of X", with X's messages up to a point copied in
 * so its history shows; it starts no provider session. Its first turn carries on natively when it
 * runs on the provider that wrote the reply it was forked at: a copy of that provider session, cut
 * after that reply (Claude: resume + forkSession + resumeSessionAt; Codex: thread/fork with
 * lastTurnId). Otherwise the copied messages go over through context selection, as after a
 * provider switch. Merging back brings a summary of what the fork did to X's next turn.
 */

/** The note a merge-back leaves: one line a message, plus the fork's latest reply. */
const MERGE_BUDGET = 8_000;
const LINE_CHARS = 240;

const oneLine = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS - 1).trimEnd()}…` : line;
};

/** A message TOT posted about something else (a task's card notice), not a turn of the conversation. */
const isNoticeOnly = (message: Message) => message.role === "assistant" && message.parts.every((part) => part.type === "notice");

function publish(record: ConversationRecord | null): void {
  if (record) appEvents.publish({ type: "conversation", conversation: toPublicConversation(record) });
}

/** A copy of a message for the fork (new ids, same content and time, so the history reads the same). */
function copied(message: Message, conversationId: string): Message {
  return {
    ...message,
    id: randomUUID(),
    conversationId,
    // A reply still streaming in the source can't finish here.
    status: message.status === "streaming" ? "stopped" : message.status,
    steeredInto: undefined,
  };
}

export const forks = {
  /** Forks a chat at `messageId` (inclusive), or whole. */
  create(sourceId: string, messageId?: string): ConversationRecord {
    const source = conversations.get(sourceId);
    if (!source) throw new HttpError(404, "Chat not found.");
    if (source.kind === "task") throw new HttpError(400, "Tasks can't be forked; fork the chat that started it.");
    const history = messages.listByConversation(sourceId);
    let end = history.length;
    if (messageId) {
      end = history.findIndex((m) => m.id === messageId) + 1;
      if (!end) throw new HttpError(404, "That message isn't in this chat.");
    } else if (runRegistry.activeFor(sourceId)) {
      throw new HttpError(409, "Wait for the reply to finish, then fork the chat.");
    }
    const kept = history.slice(0, end);
    const at = kept.at(-1);
    if (!at) throw new HttpError(400, "There's nothing to fork yet.");

    const fork = conversations.create({
      agentId: source.agentId,
      modelId: source.modelId,
      title: `Fork of ${source.title}`.slice(0, 120),
      forkedFrom: { conversationId: sourceId, messageId: at.id, at: Date.now() },
      projectId: source.projectId,
    });
    for (const message of kept) messages.insert(copied(message, fork.id));
    // Same instructions as the source, so a native fork carries on exactly as the source would have.
    const updated = conversations.update(fork.id, { systemPrompt: source.systemPrompt }, true)!;
    publish(updated);
    appEvents.agentChanged(source.agentId);
    return updated;
  },

  /**
   * For a fork's first turn on `account` (a provider account; the built-in ones are named after their provider): the
   * provider session to copy and where to cut it, when the reply it was forked at came from that account — its session
   * lives in that account's folder (null otherwise: context selection then).
   */
  nativeStart(conversation: ConversationRecord, account: string): { sessionId: string; at: string | null } | null {
    if (!conversation.forkedFrom || conversation.providerSessionId) return null;
    const { conversationId, messageId } = conversation.forkedFrom;
    // Forked after notices only (a task finished, a fork came back): the reply before them is where the session stands.
    const history = messages.listByConversation(conversationId);
    let index = history.findIndex((m) => m.id === messageId);
    while (index > 0 && isNoticeOnly(history[index]!)) index--;
    const at = index >= 0 ? history[index] : null;
    const ref = at?.role === "assistant" && at.provider && (at.account ?? at.provider) === account ? messages.providerRef(at.id) : null;
    return ref ? { sessionId: ref.session, at: ref.ref } : null;
  },

  /** A fork brings its new messages back to the chat it came from: a notice there, and a note for that chat's next turn. */
  mergeBack(forkId: string): ConversationRecord {
    const fork = conversations.get(forkId);
    if (!fork?.forkedFrom) throw new HttpError(400, "This chat isn't a fork.");
    const source = conversations.get(fork.forkedFrom.conversationId);
    if (!source) throw new HttpError(404, "The chat this was forked from has been deleted.");
    const added = contextMessages(messages.listByConversation(forkId).filter((m) => m.createdAt >= fork.forkedFrom!.at));
    if (!added.length) throw new HttpError(409, "Nothing new in this fork yet.");

    const latest = added.findLast((m) => m.role === "assistant");
    const room = MERGE_BUDGET * 4 - 600;
    const reply = latest ? (latest.text.length > room / 2 ? `${latest.text.slice(0, room / 2).trimEnd()}… [cut; read it whole with chat_read]` : latest.text) : "";
    // One line a message, newest first while they fit (the latest reply is in full below).
    const lines: string[] = [];
    let used = reply.length;
    for (const m of [...added].reverse()) {
      if (m === latest) continue;
      const line = `- ${m.role === "user" ? "User" : "You"}: ${oneLine(m.text)}`;
      if (used + line.length + 1 > room) break;
      lines.unshift(line);
      used += line.length + 1;
    }
    const left = added.length - lines.length - (latest ? 1 : 0);
    const note = `[The user brought back what happened in the fork “${fork.title}” (chat ${forkId}), which branched off this chat. What it did there, after the fork:
${left ? `(${left} earlier message${left === 1 ? "" : "s"} not shown)\n` : ""}${lines.join("\n")}${reply ? `\nIts latest reply, in full:\n<fork_reply>\n${reply}\n</fork_reply>` : ""}
Read more with chat_read { chatId: "${forkId}" }. Take it into account from here on.]`;

    // A newer merge-back from the same fork replaces one still waiting.
    const notes = [...source.mergeNotes.filter((pending) => pending.forkId !== forkId), { forkId, note, at: Date.now() }];
    conversations.update(source.id, { mergeNotes: notes });
    messages.insert({
      id: randomUUID(),
      conversationId: source.id,
      role: "assistant",
      parts: [
        {
          type: "notice",
          id: `n_${randomUUID().slice(0, 12)}`,
          kind: "info",
          text: `Brought back from “${fork.title}”: ${added.length} new message${added.length === 1 ? "" : "s"}, for the next reply here.`,
        },
      ],
      status: "complete",
      createdAt: Date.now(),
    });
    const updated = conversations.update(source.id, {}, true);
    publish(updated);
    return updated!;
  },

  /** The merge-back notes waiting for a chat's next turn, marked as heard; "" when none. */
  takeNotes(conversation: ConversationRecord): string {
    if (!conversation.mergeNotes.length) return "";
    const current = conversations.get(conversation.id);
    if (current) conversations.update(conversation.id, { mergeNotes: current.mergeNotes.filter((n) => !conversation.mergeNotes.some((t) => t.forkId === n.forkId && t.at === n.at)) });
    return conversation.mergeNotes.map((n) => n.note).join("\n\n");
  },

  /** Chats this one may read with chat_read even with memory off: the chat it was forked from, and its own forks. */
  linked(conversation: ConversationRecord): Set<string> {
    const ids = conversations.forksOf(conversation.id).map((fork) => fork.id);
    if (conversation.forkedFrom) ids.push(conversation.forkedFrom.conversationId);
    return new Set(ids);
  },
};
