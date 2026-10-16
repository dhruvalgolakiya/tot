import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { DropdownMenu } from "radix-ui";
import { toast } from "sonner";
import { ArrowUpRight, CircleCheck, CircleMinus, CircleX, Ellipsis, GitMerge, GitPullRequestDraft, ListChecks, LoaderCircle, RefreshCw, Trash, TriangleAlert } from "lucide-react";
import type { Conversation, TaskChecks, TaskLandOptions } from "@tot/shared/types";
import { api, errorMessage } from "../../lib/api";
import { useProjects } from "../../lib/projects";
import { isOpenTask, type TaskConversation } from "../../lib/tasks";
import { handleAppEvent, notifyError } from "../../store";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { IconButton } from "../ui/IconButton";
import { Modal, ModalFooter } from "../ui/Modal";
import { Skeleton } from "../ui/Skeleton";

type Busy = "merge" | "pr" | "update" | "checks" | "discard" | null;

/** A response's task, shown right away (its `task` event follows). */
const show = (conversation: Conversation) => handleAppEvent({ type: "task", conversation });

/** How one gate line reads: passed, failed, waiting for the user's OK, or skipped. */
function lineTone(line: string): "pass" | "fail" | "warn" | "skip" {
  if (/ passed$/.test(line)) return "pass";
  if (/needs your OK/.test(line)) return "warn";
  if (/ skipped$/.test(line)) return "skip";
  return "fail";
}

const LINE_ICONS = {
  pass: <CircleCheck className="size-3.5 shrink-0 text-success" />,
  fail: <CircleX className="size-3.5 shrink-0 text-danger" />,
  warn: <TriangleAlert className="size-3.5 shrink-0 text-warning" />,
  skip: <CircleMinus className="size-3.5 shrink-0 text-fg-subtle" />,
};

