import type { MouseEvent, ReactNode } from "react";
import clsx from "clsx";
import {
  ArrowUpRight,
  CheckCheck,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  GitBranch,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  Pause,
  TriangleAlert,
  X,
} from "lucide-react";
import type { Agent, MissionOverlap, TaskChecks } from "@shared/types";
import { CHECKS_LABELS, taskStatusLine } from "../../lib/mission";
import { useProjects } from "../../lib/projects";
import { comparePath, conversationPath } from "../../lib/router";
import { TASK_STATUS_LABELS, taskElapsed, type TaskConversation } from "../../lib/tasks";
import { navigateToCompare, navigateToConversation, useStore } from "../../store";
import { Mascot } from "../mascot";
import { Chip, type ChipTone } from "../ui/Chip";
import { ledgerRowClass } from "../ui/Ledger";
import { StatusDot } from "../ui/StatusDot";

/**
 * Module 09: one task on mission control's board (and a project's Board tab), as a ledger row. The row opens the task;
 * its preview, pull request and best-of comparison open from small links that show on hover. Left: what state it's in;
 * then its title with a status line and branch under it; right: diff stats, checks, the agent and how long it's run.
 */

const CHECK_ICONS: Record<TaskChecks["state"], typeof CircleCheck> = {
  running: LoaderCircle,
  passing: CircleCheck,
  failing: CircleX,
  none: CircleDashed,
};

const LANDED: Record<"merged" | "pr" | "discarded", { label: string; icon: typeof GitMerge; tone: ChipTone }> = {
  merged: { label: "Merged", icon: GitMerge, tone: "success" },
  pr: { label: "Draft PR", icon: GitPullRequest, tone: "neutral" },
  discarded: { label: "Discarded", icon: X, tone: "neutral" },
};

/** Statuses the leading icon and the status line already say; the others get a chip too. */
const QUIET_STATUSES = new Set(["running", "needs-input", "done"]);

const STATUS_CHIP_TONES: Partial<Record<string, ChipTone>> = { failed: "danger", interrupted: "warning" };

/** "Also changes 2 files in “Fix cart”" (and "and 1 more task" when there are several). */
function overlapLine(overlaps: MissionOverlap[], titleOf: (id: string) => string | null): string {
  const [first, ...rest] = overlaps;
  if (!first) return "";
  const title = titleOf(first.taskId);
  const files = `${first.paths.length} file${first.paths.length === 1 ? "" : "s"}`;
  return `Also changes ${files} in ${title ? `“${title}”` : "another task"}${rest.length ? ` and ${rest.length} more task${rest.length === 1 ? "" : "s"}` : ""}`;
}

/** Hover-revealed (always shown on touch screens), above the row's own link. */
const HOVER_LINK = "relative z-10 flex shrink-0 items-center gap-0.5 link-muted opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100";

