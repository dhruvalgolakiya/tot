import { randomUUID } from "node:crypto";
import type { Message, MessagePart, ProviderId } from "@tot/shared/types";
import { clipToolOutput } from "../agent/message-builder.ts";
import { toAttachment, uploads } from "../data/uploads.ts";
import type { SessionEvent, SessionImage } from "./events.ts";

/** What the list shows of a session, and what an import needs to know before it reads the session whole. */
export interface SessionSummary {
  sessionId: string | null;
  cwd: string | null;
  /** Its last recorded branch. */
  branch: string | null;
  /** The model its last reply used. */
  model: string | null;
  /** Its own name, if it has one. */
  title: string | null;
  firstPrompt: string;
  /** User prompts and replies, as an import makes them. */
  messages: number;
  firstAt: number;
  lastAt: number;
  /** A subagent's thread, not one of the user's. */
  subagent: boolean;
}

export async function summarize(events: AsyncIterable<SessionEvent>): Promise<SessionSummary> {
  const summary: SessionSummary = {
    sessionId: null,
    cwd: null,
    branch: null,
    model: null,
    title: null,
    firstPrompt: "",
    messages: 0,
    firstAt: 0,
    lastAt: 0,
    subagent: false,
  };
  let titleRank = 0;
  let replying = false;
  const seen = (at: number) => {
    if (!at) return;
    if (!summary.firstAt || at < summary.firstAt) summary.firstAt = at;
    if (at > summary.lastAt) summary.lastAt = at;
  };
  for await (const event of events) {
    switch (event.type) {
      case "meta":
        summary.sessionId ??= event.sessionId ?? null;
        summary.cwd ??= event.cwd ?? null;
        if (event.branch) summary.branch = event.branch;
        if (event.model) summary.model = event.model;
        if (event.subagent) summary.subagent = true;
        break;
      case "title":
        if (event.rank >= titleRank) {
          titleRank = event.rank;
          summary.title = event.text.trim();
        }
        break;
      case "prompt":
        summary.messages++;
        if (!summary.firstPrompt) summary.firstPrompt = event.text || "(an image)";
        replying = false;
        seen(event.at);
        break;
      case "text":
      case "reasoning":
      case "tool-start":
      case "notice":
        // A reply: the first of its parts after a prompt counts it.
        if (!replying) summary.messages++;
        replying = true;
        seen(event.at);
        break;
    }
  }
  return summary;
}

type ToolPart = Extract<MessagePart, { type: "tool" }>;
type TextPart = Extract<MessagePart, { type: "text" | "reasoning" }>;

/** Most images an import keeps (each as an upload), and the biggest one. */
const MAX_IMAGES = 40;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Longest string kept in a tool call's input (a whole file written, a big edit). */
const MAX_INPUT_CHARS = 20_000;

function clipInput(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > MAX_INPUT_CHARS ? `${value.slice(0, MAX_INPUT_CHARS)}\n… (${value.length - MAX_INPUT_CHARS} more characters)` : value;
  if (!value || typeof value !== "object" || depth > 6) return value;
  if (Array.isArray(value)) return value.map((item) => clipInput(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipInput(item, depth + 1)]));
}

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/**
 * Builds TOT messages from a session's events: a user message per prompt, and one reply per turn holding its text,
 * reasoning, tool calls (with their outputs, cut to what a live reply keeps) and notices, in order. Times come from
 * the session; they never go backwards, so the chat reads in the order the session happened.
 */
export class TranscriptBuilder {
  readonly messages: Message[] = [];
  private reply: Message | null = null;
  private readonly tools = new Map<string, ToolPart>();
  /** The reply's last text or reasoning part, and the block it came from. */
  private open: { part: TextPart; block: string } | null = null;
  private lastAt = 0;
  private images = 0;
  /** The model the session used last, which its replies name. */
  private model: string | null = null;