/** The checks' state in one line, then a line per gate. */
function Checks({ checks }: { checks: TaskChecks }) {
  const summary =
    checks.state === "running" ? (
      <>
        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-fg-subtle" /> Running checks…
      </>
    ) : checks.state === "passing" ? (
      <>
        <CircleCheck className="size-3.5 shrink-0 text-success" /> Checks passing
      </>
    ) : checks.state === "failing" ? (
      <>
        <CircleX className="size-3.5 shrink-0 text-danger" /> Checks failing
      </>
    ) : (
      <>
        <CircleMinus className="size-3.5 shrink-0 text-fg-subtle" /> No checks: this repo has no profile yet
      </>
    );
  return (
    <div className="space-y-1.5">
      <p className={clsx("flex items-center gap-1.5 text-ui", checks.state === "none" || checks.state === "running" ? "text-fg-subtle" : "text-fg")}>{summary}</p>
      {checks.lines.length > 0 && (
        <ul className="space-y-1 pl-5" aria-label="Checks">
          {checks.lines.map((line, index) => (
            <li key={index} className="flex items-start gap-1.5 text-xs text-fg-muted">
              <span className="mt-px">{LINE_ICONS[lineTone(line)]}</span>
              <span className="min-w-0 [overflow-wrap:anywhere]">{line}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** After landing: "Merged into main · abc1234", "Draft PR #12 ↗", or "Discarded". */
function Landed({ task }: { task: TaskConversation }) {
  const landing = task.task.landing!;
  if (landing.kind === "merged") {
    return (
      <p className="flex items-center gap-1.5 text-ui text-fg">
        <GitMerge className="size-3.5 shrink-0 text-fg-muted" />
        <span>Merged into {landing.target ?? "your folder"}</span>
        {landing.sha && (
          <>
            <span aria-hidden="true" className="text-fg-subtle">
              ·
            </span>
            <span className="font-mono text-xs text-fg-subtle">{landing.sha.slice(0, 7)}</span>
          </>
        )}
      </p>
    );
  }
  if (landing.kind === "pr" && landing.pr) {
    return (
      <div className="space-y-1">
        <p className="flex items-center gap-1.5 text-ui text-fg">
          <GitPullRequestDraft className="size-3.5 shrink-0 text-fg-muted" />
          <a href={landing.pr.url} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-0.5">
            Draft PR #{landing.pr.number}
            <ArrowUpRight className="size-3.5" />
          </a>
        </p>
        <p className="text-xs text-fg-subtle">Review it and merge it on GitHub when it's ready. Its worktree stays for fixes.</p>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <p className="flex items-center gap-1.5 text-ui text-fg">
        <Trash className="size-3.5 shrink-0 text-fg-muted" /> Discarded
      </p>
      <p className="text-xs text-fg-subtle">Its worktree is gone, and its branch too unless it had been pushed.</p>
    </div>
  );
}

/**
 * The bottom of a finished coding task's Changes tab: its checks, how far its base moved on, and one
 * way to land it (Merge into main for a folder on this Mac, Open draft PR for a GitHub project), with
 * Update from main, Run checks and Discard in "…". After landing it says where the code went.
 */
export function LandBar({ task }: { task: TaskConversation }) {
  const { status, repo, landing, checks } = task.task;
  const isFolder = useProjects((s) => s.projects.find((p) => p.id === task.projectId)?.kind === "folder");
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; options: TaskLandOptions }>({ status: "loading" });
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const finished = !isOpenTask(status);
  const shown = Boolean(repo) && (finished || Boolean(landing));

  const load = useCallback(async () => {
    try {
      setState({ status: "ready", options: await api.taskLandOptions(task.id) });
    } catch (error) {
      setState({ status: "error", message: errorMessage(error) });
    }
  }, [task.id]);

  // Worked out again whenever the branch, the task's status or its landing changes.
  useEffect(() => {
    if (shown && !landing) void load();
  }, [shown, landing, load, repo?.headSha, status, checks?.state]);

  if (!shown || !repo) return null;

  const act = async (kind: Exclude<Busy, null>, action: () => Promise<Conversation>, done?: (task: Conversation) => void) => {
    setBusy(kind);
    try {
      const updated = await action();
      show(updated);
      done?.(updated);
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(null);
      void load();
    }
  };

  const base = repo.baseBranch || "main";
  const body = (() => {
    if (landing) return <Landed task={task} />;
    if (state.status === "loading") {
      return (
        <div className="space-y-2" aria-busy="true" aria-label="Checking how this task can land">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-8 w-full rounded-full" />
        </div>
      );
    }
    if (state.status === "error") {
      return (
        <Callout
          tone="danger"
          action={
            <button type="button" onClick={() => void load()} className="link-muted">
              Try again
            </button>
          }
        >
          Couldn't check how this task can land. {state.message}
        </Callout>
      );
    }
    const { options } = state;
    const method = isFolder ? "merge" : "pr";
    const option = isFolder ? options.merge : options.pr;
    const label = isFolder ? (busy === "merge" ? "Merging…" : `Merge into ${options.merge.target ?? base}`) : busy === "pr" ? "Opening PR…" : "Open draft PR";
    const checksRunning = checks?.state === "running";
    return (
      <div className="space-y-3">
        {checks && <Checks checks={checks} />}
        {busy === "update" || busy === "discard" ? (
          <p role="status" className="flex items-center gap-1.5 text-xs text-fg-subtle">
            <LoaderCircle className="size-3.5 animate-spin" /> {busy === "update" ? `Updating from ${base}…` : "Discarding…"}
          </p>
        ) : null}
        {(options.behind > 0 || option.reason) && (
          <div className="space-y-1 text-xs text-fg-subtle">
            {options.behind > 0 && (
              <p className="tabular-nums">
                {options.behind} commit{options.behind === 1 ? "" : "s"} behind {base}
              </p>
            )}
            {option.reason && <p className="leading-relaxed">{option.reason}</p>}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            className="min-w-0 flex-1"
            disabled={!option.available || busy !== null}
            onClick={() =>
              void act(method, () => api.landTask(task.id, { method, headSha: repo.headSha ?? undefined }), (updated) => {
                const done = updated.task?.landing;
                if (done?.kind === "pr" && done.pr) toast.success(`Opened draft PR #${done.pr.number}`);
              })
            }
          >
            {isFolder ? <GitMerge /> : <GitPullRequestDraft />}
            <span className="truncate">{label}</span>
          </Button>
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <IconButton label="More landing actions" disabled={busy !== null}>
                <Ellipsis />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" side="top" sideOffset={4} className="menu w-56">
                <DropdownMenu.Item
                  className="menu-item"
                  disabled={options.behind === 0}
                  onSelect={() =>
                    void act("update", () => api.updateTaskFromBase(task.id), (updated) => {
                      if (updated.task?.status === "running") toast(`The task is updating from ${base}`, { description: "It resolves the conflicts, then runs the checks." });
                      else toast.success(`Up to date with ${base}`);
                    })
                  }
                >
                  <RefreshCw className="size-4 text-fg-muted" /> Update from {base}
                </DropdownMenu.Item>
                <DropdownMenu.Item className="menu-item" disabled={checksRunning} onSelect={() => void act("checks", () => api.runTaskChecks(task.id))}>
                  <ListChecks className="size-4 text-fg-muted" /> Run checks
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="menu-separator" />
                <DropdownMenu.Item className="menu-item menu-item-danger" onSelect={() => setConfirmDiscard(true)}>
                  <Trash className="size-4" /> Discard
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>
    );
  })();

  return (
    <div className="shrink-0 border-t border-hairline p-4">
      {body}
      <Modal
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard this task's work?"
        description={
          <>
            This removes its worktree and deletes <span className="font-mono text-ui text-fg">{repo.branch}</span>, unless it was pushed. The task and its chat
            stay.
          </>
        }
        className="max-w-sm"
      >
        <ModalFooter divider={false}>
          <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            autoFocus
            onClick={() => {
              setConfirmDiscard(false);
              void act("discard", () => api.discardTask(task.id));
            }}
          >
            Discard
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
}
