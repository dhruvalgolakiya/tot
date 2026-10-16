import clsx from "clsx";
import { CirclePause } from "lucide-react";
import type { QueueHold } from "@tot/shared/types";
import { PROVIDER_LABELS } from "../../lib/models";
import { resumeQueue } from "../../store";
import { Tip } from "../ui/Tip";

/**
 * "Queue paused: Claude kept failing. Resume": a task failed on repeated errors from its provider,
 * so the agent's queue waits instead of failing every task the same way. Hover shows the error.
 */
export function QueueHoldLine({
  agentId,
  hold,
  className,
  focusable = true,
}: {
  agentId: string;
  hold: QueueHold;
  className?: string;
  /** Off where a container focuses its first item on open (the queue popover), so the error doesn't pop up by itself. */
  focusable?: boolean;
}) {
  const who = hold.provider ? PROVIDER_LABELS[hold.provider] : "Tasks";
  return (
    <div className={clsx("flex items-start gap-1.5 py-1.5 text-xs leading-snug text-fg-muted", className)}>
      <CirclePause className="mt-px size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
      <Tip content={hold.reason} align="start">
        <span tabIndex={focusable ? 0 : -1} className="min-w-0 flex-1 cursor-default rounded-sm">
          Queue paused: {who} kept failing.
        </span>
      </Tip>
      <button type="button" onClick={() => void resumeQueue(agentId)} className="shrink-0 rounded-sm font-medium text-fg hover:underline">
        Resume
      </button>
    </div>
  );
}
