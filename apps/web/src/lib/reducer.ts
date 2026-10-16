import type { Message, MessagePart, RunEvent } from "@shared/types";

export type RunStartEvent = Extract<RunEvent, { type: "run-start" }>;

/** The empty assistant message a run starts filling in. */
export function createAssistantMessage(event: RunStartEvent, createdAt = Date.now()): Message {
  return {
    id: event.messageId,
    conversationId: event.conversationId,
    role: "assistant",
    parts: [],
    status: "streaming",
    provider: event.provider,
    model: event.model,
    routeReason: event.routeReason,
    createdAt,
  };
}

/** Apply one streaming event to the assistant message it belongs to. Pure. */
export function applyRunEvent(message: Message, event: RunEvent): Message {
  switch (event.type) {
    case "run-start":
      return {
        ...message,
        provider: event.provider,
        model: event.model,
        routeReason: event.routeReason ?? message.routeReason,
      };
    case "part-start":
    case "part-update":
      return { ...message, parts: upsertPart(message.parts, event.part) };
    case "part-delta":
      return appendDelta(message, event.partId, event.delta);
    case "usage":
      return { ...message, usage: { ...message.usage, ...event.usage } };
    case "error":
      return { ...message, error: event.message };
    case "run-end":
      return event.message;
    default:
      return message;
  }
}

function upsertPart(parts: MessagePart[], part: MessagePart): MessagePart[] {
  const index = parts.findIndex((p) => p.id === part.id);
  return index === -1 ? [...parts, part] : parts.with(index, part);
}

function appendDelta(message: Message, partId: string, delta: string): Message {
  const index = message.parts.findIndex((p) => p.id === partId);
  if (index === -1) return message;
  const part = message.parts[index];
  if (part.type !== "text" && part.type !== "reasoning") return message;
  return { ...message, parts: message.parts.with(index, { ...part, text: part.text + delta }) };
}

/** Replace a message with the same id, or append it. */
export function upsertMessage(messages: Message[], message: Message): Message[] {
  const index = messages.findIndex((m) => m.id === message.id);
  return index === -1 ? [...messages, message] : messages.with(index, message);
}
