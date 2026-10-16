import type { Message, MessagePart } from "../../shared/types.ts";

/**
 * Clipped chats (GET /api/conversations/:id?clip=1): tool calls are 97% of a long chat's bytes, and the UI shows
 * each one as a single line until it's opened. A finished message's tool parts come with the start of their output
 * and of any long input string, enough for their titles and previews; the whole part is fetched when it's opened
 * (GET /api/conversations/:id/messages/:messageId/parts/:partId).
 */

/** How much of a tool call's output, and of each long string in its input, a clipped chat carries. */
export const CLIP_CHARS = 2000;

type ToolPart = Extract<MessagePart, { type: "tool" }>;

/** The same pattern as the web's firstUrl (src/lib/tools.ts): a screenshot's or an exposed port's link. */
const URL_PATTERN = /https?:\/\/[^\s"'<>)\]}]+/;

/** The start of an output, with its first URL kept whole (the UI shows screenshots and exposed ports from it). */
function clipOutput(output: string): string {
  if (output.length <= CLIP_CHARS) return output;
  const match = URL_PATTERN.exec(output);
  if (!match) return output.slice(0, CLIP_CHARS);
  const end = match.index + match[0].length;
  if (end <= CLIP_CHARS) return output.slice(0, CLIP_CHARS);
  if (match.index < CLIP_CHARS) return output.slice(0, end);
  return `${output.slice(0, CLIP_CHARS)}\n${match[0]}`;
}

/** An input with every string over CLIP_CHARS cut to its start; `cut` says whether anything was. */
function clipInput(value: unknown, depth = 0): { value: unknown; cut: boolean } {
  if (typeof value === "string") return value.length > CLIP_CHARS ? { value: value.slice(0, CLIP_CHARS), cut: true } : { value, cut: false };
  if (!value || typeof value !== "object" || depth > 8) return { value, cut: false };
  let cut = false;
  if (Array.isArray(value)) {
    const items = value.map((item) => {
      const clipped = clipInput(item, depth + 1);
      cut ||= clipped.cut;
      return clipped.value;
    });
    return cut ? { value: items, cut } : { value, cut };
  }
  const record: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const clipped = clipInput(item, depth + 1);
    cut ||= clipped.cut;
    record[key] = clipped.value;
  }
  return cut ? { value: record, cut } : { value, cut };
}

/** A tool part as a clipped chat carries it: unchanged when nothing in it is long. */
export function clipToolPart(part: ToolPart): ToolPart {
  const output = part.output !== undefined && part.output.length > CLIP_CHARS ? clipOutput(part.output) : part.output;
  // Memory steps are short, and their pill shows the whole note without fetching it.
  const input = part.input === undefined || part.name.startsWith("memory_") ? { value: part.input, cut: false } : clipInput(part.input);
  if (output === part.output && !input.cut) return part;
  return {
    ...part,
    ...(input.cut ? { input: input.value, inputChars: typeof part.input === "string" ? part.input.length : JSON.stringify(part.input).length } : {}),
    ...(output !== part.output ? { output, outputChars: part.output!.length } : {}),
    clipped: true,
  };
}

/** A message as a clipped chat carries it. `finishedOnly`: only tool calls that aren't running anymore are clipped. */
export function clipMessage(message: Message, { finishedOnly = false } = {}): Message {
  let changed = false;
  const parts = message.parts.map((part) => {
    if (part.type !== "tool" || (finishedOnly && part.status === "running")) return part;
    const clipped = clipToolPart(part);
    changed ||= clipped !== part;
    return clipped;
  });
  return changed ? { ...message, parts } : message;
}

/** A chat's messages, clipped: finished ones only (a reply still being written stays whole). */
export function clipMessages(list: Message[]): Message[] {
  return list.map((message) => (message.status === "streaming" ? message : clipMessage(message)));
}
