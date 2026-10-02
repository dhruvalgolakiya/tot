import { randomUUID } from "node:crypto";
import type { ApprovalAnswer, ApprovalField, MessagePart } from "../../shared/types.ts";
import { appEvents } from "../app-events.ts";
import { messages } from "../data/messages.ts";
import type { MessageBuilder } from "./message-builder.ts";
import type { ElicitAnswer, ElicitRequest } from "./providers/types.ts";
import type { Run } from "./runs.ts";

/**
 * Approval requests: when a tool (an MCP server) asks the user something mid-turn
 * (MCP elicitation), the turn waits while the chat shows a card; the user's answer
 * goes back to the tool. Unanswered requests are declined after a while.
 */

type ApprovalPart = Extract<MessagePart, { type: "approval" }>;

/**
 * How long a request waits for the user. MCP servers built on the official SDKs give up on an
 * unanswered request after 60 seconds (Executor can't be configured otherwise), so the card
 * expires just before that rather than promising a wait the tool won't honour.
 */
const WAIT_MS = 55_000;
const UNATTENDED_WAIT_MS = 55_000;

const pending = new Map<string, { runId: string; settle: (answer: ApprovalAnswer | null) => void }>();

/** Display names for MCP servers that ask. */
const SOURCE_NAMES: Record<string, string> = { apps: "Apps", tot: "TOT", github: "GitHub" };

type Primitive = { type?: string; title?: string; description?: string; enum?: unknown[]; oneOf?: { const?: unknown }[]; default?: unknown };

/** The form fields TOT can show; null when the schema asks for something it can't render. */
export function toFields(schema: unknown): ApprovalField[] | null {
  const object = (schema ?? {}) as { properties?: Record<string, Primitive>; required?: string[] };
  const required = new Set(Array.isArray(object.required) ? object.required : []);
  const fields: ApprovalField[] = [];
  for (const [name, raw] of Object.entries(object.properties ?? {})) {
    const options = (raw.enum ?? raw.oneOf?.map((choice) => choice.const))?.filter((value): value is string => typeof value === "string");
    const type: ApprovalField["type"] | null = options?.length
      ? "enum"
      : raw.type === "string"
        ? "string"
        : raw.type === "number" || raw.type === "integer"
          ? "number"
          : raw.type === "boolean"
            ? "boolean"
            : null;
    if (!type) return null;
    const value = raw.default;
    fields.push({
      name,
      label: raw.title || name,
      type,
      required: required.has(name),
      ...(raw.description ? { description: raw.description } : {}),
      ...(options?.length ? { options } : {}),
      ...(typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? { default: value } : {}),
    });
  }
  return fields;
}

/**
 * Builds the elicitation handler for one turn: shows the card, waits for the user
 * (or the deadline, or the turn being stopped), and turns the answer into MCP's shape.
 */
export function makeElicitor(opts: {
  run: Run;
  builder: MessageBuilder;
  agentId: string;
  unattended: boolean;
  /** Override how long to wait (tests). */
  waitMs?: number;
}): (request: ElicitRequest, signal?: AbortSignal) => Promise<ElicitAnswer> {
  const { run, builder, agentId } = opts;
  return async (request, signal) => {
    const fields = request.mode === "url" ? [] : toFields(request.schema);
    // A form TOT can't render: say no rather than guess.
    if (!fields) return { action: "decline" };
    const part: ApprovalPart = {
      type: "approval",
      id: `a_${randomUUID().slice(0, 12)}`,
      source: SOURCE_NAMES[request.source] ?? request.source,
      message: request.message.trim() || "A tool needs your OK to continue.",
      kind: request.mode === "url" ? "url" : fields.length ? "form" : "confirm",
      ...(request.mode === "url" && request.url ? { url: request.url } : {}),
      ...(fields.length ? { fields } : {}),
      status: "pending",
      expiresAt: Date.now() + (opts.waitMs ?? (opts.unattended ? UNATTENDED_WAIT_MS : WAIT_MS)),
    };
    builder.add(part);
    messages.save(builder.message);
    const announce = (isPending: boolean) =>
      appEvents.publish({
        type: "approval",
        agentId,
        conversationId: run.conversationId,
        runId: run.id,
        partId: part.id,
        message: part.message,
        pending: isPending,
      });
    announce(true);

    const answer = await new Promise<ApprovalAnswer | null>((resolve) => {
      const stopSignals = [run.controller.signal, signal].filter((s): s is AbortSignal => Boolean(s));
      const settle = (value: ApprovalAnswer | null) => {
        clearTimeout(timer);
        for (const s of stopSignals) s.removeEventListener("abort", onAbort);
        pending.delete(part.id);
        resolve(value);
      };
      const onAbort = () => settle(null);
      const timer = setTimeout(() => settle(null), part.expiresAt - Date.now());
      for (const s of stopSignals) s.addEventListener("abort", onAbort, { once: true });
      pending.set(part.id, { runId: run.id, settle });
    });

    builder.replace({ ...part, status: answer ? (answer.decision === "accept" ? "accepted" : "declined") : "expired" });
    messages.save(builder.message);
    announce(false);
    if (!answer) return { action: run.controller.signal.aborted ? "cancel" : "decline" };
    if (answer.decision === "decline") return { action: "decline" };
    return { action: "accept", content: part.kind === "form" ? cleanValues(fields, answer.values ?? {}) : {} };
  };
}

/** Keeps only declared fields, with the declared types. */
function cleanValues(fields: ApprovalField[], values: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined || value === "") continue;
    if (field.type === "number") {
      const n = Number(value);
      if (Number.isFinite(n)) out[field.name] = n;
    } else if (field.type === "boolean") {
      out[field.name] = value === true || value === "true";
    } else if (field.type === "enum") {
      if (typeof value === "string" && field.options?.includes(value)) out[field.name] = value;
    } else {
      out[field.name] = String(value);
    }
  }
  return out;
}

/** The user's answer to a pending request; false when it already ended (answered, expired, stopped). */
export function answerApproval(runId: string, partId: string, answer: ApprovalAnswer): boolean {
  const waiting = pending.get(partId);
  if (!waiting || waiting.runId !== runId) return false;
  waiting.settle(answer);
  return true;
}
