import { create } from "zustand";
import type { QueuedMessage, SendMessageRequest, SendNowResult } from "@tot/shared/types";
import { api } from "./api";

/**
 * The composer's queue: messages sent while a chat's turn runs wait on the server and go out in order when the turn
 * ends (apps/server/chats/queue.ts). This keeps each open chat's list, live through the `queue` AppEvent.
 */

interface QueueState {
  queues: Record<string, QueuedMessage[]>;
}

export const useQueues = create<QueueState>()(() => ({ queues: {} }));

const NONE: QueuedMessage[] = [];

export const useQueue = (conversationId: string | null) => useQueues((s) => (conversationId ? (s.queues[conversationId] ?? NONE) : NONE));

export function setQueue(conversationId: string, queue: QueuedMessage[]) {
  useQueues.setState((s) => ({ queues: { ...s.queues, [conversationId]: queue } }));
}

/** The chat's queue as the server has it; a failure leaves what's shown (the next AppEvent catches up). */
export async function loadQueue(conversationId: string) {
  try {
    setQueue(conversationId, await api.listQueue(conversationId));
  } catch {
    // Shown as it was; the queue still runs on the server.
  }
}

export async function queueMessage(conversationId: string, request: SendMessageRequest): Promise<QueuedMessage> {
  const item = await api.queueMessage(conversationId, request);
  // The AppEvent usually lands first; this covers a slow event stream.
  useQueues.setState((s) => {
    const current = s.queues[conversationId] ?? NONE;
    return current.some((entry) => entry.id === item.id) ? s : { queues: { ...s.queues, [conversationId]: [...current, item] } };
  });
  return item;
}

export async function removeQueued(conversationId: string, itemId: string) {
  const before = useQueues.getState().queues[conversationId] ?? NONE;
  setQueue(conversationId, before.filter((entry) => entry.id !== itemId));
  try {
    await api.removeQueued(conversationId, itemId);
  } catch (error) {
    setQueue(conversationId, before);
    throw error;
  }
}

export function sendQueuedNow(conversationId: string, itemId: string): Promise<SendNowResult> {
  return api.sendQueuedNow(conversationId, itemId);
}

/** A queued message's one-line preview: its text, else what it carries. */
export function queuedPreview(request: SendMessageRequest): string {
  const text = request.text.replace(/\s+/g, " ").trim();
  if (text) return text;
  const files = request.attachments?.length ?? 0;
  if (files) return files === 1 ? "1 attachment" : `${files} attachments`;
  return request.skill ? `/${request.skill}` : "Message";
}
