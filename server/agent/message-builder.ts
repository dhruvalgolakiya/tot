import { randomUUID } from "node:crypto";
import type { Message, MessagePart, MessageStatus, RunEvent, Usage } from "../../shared/types.ts";
import type { ProviderEvent } from "./providers/types.ts";

const MAX_TOOL_OUTPUT_CHARS = 20_000;

type TextLikePart = Extract<MessagePart, { type: "text" | "reasoning" }>;
type ToolPart = Extract<MessagePart, { type: "tool" }>;

function clip(value: unknown, max: number): string {
  const text = String(value ?? "").split("\n")[0].trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Short human label for a tool call, shown on its card. */
export function toolTitle(name: string, input: unknown): string {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  switch (name) {
    case "computer_exec":
      return `Ran ${clip(args.command, 80)}`;
    case "computer_write_file":
      return `Wrote ${clip(args.path, 80)}`;
    case "computer_read_file":
      return `Read ${clip(args.path, 80)}`;
    case "computer_expose_port":
      return `Shared port ${clip(args.port, 8)}`;
    case "computer_info":
      return "Checked the computer";
    case "computer_screenshot":
      return "Looked at the screen";
    case "computer_click":
      return `${args.double ? "Double-clicked" : args.button === "right" ? "Right-clicked" : "Clicked"} at (${clip(args.x, 6)}, ${clip(args.y, 6)})`;
    case "computer_type":
      return `Typed “${clip(args.text, 60)}”`;
    case "computer_key":
      return `Pressed ${clip(args.keys, 40)}`;
    case "computer_scroll":
      return `Scrolled ${clip(args.direction, 8)}`;
    case "computer_open_url":
      return `Opened ${clip(args.url, 80)}`;
    case "routine_create":
      return `Scheduled “${clip(args.name, 50)}”`;
    case "routine_list":
      return "Checked routines";
    case "routine_delete":
      return "Removed a routine";
    case "memory_save":
      return "Memory updated";
    case "memory_search":
      return `Searched memory for “${clip(args.query, 60)}”`;
    case "memory_delete":
      return "Forgot a memory";
    case "email_inbox":
      return "Checked email";
    case "email_search":
      return args.query ? `Searched email for “${clip(args.query, 60)}”` : "Searched email";
    case "email_read":
      return "Read an email";
    case "email_send":
      return `Email to ${clip(Array.isArray(args.to) ? args.to.join(", ") : args.to, 60)}`;
    case "email_reply":
      return "Email reply";
    case "email_wait":
      return "Waited for an email";
    case "web_search":
      return args.query ? `Searched the web for “${clip(args.query, 60)}”` : "Searched the web";
    case "web_fetch":
      return args.url ? `Read ${clip(args.url, 80)}` : "Read a web page";
    case "task_start":
      return args.title ? `Started task “${clip(args.title, 60)}”` : "Started a task";
    case "task_spawn_many":
      return Array.isArray(args.sessions) ? `Started ${args.sessions.length} tasks` : "Started tasks";
    case "handoff_write":
      return "Wrote a handoff";
    case "task_list":
      return "Checked on its tasks";
    case "task_status":
      return "Checked on a task";
    case "task_message":
      return "Sent a task a note";
    case "task_update":
      return args.question ? "Asked you a question" : args.plan ? "Updated its plan" : "Noted its progress";
    case "task_finish":
      return args.outcome === "failed" ? "Reported the task failed" : "Finished the task";
    default:
      return name.includes("/") ? `Used ${name}` : name;
  }
}

/**
 * Folds a provider's normalized event stream into an assistant Message and
 * emits the matching RunEvents (part-start / part-delta / part-update).
 */
export class MessageBuilder {
  private readonly partIdsByBlock = new Map<string, string>();
  private openReasoning: { partId: string; startedAt: number } | null = null;

  constructor(
    readonly message: Message,
    private readonly emit: (event: RunEvent) => void,
  ) {}

  apply(event: ProviderEvent): void {
    switch (event.type) {
      case "text-delta":
        this.closeReasoning();
        this.appendText("text", event.blockId, event.delta);
        break;
      case "reasoning-delta":
        this.appendText("reasoning", event.blockId, event.delta);
        break;
      case "tool-start":
        this.closeReasoning();
        this.startTool(event.toolCallId, event.name, event.input);
        break;
      case "tool-end":
        this.endTool(event.toolCallId, event.output, event.isError);
        break;
      case "usage":
        this.message.usage = { ...this.message.usage, ...event.usage };
        this.emit({ type: "usage", usage: this.message.usage as Usage });
        break;
      case "session":
      case "error":
        break;
    }
  }

  /** Adds a one-line note to the reply, e.g. an automatic provider switch. */
  notice(kind: Extract<MessagePart, { type: "notice" }>["kind"], text: string): void {
    this.closeReasoning();
    const part: MessagePart = { type: "notice", id: `n_${randomUUID().slice(0, 12)}`, kind, text };
    this.message.parts.push(part);
    this.emit({ type: "part-start", part: { ...part } });
  }

  /** Adds a part built outside the provider stream (e.g. an approval request). */
  add(part: MessagePart): void {
    this.closeReasoning();
    this.message.parts.push(part);
    this.emit({ type: "part-start", part: { ...part } });
  }

  /** Replaces a part by id and tells listeners. */
  replace(part: MessagePart): void {
    const index = this.message.parts.findIndex((existing) => existing.id === part.id);
    if (index === -1) return;
    this.message.parts[index] = part;
    this.emit({ type: "part-update", part: { ...part } });
  }

  /** True once the reply has visible output (notices don't count). */
  get hasContent(): boolean {
    return this.message.parts.some((part) => part.type !== "notice");
  }

  /** Closes open parts and stamps the final status. */
  finish(status: MessageStatus, error?: string): Message {
    this.closeReasoning();
    for (const part of this.message.parts) {
      if (part.type === "tool" && part.status === "running") {
        part.status = "error";
        part.isError = true;
        part.output = part.output ?? (status === "stopped" ? "Stopped." : "Did not finish.");
        this.emit({ type: "part-update", part: { ...part } });
      }
    }
    this.message.status = status;
    if (error) this.message.error = error;
    return this.message;
  }

  private find<T extends MessagePart>(partId: string): T | undefined {
    return this.message.parts.find((part) => part.id === partId) as T | undefined;
  }

  private appendText(kind: "text" | "reasoning", blockId: string, delta: string): void {
    if (!delta) return;
    const key = `${kind}:${blockId}`;
    const existingId = this.partIdsByBlock.get(key);
    const existing = existingId ? this.find<TextLikePart>(existingId) : undefined;
    if (existing) {
      existing.text += delta;
      this.emit({ type: "part-delta", partId: existing.id, delta });
      return;
    }
    const part: TextLikePart = { type: kind, id: `${kind[0]}_${randomUUID().slice(0, 12)}`, text: delta };
    this.partIdsByBlock.set(key, part.id);
    this.message.parts.push(part);
    if (kind === "reasoning") {
      this.closeReasoning();
      this.openReasoning = { partId: part.id, startedAt: Date.now() };
    }
    this.emit({ type: "part-start", part: { ...part } });
  }

  private closeReasoning(): void {
    if (!this.openReasoning) return;
    const part = this.find<Extract<MessagePart, { type: "reasoning" }>>(this.openReasoning.partId);
    if (part) {
      part.durationMs = Date.now() - this.openReasoning.startedAt;
      this.emit({ type: "part-update", part: { ...part } });
    }
    this.openReasoning = null;
  }

  private startTool(toolCallId: string, name: string, input: unknown): void {
    const existing = this.find<ToolPart>(toolCallId);
    if (existing) {
      existing.input = input ?? existing.input;
      existing.title = toolTitle(existing.name, existing.input);
      this.emit({ type: "part-update", part: { ...existing } });
      return;
    }
    const part: ToolPart = { type: "tool", id: toolCallId, name, title: toolTitle(name, input), input, status: "running" };
    this.message.parts.push(part);
    this.emit({ type: "part-start", part: { ...part } });
  }

  private endTool(toolCallId: string, output: string | undefined, isError: boolean | undefined): void {
    let part = this.find<ToolPart>(toolCallId);
    if (!part) {
      this.startTool(toolCallId, "tool", undefined);
      part = this.find<ToolPart>(toolCallId)!;
    }
    part.status = isError ? "error" : "done";
    part.isError = Boolean(isError);
    if (output !== undefined) {
      part.output =
        output.length > MAX_TOOL_OUTPUT_CHARS
          ? `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (${output.length - MAX_TOOL_OUTPUT_CHARS} more characters)`
          : output;
    }
    this.emit({ type: "part-update", part: { ...part } });
  }
}