  /** The messages' conversationId is left empty: the chat is made after the session has been read. */
  constructor(private readonly by: { provider: ProviderId; account: string }) {}

  private time(at: number): number {
    this.lastAt = Math.max(at || this.lastAt, this.lastAt);
    return this.lastAt;
  }

  private replyFor(at: number): Message {
    if (!this.reply) {
      this.reply = {
        id: randomUUID(),
        conversationId: "",
        role: "assistant",
        parts: [],
        status: "complete",
        provider: this.by.provider,
        account: this.by.account,
        ...(this.model ? { model: this.model } : {}),
        createdAt: this.time(at),
      };
      this.messages.push(this.reply);
    }
    return this.reply;
  }

  private file(image: SessionImage, index: number): MessagePart | null {
    if (this.images >= MAX_IMAGES) return null;
    const data = Buffer.from(image.data, "base64");
    if (!data.length || data.length > MAX_IMAGE_BYTES) return null;
    this.images++;
    const record = uploads.save({ name: `image-${index + 1}.${EXTENSIONS[image.mimeType] ?? "png"}`, mimeType: image.mimeType, data });
    return { type: "file", id: randomUUID(), attachment: toAttachment(record) };
  }

  /** A note at the very top of the chat's first reply (or a reply of its own when the session has none). */
  opening(text: string): void {
    const first = this.messages.find((message) => message.role === "assistant");
    const part: MessagePart = { type: "notice", id: `n_${randomUUID().slice(0, 12)}`, kind: "info", text };
    if (first) first.parts.unshift(part);
    else this.replyFor(this.lastAt).parts.push(part);
  }

  add(event: SessionEvent): void {
    switch (event.type) {
      case "meta":
        if (event.model) this.model = event.model;
        break;
      case "prompt": {
        this.reply = null;
        const files = event.images.map((image, i) => this.file(image, i)).filter((part): part is MessagePart => part !== null);
        const parts: MessagePart[] = [...files, ...(event.text ? [{ type: "text" as const, id: randomUUID(), text: event.text }] : [])];
        if (!parts.length) parts.push({ type: "text", id: randomUUID(), text: "(an image)" });
        this.messages.push({ id: randomUUID(), conversationId: "", role: "user", parts, status: "complete", createdAt: this.time(event.at) });
        break;
      }
      case "text":
      case "reasoning": {
        const reply = this.replyFor(event.at);
        // Text blocks of one reply message in a row (each its own record in Claude Code's files) read as one part.
        if (this.open?.block === event.block && this.open.part.type === event.type && reply.parts.at(-1) === this.open.part) {
          this.open.part.text += `\n\n${event.text}`;
          break;
        }
        const part: TextPart =
          event.type === "text"
            ? { type: "text", id: `t_${randomUUID().slice(0, 12)}`, text: event.text }
            : { type: "reasoning", id: `r_${randomUUID().slice(0, 12)}`, text: event.text, ...(event.durationMs ? { durationMs: event.durationMs } : {}) };
        reply.parts.push(part);
        this.open = { part, block: event.block };
        break;
      }
      case "tool-start": {
        if (this.tools.has(event.id)) break;
        const part: ToolPart = {
          type: "tool",
          id: event.id,
          name: event.name,
          ...(event.title ? { title: event.title } : {}),
          ...(event.input !== undefined ? { input: clipInput(event.input) } : {}),
          status: "done",
        };
        this.tools.set(event.id, part);
        this.replyFor(event.at).parts.push(part);
        break;
      }
      case "tool-end": {
        const part = this.tools.get(event.id);
        if (!part) break;
        if (event.output) part.output = clipToolOutput(event.output);
        if (event.isError) {
          part.status = "error";
          part.isError = true;
        }
        break;
      }
      case "notice":
        this.replyFor(event.at).parts.push({ type: "notice", id: `n_${randomUUID().slice(0, 12)}`, kind: "info", text: event.text });
        break;
    }
  }
}
