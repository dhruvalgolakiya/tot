import { useState } from "react";
import clsx from "clsx";
import { DropdownMenu } from "radix-ui";
import { ChevronRight, CircleStop, Ellipsis, Pause, Play } from "lucide-react";
import type { TaskStatus } from "@shared/types";
import { useNow } from "../../hooks/useNow";
import { roleLine } from "../../lib/orchestration";
import { isOpenTask, isTask, taskElapsed, taskLine, type TaskConversation } from "../../lib/tasks";
import { comparePath } from "../../lib/router";
import { navigateToCompare, navigateToConversation, pauseTask, resumeTask, stopTask, useStore } from "../../store";
import { IconButton } from "../ui/IconButton";
import { ledgerRowClass } from "../ui/Ledger";
import { TaskStatusIcon } from "../tasks/TaskStatus";

/** The header's counts, in this order, e.g. "6 tasks · 1 running · 4 done · 1 paused" (only states some task is in). */
const COUNTS: [TaskStatus, string][] = [
  ["needs-input", "need you"],
  ["running", "running"],
  ["queued", "queued"],
  ["interrupted", "cut off"],
  ["paused", "paused"],
  ["done", "done"],
  ["failed", "failed"],
  ["stopped", "stopped"],
];

/** Several tasks started together, stacked into one card: "6 tasks · 4 done · 2 paused", each a row that opens it. */
export function TaskGroupCard({ taskIds }: { taskIds: string[] }) {
  const [open, setOpen] = useState(true);
  const all = useStore((s) => s.conversations);
  const group = taskIds.map((id) => all.find((c) => c.id === id)).filter(isTask);
  const running = group.some((task) => task.task.status === "running");
  const working = group.some((task) => isOpenTask(task.task.status));
  const combining = working && group.some((task) => task.task.then === "synthesize");
  // A best-of run (module 09): the same job on several providers, compared side by side.
  const bestOf = group[0]?.task.groupKind === "best-of" ? group[0].task.group : null;
  const now = useNow(running);
  const counts = COUNTS.map(([status, label]) => {
    const count = group.filter((task) => task.task.status === status).length;
    return count ? `${count} ${label}` : null;
  });
  const summary = [bestOf ? `Best of ${group.length}` : `${group.length} tasks`, ...counts].filter(Boolean).join(" · ");

  return (
    <div className="max-w-xl min-w-0 rounded-2xl border border-hairline">
      <div className="flex items-center p-1.5 pb-0">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-hover focus-visible:-outline-offset-2"
        >
          <ChevronRight className={clsx("size-3.5 shrink-0 text-fg-subtle transition-transform", open && "rotate-90")} />
          <span className="min-w-0 truncate text-ui font-medium text-fg tabular-nums sm:shrink-0">{summary}</span>
          {combining && <span className="hidden min-w-0 truncate text-xs text-fg-subtle sm:inline">· combined here when done</span>}
        </button>
        {bestOf && (
          <a
            href={comparePath(bestOf)}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              navigateToCompare(bestOf);
            }}
            className="shrink-0 px-2 text-ui link-muted"
          >
            Compare
          </a>
        )}
      </div>
      <ul className={clsx("flex flex-col p-1.5", !open && "hidden")}>
        {group.map((task) => (
          <TaskGroupRow key={task.id} task={task} now={now} />
        ))}
      </ul>
      {!open && <div className="h-1.5" />}
    </div>
  );
}

/** One task: status icon, title, one muted line, time; on hover, its few actions in a menu where the time was. */
function TaskGroupRow({ task, now }: { task: TaskConversation; now: number }) {
  const { status } = task.task;
  const elapsed = taskElapsed(task.task, now);
  const line = [roleLine(task.task.role, task.task.tier), taskLine(task.task)].filter(Boolean).join(" · ");
  const canPause = status === "running" || status === "queued" || status === "needs-input";
  const canResume = status === "paused" || status === "interrupted";
  const hasMenu = isOpenTask(status);

  return (
    <li className="group/row relative">
      <button type="button" onClick={() => navigateToConversation(task.id)} className={ledgerRowClass({ interactive: true })}>
        <TaskStatusIcon status={status} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui text-fg">{task.title}</span>
          {line && <span className="truncate text-xs text-fg-subtle">{line}</span>}
        </span>
        {elapsed && (
          <span
            className={clsx(
              "shrink-0 text-xs text-fg-subtle tabular-nums transition-opacity",
              hasMenu && "group-hover/row:opacity-0 group-focus-within/row:opacity-0 group-has-[[data-state=open]]/row:opacity-0 pointer-coarse:opacity-0",
            )}
          >
            {elapsed}
          </span>
        )}
        {hasMenu && !elapsed && <span aria-hidden="true" className="w-7 shrink-0" />}
      </button>
      {hasMenu && (
        <div className="absolute top-1/2 right-1.5 -translate-y-1/2">
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <IconButton
                label={`Actions for ${task.title}`}
                size="sm"
                className="opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
              >
                <Ellipsis />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={4} className="menu w-52">
                {canResume && (
                  <DropdownMenu.Item className="menu-item" onSelect={() => void resumeTask(task.id)}>
                    <Play className="size-4 text-fg-muted" /> Resume
                  </DropdownMenu.Item>
                )}
                {canPause && (
                  <DropdownMenu.Item className="menu-item" onSelect={() => void pauseTask(task.id)}>
                    <Pause className="size-4 text-fg-muted" /> Pause
                  </DropdownMenu.Item>
                )}
                <DropdownMenu.Item className="menu-item" onSelect={() => void stopTask(task.id)}>
                  <CircleStop className="size-4 text-fg-muted" /> Stop
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      )}
    </li>
  );
}