export function MissionRow({
  task,
  agent,
  overlaps,
  now,
  compact = false,
}: {
  task: TaskConversation;
  agent: Agent | undefined;
  overlaps: MissionOverlap[];
  now: number;
  /** A narrow column (a project's Board tab): diff stats and the elapsed time move under the title. */
  compact?: boolean;
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
  // Module 11: in a project with several repos, the one the task works in.
  const severalRepos = useProjects((s) => (s.projects.find((p) => p.id === task.projectId)?.repos?.length ?? 0) > 1);
  const repoName = severalRepos ? repo?.repoName : null;
  const landed = landing ? LANDED[landing.kind] : null;

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

  const statusLabel = landed?.label ?? (pendingApproval && status !== "needs-input" ? "Waiting for your OK" : TASK_STATUS_LABELS[status]);
  const statsNode = stats ? (
    <span className="shrink-0 font-mono whitespace-nowrap tabular-nums">
      <span className="text-success">+{stats.added}</span> <span className="text-danger">−{stats.removed}</span>
      <span className="text-fg-subtle">
        {" "}
        · {stats.files} file{stats.files === 1 ? "" : "s"}
      </span>
    </span>
  ) : null;

  // Its branch (and repo, in a project with several): beside the status line, or on the compact row's last line.
  const repoNode = repo && (
    <>
      {(!compact || statsNode) && (
        <span aria-hidden="true" className="text-fg-faint">
          ·
        </span>
      )}
      <GitBranch aria-hidden="true" className="size-3 shrink-0" />
      {repoName && <span className="max-w-24 shrink-0 truncate text-fg-muted">{repoName}</span>}
      <span title={repo.branch} className="min-w-0 shrink-[2] truncate font-mono text-2xs">{repo.branch}</span>
      {!stats && <span className="shrink-0">{repo.headSha ? "· No changes yet" : "· Not set up yet"}</span>}
    </>
  );

  return (
    <div className={ledgerRowClass({ interactive: true, className: "group relative items-start gap-3 py-2" })}>
      <span className="mt-px grid size-5 shrink-0 place-items-center" title={statusLabel}>
        <Leading task={task} waiting={waiting} />
        <span className="sr-only">{statusLabel}:</span>
      </span>

      <div className="min-w-0 flex-1">
        <a
          href={conversationPath(task.id)}
          onClick={open}
          title={task.title}
          // The whole row is the link; the small links on the right sit above it.
          className="block truncate text-ui text-fg after:absolute after:inset-0 after:rounded-lg"
        >
          {task.title}
        </a>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-fg-subtle">
          <span className={clsx("min-w-0 truncate", waiting ? "text-warning" : status === "failed" && "text-fg-muted")}>
            {pendingApproval && status !== "needs-input" ? "Waiting for your OK" : taskStatusLine(task)}
          </span>
          {!compact && repoNode}
        </p>
        {compact && (repo || statsNode || elapsed) && (
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-fg-subtle tabular-nums">
            {statsNode}
            {repo && <span className="flex min-w-0 flex-1 items-center gap-1.5">{repoNode}</span>}
            {elapsed && <span className="ml-auto shrink-0 pl-2">{elapsed}</span>}
          </p>
        )}
        {overlaps.length > 0 && !landing && (
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-warning" title={overlaps.flatMap((o) => o.paths).join("\n")}>
            <TriangleAlert className="size-3 shrink-0" />
            <span className="truncate">{overlapLine(overlaps, titleOf)}</span>
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3 pt-px text-xs text-fg-subtle tabular-nums">
        {preview && !landing && (
          <a href={preview.url} target="_blank" rel="noopener noreferrer" className={HOVER_LINK}>
            Preview
            <ArrowUpRight className="size-3.5" />
          </a>
        )}
        {landing?.pr && (
          <a href={landing.pr.url} target="_blank" rel="noopener noreferrer" className={HOVER_LINK}>
            PR #{landing.pr.number}
            <ArrowUpRight className="size-3.5" />
          </a>
        )}
        {bestOf && (
          <a href={comparePath(bestOf)} onClick={compare} className={HOVER_LINK}>
            Compare
          </a>
        )}
        {!compact && statsNode}
        {checks && CheckIcon && (
          <span
            title={[CHECKS_LABELS[checks.state], ...checks.lines].join("\n")}
            className={clsx("flex shrink-0 items-center", checks.state === "failing" && "text-danger", checks.state === "passing" && "text-success")}
          >
            <CheckIcon aria-hidden="true" className={clsx("size-3.5", checks.state === "running" && "animate-spin")} />
            <span className="sr-only">{CHECKS_LABELS[checks.state]}</span>
          </span>
        )}
        {landed ? (
          <Chip tone={landed.tone}>{landed.label}</Chip>
        ) : (
          !QUIET_STATUSES.has(status) && <Chip tone={STATUS_CHIP_TONES[status] ?? "neutral"}>{TASK_STATUS_LABELS[status]}</Chip>
        )}
        {agent ? <Mascot spec={agent.mascot} size={18} state={working ? "working" : "idle"} title={agent.name} /> : <span className="size-4.5 rounded-full bg-fill" />}
        {!compact && elapsed && <span className="min-w-12 text-right">{elapsed}</span>}
      </div>
    </div>
  );
}

/** The state at a glance: an amber dot when it waits on you, a spinner while it works, then its branch or how it landed. */
function Leading({ task, waiting }: { task: TaskConversation; waiting: boolean }): ReactNode {
  const { status, landing, repo } = task.task;
  if (landing) {
    const Icon = LANDED[landing.kind].icon;
    return <Icon aria-hidden="true" className={clsx("size-3.5", landing.kind === "merged" ? "text-success" : "text-fg-subtle")} />;
  }
  if (waiting || status === "interrupted") return <StatusDot tone="amber" />;
  if (status === "failed") return <CircleX aria-hidden="true" className="size-3.5 text-danger" />;
  if (status === "running") return <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin text-accent" />;
  if (status === "queued") return <Clock aria-hidden="true" className="size-3.5 text-fg-subtle" />;
  if (status === "paused") return <Pause aria-hidden="true" className="size-3.5 text-fg-subtle" />;
  if (repo?.headSha) return <GitBranch aria-hidden="true" className="size-3.5 text-fg-subtle" />;
  return <CheckCheck aria-hidden="true" className="size-3.5 text-fg-subtle" />;
}
