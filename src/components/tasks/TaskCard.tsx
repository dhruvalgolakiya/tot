import { memo } from "react";
import clsx from "clsx";
import { ArrowUpRight, GitBranch, MessageCircleQuestion } from "lucide-react";
import { useNow } from "../../hooks/useNow";
import { roleLine } from "../../lib/orchestration";
import { isOpenTask, isTask, repoLabel, taskElapsed } from "../../lib/tasks";
import { navigateToConversation, setTaskPanelOpen, useStore } from "../../store";
import { Button } from "../ui/Button";
import { cardClass } from "../ui/Card";
import { TaskDot, TaskStatusBadge } from "./TaskStatus";

/**
 * A task started from this chat (the `task` message part): title, status, what it's doing, its
 * branch and how long it's been at it, live from the store; its result once it's finished.
 */
export const TaskCard = memo(function TaskCard({ taskId }: { taskId: string }) {
  const conversation = useStore((s) => s.conversations.find((c) => c.id === taskId));
  const now = useNow(Boolean(conversation?.task && conversation.task.status === "running"));

  if (!isTask(conversation)) {
    return <p className="text-xs text-fg-subtle">{conversation ? "This task is a chat now." : "This task was deleted."}</p>;
  }
  const { task } = conversation;
  const finished = !isOpenTask(task.status);
  const elapsed = taskElapsed(task, now);
  const open = () => navigateToConversation(conversation.id);
  const viewChanges = () => {
    navigateToConversation(conversation.id);
    setTaskPanelOpen(true, "changes");
  };

  return (
    <div className={cardClass({ padding: "sm", className: "max-w-xl space-y-2" })}>
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5">
          <TaskDot status={task.status} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{conversation.title}</p>
          {!finished && (
            <p className="truncate text-xs text-fg-subtle">
              {task.status === "queued" && task.queuePosition ? `Waiting in line · #${task.queuePosition}` : (task.progress ?? task.goal)}
            </p>
          )}
        </div>
        <TaskStatusBadge status={task.status} />
      </div>

      {task.status === "needs-input" && task.question && (
        <p className="flex items-start gap-2 text-ui text-warning">
          <MessageCircleQuestion className="mt-0.5 size-3.5 shrink-0" />
          <span className="line-clamp-3">{task.question}</span>
        </p>
      )}
      {finished && task.summary && <p className="line-clamp-4 text-ui leading-relaxed whitespace-pre-line text-fg-muted">{task.summary}</p>}
      {finished && task.result && task.result.findings.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-ui text-fg-muted">
          {task.result.findings.slice(0, 3).map((finding, index) => (
            <li key={index} className="line-clamp-1">
              {finding}
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-fg-subtle">
          {task.repo && (
            <>
              <GitBranch className="size-3.5 shrink-0" />
              <span className="truncate font-mono">
                {repoLabel(task.repo.source)} · {task.repo.branch}
              </span>
            </>
          )}
          {roleLine(task.role, task.tier) && (
            <span className={clsx("shrink-0", task.repo && "before:mr-1.5 before:content-['·']")}>{roleLine(task.role, task.tier)}</span>
          )}
          {finished && task.result && task.result.sources.length > 0 && (
            <span className="shrink-0 before:mr-1.5 before:content-['·']">
              {task.result.sources.length} source{task.result.sources.length === 1 ? "" : "s"}
            </span>
          )}
          {elapsed && <span className={clsx("shrink-0 tabular-nums", (task.repo || task.role) && "before:mr-1.5 before:content-['·']")}>{elapsed}</span>}
        </p>
        {finished && task.repo?.headSha && (
          <Button size="sm" variant="ghost" onClick={viewChanges}>
            View changes
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={open}>
          Open
          <ArrowUpRight />
        </Button>
      </div>
    </div>
  );
});
