import type { Message } from "@tot/shared/types";
import { messageText } from "../data/messages.ts";

/**
 * Context selection (module 05): which earlier messages a model gets when it can't resume its own
 * session — a provider switch mid-chat, a fork that can't fork natively, a merge-back, an attached
 * chat. It always keeps the first user message, the latest user message and the latest reply, then
 * adds messages from newest to oldest until the budget is used: whole messages, in their original
 * order, never cut. It ends by saying how many were left out and how to read them with chat_read.
 */

/** Tokens of earlier conversation a provider switch carries over. */
export const SWITCH_BUDGET = 16_000;
/** Tokens of each chat attached to a message as context. */
export const ATTACHED_BUDGET = 4_000;
/** Tokens of the last exchange that go with a handoff packet. */
export const HANDOFF_TAIL_BUDGET = 4_000;

/** Rough token count: characters / 4. */
export const tokens = (text: string): number => Math.ceil(text.length / 4);

export interface ContextMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface Selection {
  /** The selected messages as a <conversation> block, plus the omitted-messages line when some were left out. */
  text: string;
  included: number;
  omitted: number;
}

/** A chat's messages that say something, in order. */
export function contextMessages(history: Message[]): ContextMessage[] {
  return history.map((m) => ({ id: m.id, role: m.role, text: messageText(m) })).filter((m) => m.text);
}

const render = (m: ContextMessage) => `<${m.role}>\n${m.text}\n</${m.role}>`;
const cost = (m: ContextMessage) => render(m).length + 1;

/** Cuts a message down to `chars` (only ever one that must be kept but can't fit whole), saying so. */
function clipToFit(m: ContextMessage, chars: number, chatId: string): ContextMessage {
  if (cost(m) <= chars) return m;
  const note = `\n[… cut to fit; read it whole with chat_read { chatId: "${chatId}" }]`;
  return { ...m, text: `${m.text.slice(0, Math.max(0, chars - note.length - 40)).trimEnd()}${note}` };
}

/** Splits `room` between messages of these sizes: each one smaller than an even share gets its size, the rest split what's left. */
function shares(sizes: number[], room: number): number[] {
  const out = sizes.map(() => 0);
  let open = sizes.map((_, i) => i);
  let left = room;
  while (open.length) {
    const even = Math.floor(left / open.length);
    const small = open.filter((i) => sizes[i]! <= even);
    if (!small.length) {
      for (const i of open) out[i] = even;
      break;
    }
    for (const i of small) {
      out[i] = sizes[i]!;
      left -= sizes[i]!;
    }
    open = open.filter((i) => !small.includes(i));
  }
  return out;
}

export function selectContext(messages: ContextMessage[], { budgetTokens, chatId }: { budgetTokens: number; chatId: string }): Selection {
  if (!messages.length) return { text: "", included: 0, omitted: 0 };
  // Room for the messages, leaving some for the <conversation> tags, gap markers and the omitted-messages line.
  const room = budgetTokens * 4 - 400;
  const firstUser = messages.findIndex((m) => m.role === "user");
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  const lastReply = messages.findLastIndex((m) => m.role === "assistant");
  const kept = [...new Set([firstUser, lastUser, lastReply].filter((i) => i >= 0))];
  // The kept ones go in whole when they fit together; otherwise the short ones stay whole and the long ones share the rest.
  const fits = kept.reduce((sum, i) => sum + cost(messages[i]!), 0) <= room;
  const limits = fits ? null : shares(kept.map((i) => cost(messages[i]!)), room);
  const list = limits ? messages.map((m, i) => (kept.includes(i) ? clipToFit(m, limits[kept.indexOf(i)]!, chatId) : m)) : messages;
  const chosen = new Set(kept);
  let used = kept.reduce((sum, i) => sum + cost(list[i]!), 0);
  // Then the newest first, while whole messages fit.
  for (let i = list.length - 1; i >= 0; i--) {
    if (chosen.has(i)) continue;
    if (used + cost(list[i]!) > room) break;
    chosen.add(i);
    used += cost(list[i]!);
  }

  const lines: string[] = [];
  let gap = 0;
  let firstAfterGap: string | null = null;
  list.forEach((m, i) => {
    if (!chosen.has(i)) {
      gap++;
      return;
    }
    if (gap) {
      lines.push(`[… ${gap} message${gap === 1 ? "" : "s"} left out here …]`);
      firstAfterGap ??= m.id;
      gap = 0;
    }
    lines.push(render(m));
  });
  const omitted = list.length - chosen.size;
  const pointer = `chat_read { chatId: "${chatId}"${firstAfterGap ? `, before: "${firstAfterGap}"` : ""} }`;
  const text = `<conversation>\n${lines.join("\n")}\n</conversation>${
    omitted ? `\n[${omitted} earlier message${omitted === 1 ? " was" : "s were"} left out to keep this short. Read them with ${pointer} when they matter.]` : ""
  }`;
  return { text, included: chosen.size, omitted };
}

/** The last user message that came from a person (not one of TOT's own turns) and the last reply, verbatim within the budget. */
export function lastExchange(history: Message[], { budgetTokens, chatId }: { budgetTokens: number; chatId: string }): string {
  const user = history.findLast((m) => m.role === "user" && !m.auto && messageText(m));
  const reply = history.findLast((m) => m.role === "assistant" && messageText(m));
  const picked = contextMessages([user, reply].filter((m): m is Message => Boolean(m)).sort((a, b) => a.createdAt - b.createdAt));
  if (!picked.length) return "";
  const share = Math.floor((budgetTokens * 4) / picked.length);
  return picked.map((m) => render(clipToFit(m, share, chatId))).join("\n");
}
