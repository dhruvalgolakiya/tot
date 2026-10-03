import { useRef, useState, type MouseEvent } from "react";
import clsx from "clsx";
import { DropdownMenu } from "radix-ui";
import { Ellipsis, Pause, Pencil, Play, Square, Trash } from "lucide-react";
import { useNow } from "../../hooks/useNow";
import { conversationPath } from "../../lib/router";
import { isOpenTask, repoLabel, taskElapsed, type TaskConversation } from "../../lib/tasks";
import { navigateToConversation, patchTask, pauseTask, resumeTask, stopTask, useStore } from "../../store";
import { IconButton } from "../ui/IconButton";
import { listRowClass } from "../ui/ListRow";
import { DeleteTaskDialog } from "./DeleteTaskDialog";
import { TaskDot } from "./TaskStatus";

/** A task in the sidebar: status dot, title, `repo · branch` for coding tasks, elapsed time; actions on hover. */
export function TaskRow({ task, active }: { task: TaskConversation; active: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const pendingAction = useRef<"rename" | "delete" | null>(null);
  const pendingApproval = useStore((s) => s.pendingApprovals.has(task.id));
  const { status, repo } = task.task;
  const now = useNow(status === "running", 30_000);
  const elapsed = taskElapsed(task.task, now);
  const working = status === "running" || status === "needs-input" || status === "queued";

  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigateToConversation(task.id);
  };

  if (renaming) {
    const finish = (value: string | null) => {
      setRenaming(false);
      const title = value?.trim();
      if (title && title !== task.title) void patchTask(task.id, { title });
    };
    return (
      <input
        autoFocus
        defaultValue={task.title}
        aria-label="Task title"
        onFocus={(event) => event.currentTarget.select()}
        onBlur={(event) => finish(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") finish(event.currentTarget.value);
          if (event.key === "Escape") finish(null);
        }}
        className="h-9 w-full rounded-lg border bg-fill px-2.5 text-sm text-fg focus-visible:-outline-offset-2"
        style={{ borderColor: "var(--agent-accent-border)" }}
      />
    );
  }

  return (
    <div className="group relative">
      <a
        href={conversationPath(task.id)}
        onClick={open}
        aria-current={active ? "page" : undefined}
        title={task.title}
        className={listRowClass({ selected: active, className: clsx("pr-8", repo && "h-auto py-1.5") })}
      >
        <TaskDot status={status} />
        <span className="min-w-0 flex-1">
          <span className={clsx("block truncate", !isOpenTask(status) && "text-fg-muted")}>{task.title}</span>
          {repo && (
            <span className="block truncate font-mono text-xs text-fg-subtle">
              {repoLabel(repo.source)} · {repo.branch}
            </span>
          )}
        </span>
        {pendingApproval ? (
          <span className="shrink-0 text-xs text-warning">OK?</span>
        ) : (
          elapsed && <span className="shrink-0 text-xs text-fg-subtle tabular-nums group-hover:invisible">{elapsed}</span>
        )}
      </a>

      <DropdownMenu.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenu.Trigger asChild>
          <IconButton
            label={`Options for ${task.title}`}
            size="sm"
            className={clsx(
              "absolute top-1/2 right-1 -translate-y-1/2",
              menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
            )}
          >
            <Ellipsis />
          </IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={4}
            className="menu w-44"
            onCloseAutoFocus={(event) => {
              const action = pendingAction.current;
              pendingAction.current = null;
              if (!action) return;
              event.preventDefault();
              if (action === "rename") setRenaming(true);
              else setConfirming(true);
            }}
          >
            <DropdownMenu.Item className="menu-item" onSelect={() => (pendingAction.current = "rename")}>
              <Pencil className="size-4 text-fg-muted" /> Rename
            </DropdownMenu.Item>
            {working && (
              <DropdownMenu.Item className="menu-item" onSelect={() => void pauseTask(task.id)}>
                <Pause className="size-4 text-fg-muted" /> Pause
              </DropdownMenu.Item>
            )}
            {(status === "paused" || status === "interrupted") && (
              <DropdownMenu.Item className="menu-item" onSelect={() => void resumeTask(task.id)}>
                <Play className="size-4 text-fg-muted" /> Resume
              </DropdownMenu.Item>
            )}
            {isOpenTask(status) && (
              <DropdownMenu.Item className="menu-item" onSelect={() => void stopTask(task.id)}>
                <Square className="size-4 text-fg-muted" /> Stop
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Separator className="menu-separator" />
            <DropdownMenu.Item className="menu-item menu-item-danger" onSelect={() => (pendingAction.current = "delete")}>
              <Trash className="size-4" /> Delete
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <DeleteTaskDialog task={task} open={confirming} onOpenChange={setConfirming} />
    </div>
  );
}
