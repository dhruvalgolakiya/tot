import { useState } from "react";
import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import { useNow } from "../../hooks/useNow";
import { roleLine } from "../../lib/orchestration";
import { isOpenTask, isTask, taskElapsed } from "../../lib/tasks";
import { navigateToConversation, useStore } from "../../store";
import { cardClass } from "../ui/Card";
import { TaskDot, TaskStatusBadge } from "../tasks/TaskStatus";

/** Several tasks started together, stacked into one card: "3 tasks · 2 running", each a row that opens it. */
export function TaskGroupCard({ taskIds }: { taskIds: string[] }) {
  const [open, setOpen] = useState(true);
  const all = useStore((s) => s.conversations);
  const group = taskIds.map((id) => all.find((c) => c.id === id)).filter(isTask);
  const running = group.filter((task) => task.task.status === "running" || task.task.status === "needs-input").length;
  const finished = group.filter((task) => !isOpenTask(task.task.status)).length;
  const combining = group.some((task) => task.task.then === "synthesize");
  const now = useNow(running > 0);
  const summary = [
    `${group.length} tasks`,
    running ? `${running} running` : null,
    finished === group.length ? "all finished" : finished ? `${finished} finished` : null,
    combining ? "combined here when done" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={cardClass({ padding: "none", className: "max-w-xl overflow-hidden" })}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-hover focus-visible:-outline-offset-2"
      >
        <ChevronRight className={clsx("size-3.5 shrink-0 text-fg-subtle transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{summary}</span>
      </button>
      {open && (
        <ul className="divide-y divide-hairline border-t border-hairline">
          {group.map((task) => {
            const role = roleLine(task.task.role, task.task.tier);
            const elapsed = taskElapsed(task.task, now);
            return (
              <li key={task.id}>
                <button
                  type="button"
                  onClick={() => navigateToConversation(task.id)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-hover focus-visible:-outline-offset-2"
                >
                  <TaskDot status={task.task.status} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui text-fg">{task.title}</span>
                    <span className="block truncate text-xs text-fg-subtle">
                      {[role, isOpenTask(task.task.status) ? task.task.progress : task.task.result?.summary ?? task.task.summary].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  {elapsed && <span className="shrink-0 text-xs text-fg-subtle tabular-nums">{elapsed}</span>}
                  <TaskStatusBadge status={task.task.status} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
