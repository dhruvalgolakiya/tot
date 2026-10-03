import type { TaskStatus } from "@shared/types";
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
