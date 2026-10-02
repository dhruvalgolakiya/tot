import { useEffect, useState } from "react";
import clsx from "clsx";
import { toast } from "sonner";
import type { LucideIcon } from "lucide-react";
import { ExternalLink, ShieldAlert, ShieldCheck, ShieldOff, ShieldQuestion, ShieldX } from "lucide-react";
import type { ApprovalField, MessagePart } from "@shared/types";
import { api, ApiError } from "../lib/api";
import { toMs, truncate } from "../lib/format";
import { notifyError, useStore } from "../store";
import { Button } from "./ui/Button";
import { Field } from "./ui/Field";
import { Select } from "./ui/Select";
import { Switch } from "./ui/Switch";

type Approval = Extract<MessagePart, { type: "approval" }>;
type FieldValue = string | number | boolean;

type ApprovalCardProps = {
  part: Approval;
  conversationId: string;
};

/** Resolved on top of `part.status`: "inactive" covers a pending card whose run isn't live anymore. */
type DisplayStatus = "pending" | "accepted" | "declined" | "expired" | "inactive";

const STATUS_ICON: Record<DisplayStatus, LucideIcon> = {
  pending: ShieldQuestion,
  accepted: ShieldCheck,
  declined: ShieldX,
  expired: ShieldAlert,
  inactive: ShieldOff,
};

const STATUS_LABEL: Record<Exclude<DisplayStatus, "pending">, string> = {
  accepted: "Approved",
  declined: "Denied",
  expired: "Expired — declined automatically",
  inactive: "No longer active",
};

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const SHORT_WAIT_MS = 2 * 60_000;

