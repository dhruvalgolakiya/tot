import type { MouseEvent } from "react";
import clsx from "clsx";
import { ArrowUpRight, CircleCheck, CircleDashed, CircleX, GitBranch, LoaderCircle, TriangleAlert } from "lucide-react";
import type { Agent, MissionOverlap, TaskChecks } from "@shared/types";
import { CHECKS_LABELS, landingLine } from "../../lib/mission";
import { comparePath, conversationPath } from "../../lib/router";
import { taskElapsed, type TaskConversation } from "../../lib/tasks";
import { navigateToCompare, navigateToConversation, useStore } from "../../store";
import { Mascot } from "../mascot";
import { TaskStatusBadge } from "../tasks/TaskStatus";
import { Badge } from "../ui/Badge";
import { cardClass } from "../ui/Card";

/** Module 09: one task on mission control's board. The card opens the task; its preview and a best-of comparison open from small links. */

const CHECK_ICONS: Record<TaskChecks["state"], typeof CircleCheck> = {
  running: LoaderCircle,
  passing: CircleCheck,
  failing: CircleX,
  none: CircleDashed,
};

/** What it's doing, or what it needs, in one line. */
function statusLine(task: TaskConversation): string {
  const info = task.task;
  if (info.landing) return landingLine(info.landing);
  const firstLine = (text: string | null | undefined) => text?.split("\n").find((line) => line.trim())?.trim() ?? null;
  switch (info.status) {
    case "needs-input":
      return info.question ?? "Waiting for your OK";
    case "queued":
      return info.queuePosition ? `Waiting in line · #${info.queuePosition}` : "Waiting in line";
    case "interrupted":
      return "Cut off by a restart · resume it to carry on";
    case "paused":
      return info.progress ?? "Paused";
    case "running":
      return info.progress ?? info.goal;
    default:
      return firstLine(info.result?.summary) ?? firstLine(info.summary) ?? info.goal;
  }
}

/** "Also changes 2 files in “Fix cart”" (and "and 1 more task" when there are several). */
function overlapLine(overlaps: MissionOverlap[], titleOf: (id: string) => string | null): string {
  const [first, ...rest] = overlaps;
  if (!first) return "";
  const title = titleOf(first.taskId);
  const files = `${first.paths.length} file${first.paths.length === 1 ? "" : "s"}`;
  return `Also changes ${files} in ${title ? `“${title}”` : "another task"}${rest.length ? ` and ${rest.length} more task${rest.length === 1 ? "" : "s"}` : ""}`;
}

export function MissionCard({
  task,
  agent,
  overlaps,
  now,
}: {
  task: TaskConversation;
  agent: Agent | undefined;
  overlaps: MissionOverlap[];
  now: number;
}) {
  const conversations = useStore((s) => s.conversations);
  const pendingApproval = useStore((s) => s.pendingApprovals.has(task.id));
  const { status, repo, stats, checks, preview, landing, group, groupKind } = task.task;
  const elapsed = taskElapsed(task.task, now);
  const working = status === "running";
  const titleOf = (id: string) => conversations.find((c) => c.id === id)?.title ?? null;
  const CheckIcon = checks ? CHECK_ICONS[checks.state] : null;
  const waiting = status === "needs-input" || pendingApproval;
  const bestOf = groupKind === "best-of" ? group : null;

  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigateToConversation(task.id);
  };
  const compare = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!bestOf || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigateToCompare(bestOf);
  };

  return (
    <div className={cardClass({ padding: "sm", interactive: true, className: "relative flex h-full min-w-0 flex-col gap-1.5" })}>
      <div className="flex min-w-0 items-center gap-2.5">
        {agent ? <Mascot spec={agent.mascot} size={22} state={working ? "working" : "idle"} title={agent.name} /> : <span className="size-5.5 shrink-0 rounded-full bg-fill" />}
        <a
          href={conversationPath(task.id)}
          onClick={open}
          title={task.title}
          // The whole card is the link; the small links below sit above it.
          className="min-w-0 flex-1 truncate text-sm font-medium text-fg after:absolute after:inset-0 after:rounded-xl"
        >
          {task.title}
        </a>
        {landing ? (
          <Badge tone={landing.kind === "merged" ? "success" : "neutral"}>{landing.kind === "merged" ? "Merged" : landing.kind === "pr" ? "Draft PR" : "Discarded"}</Badge>
        ) : (
          <TaskStatusBadge status={status} />
        )}
      </div>

      <p className="flex min-w-0 items-center gap-3 text-xs">
        <span className={clsx("min-w-0 flex-1 truncate", waiting ? "text-warning" : status === "failed" ? "text-fg-muted" : "text-fg-subtle")}>
          {pendingApproval && status !== "needs-input" ? "Waiting for your OK" : statusLine(task)}
        </span>
        {elapsed && <span className="shrink-0 text-fg-subtle tabular-nums">{elapsed}</span>}
      </p>

      {repo && (
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-fg-subtle">
          <GitBranch className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate font-mono">{repo.branch}</span>
          <span className="ml-auto shrink-0 font-mono tabular-nums">
            {stats ? (
              <>
                <span className="text-success">+{stats.added}</span> <span className="text-danger">−{stats.removed}</span>
                <span> · {stats.files} file{stats.files === 1 ? "" : "s"}</span>
              </>
            ) : repo.headSha ? (
              "No changes yet"
            ) : (
              "Not set up yet"
            )}
          </span>
        </p>
      )}

      {overlaps.length > 0 && !landing && (
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-warning" title={overlaps.flatMap((o) => o.paths).join("\n")}>
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="truncate">{overlapLine(overlaps, titleOf)}</span>
        </p>
      )}

      {(checks || (preview && !landing) || landing?.pr || bestOf) && (
        <div className="flex min-w-0 items-center gap-3 text-xs text-fg-subtle">
          {checks && CheckIcon && (
            <span
              title={checks.lines.join("\n") || undefined}
              className={clsx("flex shrink-0 items-center gap-1", checks.state === "failing" && "text-danger", checks.state === "passing" && "text-success")}
            >
              <CheckIcon className={clsx("size-3.5", checks.state === "running" && "animate-spin")} />
              {CHECKS_LABELS[checks.state]}
            </span>
          )}
          {preview && !landing && (
            <a href={preview.url} target="_blank" rel="noopener noreferrer" className="relative z-10 flex shrink-0 items-center gap-0.5 link-muted">
              Preview
              <ArrowUpRight className="size-3.5" />
            </a>
          )}
          {landing?.pr && (
            <a href={landing.pr.url} target="_blank" rel="noopener noreferrer" className="relative z-10 flex shrink-0 items-center gap-0.5 link-muted">
              PR #{landing.pr.number}
              <ArrowUpRight className="size-3.5" />
            </a>
          )}
          {bestOf && (
            <a href={comparePath(bestOf)} onClick={compare} className="relative z-10 shrink-0 link-muted">
              Compare
            </a>
          )}
        </div>
      )}
    </div>
  );
}
