import type { LucideIcon } from "lucide-react";
import { CircleAlert, CircleCheck, CirclePause, CircleStop, CircleX, Clock, LoaderCircle } from "lucide-react";
import clsx from "clsx";
import type { TaskStatus } from "@tot/shared/types";
import { TASK_STATUS_LABELS, taskBadgeTone, taskTone } from "../../lib/tasks";
import { Badge } from "../ui/Badge";
import { StatusDot } from "../ui/StatusDot";

/** The small status dot used in rows (pulses while the task works). */
export function TaskDot({ status }: { status: TaskStatus }) {
  const { tone, pulse } = taskTone(status);
  return (
    <span title={TASK_STATUS_LABELS[status]} className="inline-flex">
      <StatusDot tone={tone} pulse={pulse} />
    </span>
  );
}

/** The status pill used on cards and in the task header. */
export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <Badge tone={taskBadgeTone(status)}>{TASK_STATUS_LABELS[status]}</Badge>;
}

const STATUS_ICONS: Record<TaskStatus, LucideIcon> = {
  queued: Clock,
  running: LoaderCircle,
  "needs-input": CircleAlert,
  paused: CirclePause,
  done: CircleCheck,
  failed: CircleX,
  stopped: CircleStop,
  interrupted: CirclePause,
};

/**
 * A status as a 16px icon in neutral grey (a spinner while it works): the status of a row in a task list, named in
 * its tooltip. Only "failed" and "needs you" take a color.
 */
export function TaskStatusIcon({ status, label, className }: { status: TaskStatus; label?: string; className?: string }) {
  const Icon = STATUS_ICONS[status];
  return (
    <span role="img" aria-label={label ?? TASK_STATUS_LABELS[status]} title={label ?? TASK_STATUS_LABELS[status]} className={clsx("grid size-5 shrink-0 place-items-center", className)}>
      <Icon
        aria-hidden="true"
        className={clsx(
          "size-4",
          status === "running" && "animate-spin",
          status === "failed" ? "text-danger" : status === "needs-input" || status === "interrupted" ? "text-warning" : "text-fg-subtle",
        )}
      />
    </span>
  );
}