function formatCountdown(expiresAt: number, now: number): string {
  const remaining = toMs(expiresAt) - now;
  if (remaining <= 0) return "expiring…";
  // Approvals usually expire within a minute, so under 2 minutes left show a
  // live per-second countdown instead of the coarser "expires in X min".
  if (remaining < SHORT_WAIT_MS) return `${Math.max(1, Math.ceil(remaining / 1000))}s`;
  const minutes = Math.round(remaining / 60_000);
  if (minutes < 60) return `expires in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "expires in 1h" : `expires in ${hours}h`;
}

function initialValues(part: Approval): Record<string, FieldValue> {
  if (part.kind !== "form" || !part.fields) return {};
  const values: Record<string, FieldValue> = {};
  for (const field of part.fields) {
    if (field.default !== undefined) values[field.name] = field.default;
    else if (field.type === "boolean") values[field.name] = false;
    else values[field.name] = "";
  }
  return values;
}

const LONG_MESSAGE_CHARS = 320;
const LONG_MESSAGE_LINES = 6;

/**
 * A tool paused mid-turn to ask the user something (an MCP elicitation). Calm,
 * compact card in the message flow — matches ToolPart/NoticePart density, not
 * a modal. Collapses to a one-line summary once it's no longer pending.
 */
export function ApprovalCard({ part, conversationId }: ApprovalCardProps) {
  const runId = useStore((s) => s.activeRuns[conversationId]?.runId ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [optimistic, setOptimistic] = useState<"accepted" | "declined" | null>(null);
  const [forceInactive, setForceInactive] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [values, setValues] = useState<Record<string, FieldValue>>(() => initialValues(part));

  // A real status update from the server (the common case, and what ends a
  // local 404-driven "inactive" override too) always wins over our guesses.
  useEffect(() => {
    setOptimistic(null);
    setForceInactive(false);
  }, [part.status]);

  const status: DisplayStatus = forceInactive
    ? "inactive"
    : optimistic
      ? optimistic
      : part.status === "pending" && !runId
        ? "inactive"
        : part.status;
  const actionable = status === "pending";

  useEffect(() => {
    if (!actionable) return;
    // Tick every second once under 2 minutes remain, for a live countdown;
    // otherwise the coarser 30s cadence is plenty. Re-evaluated on every tick
    // so the cadence speeds up automatically as the deadline nears.
    const remaining = toMs(part.expiresAt) - now;
    const interval = remaining < SHORT_WAIT_MS ? 1_000 : 30_000;
    const id = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(id);
  }, [actionable, now, part.expiresAt]);

  async function respond(decision: "accept" | "decline", answerValues?: Record<string, FieldValue>) {
    if (!runId || submitting) return;
    setSubmitting(true);
    try {
      await api.answerApproval(runId, part.id, answerValues ? { decision, values: answerValues } : { decision });
      setOptimistic(decision === "accept" ? "accepted" : "declined");
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        toast.error("This request already ended");
        setForceInactive(true);
      } else {
        notifyError(error);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!actionable) {
    const Icon = STATUS_ICON[status];
    return (
      <div className="flex max-w-md min-w-0 items-center gap-2 rounded-2xl border border-edge bg-elevated p-3 text-xs">
        <Icon className={clsx("size-4 shrink-0", status === "accepted" ? "text-success" : "text-fg-subtle")} />
        <span className="min-w-0 truncate text-fg-subtle">
          <span className="font-medium text-fg-muted">{STATUS_LABEL[status]}</span>
          {" · "}
          {truncate(part.message, 140)}
        </span>
      </div>
    );
  }

  const Icon = STATUS_ICON.pending;
  const fields = part.kind === "form" ? (part.fields ?? []) : [];
  const isLong =
    part.message.length > LONG_MESSAGE_CHARS || (part.message.match(/\n/g)?.length ?? 0) >= LONG_MESSAGE_LINES;
  const formValid = fields.every((field) => {
    if (!field.required || field.type === "boolean") return true;
    const value = values[field.name];
    return value !== undefined && value !== "";
  });

  function buildFormValues(): Record<string, FieldValue> {
    const result: Record<string, FieldValue> = {};
    for (const field of fields) {
      const raw = values[field.name];
      if (field.type === "number") result[field.name] = raw === "" || raw === undefined ? 0 : Number(raw);
      else if (field.type === "boolean") result[field.name] = Boolean(raw);
      else result[field.name] = raw === undefined ? "" : String(raw);
    }
    return result;
  }

  return (
    <div className="max-w-md space-y-3 rounded-2xl border border-edge bg-elevated px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-xs text-fg-subtle">
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate font-medium">{part.source}</span>
      </div>

      <div>
        <p
          className={clsx(
            "text-sm leading-relaxed whitespace-pre-wrap text-fg [overflow-wrap:anywhere]",
            !expanded && isLong && "line-clamp-6",
          )}
        >
          {part.message}
        </p>
        {isLong && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="mt-1 text-xs font-medium text-fg-subtle transition-colors hover:text-fg-muted"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>

      {part.kind === "url" && part.url && (
        <div className="truncate rounded-lg bg-fill px-2.5 py-1.5 text-xs text-fg-muted">
          {hostnameOf(part.url)}
        </div>
      )}

      {part.kind === "form" && fields.length > 0 && (
        <div className="space-y-3">
          {fields.map((field) => (
            <ApprovalFieldInput
              key={field.name}
              field={field}
              value={values[field.name]}
              disabled={submitting}
              onChange={(value) => setValues((previous) => ({ ...previous, [field.name]: value }))}
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {part.kind === "confirm" && (
          <>
            <Button size="sm" variant="primary" disabled={submitting} onClick={() => void respond("accept")}>
              Approve
            </Button>
            <Button size="sm" variant="ghost" disabled={submitting} onClick={() => void respond("decline")}>
              Deny
            </Button>
          </>
        )}
        {part.kind === "url" && (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={submitting}
              onClick={() => part.url && window.open(part.url, "_blank", "noopener")}
            >
              <ExternalLink /> Open
            </Button>
            <Button size="sm" variant="secondary" disabled={submitting} onClick={() => void respond("accept")}>
              I'm done
            </Button>
            <Button size="sm" variant="ghost" disabled={submitting} onClick={() => void respond("decline")}>
              Cancel
            </Button>
          </>
        )}
        {part.kind === "form" && (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={submitting || !formValid}
              onClick={() => void respond("accept", buildFormValues())}
            >
              Submit
            </Button>
            <Button size="sm" variant="ghost" disabled={submitting} onClick={() => void respond("decline")}>
              Cancel
            </Button>
          </>
        )}
      </div>

      <p className="text-xs text-fg-subtle tabular-nums">Waiting for you · {formatCountdown(part.expiresAt, now)}</p>
    </div>
  );
}

type ApprovalFieldInputProps = {
  field: ApprovalField;
  value: FieldValue | undefined;
  disabled: boolean;
  onChange: (value: FieldValue) => void;
};

function ApprovalFieldInput({ field, value, disabled, onChange }: ApprovalFieldInputProps) {
  const id = `approval-field-${field.name}`;
  const label = (
    <>
      {field.label}
      {field.required && (
        <span className="ml-0.5 text-fg-subtle" aria-hidden="true">
          *
        </span>
      )}
    </>
  );

  if (field.type === "boolean") {
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <label htmlFor={id} className="block text-sm font-medium text-fg">
            {label}
          </label>
          {field.description && <p className="text-xs leading-relaxed text-fg-subtle">{field.description}</p>}
        </div>
        <Switch id={id} checked={Boolean(value)} onCheckedChange={onChange} disabled={disabled} label={field.label} />
      </div>
    );
  }

  if (field.type === "enum") {
    return (
      <Field label={label} htmlFor={id} hint={field.description}>
        <Select
          id={id}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onValueChange={onChange}
          placeholder="Select…"
          options={[
            { value: "", label: "Select…", disabled: field.required },
            ...(field.options?.map((option) => ({ value: option, label: option })) ?? []),
          ]}
        />
      </Field>
    );
  }

  return (
    <Field label={label} htmlFor={id} hint={field.description}>
      <input
        id={id}
        type={field.type === "number" ? "number" : "text"}
        value={value === undefined ? "" : String(value)}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="input"
      />
    </Field>
  );
}
