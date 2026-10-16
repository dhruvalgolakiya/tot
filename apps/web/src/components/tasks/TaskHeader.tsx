import { useMemo, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { ArrowLeftRight, ArrowUpRight, Check, CircleStop, Copy, Ellipsis, FolderOpen, GitBranch, GitMerge, MessagesSquare, MonitorStop, PanelRight, Pause, Pencil, Play, Trash } from "lucide-react";
import type { Message, TaskPreview } from "@tot/shared/types";
import { useCopy } from "../../hooks/useCopy";
import { useNow } from "../../hooks/useNow";
import { api } from "../../lib/api";
import { answeredByLabel, modelLabel, PROVIDER_LABELS } from "../../lib/models";
import { roleLine } from "../../lib/orchestration";
import { formatTokens, isOpenTask, repoLabel, taskElapsed, type TaskConversation } from "../../lib/tasks";
import { continueTaskOn, notifyError, pauseTask, resumeTask, setComputerPanelOpen, setTaskPanelOpen, setTaskPanelTab, stopTask, taskToChat, useStore } from "../../store";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Tip } from "../ui/Tip";
import { DeleteTaskDialog } from "./DeleteTaskDialog";
import { RenameTaskDialog } from "./RenameTaskDialog";
import { TaskStatusBadge } from "./TaskStatus";

const NO_MESSAGES: Message[] = [];

/** The open task's title, status, branch and stats, its Pause/Resume and Stop, and the rest in "…". */
export function TaskHeaderInfo({ task }: { task: TaskConversation }) {
  const models = useStore((s) => s.models);
  const messages = useStore((s) => s.messages[task.id]) ?? NO_MESSAGES;
  const now = useNow(task.task.status === "running");
  const { copied, copy } = useCopy();
  const { repo, usage } = task.task;
  const lastReply = useMemo(() => messages.findLast((m) => m.role === "assistant" && m.model), [messages]);
  const model = (lastReply && answeredByLabel(models, lastReply)) ?? modelLabel(models, task.modelId);
  const elapsed = taskElapsed(task.task, now);
  const tokens = usage.inputTokens + usage.outputTokens;
  // e.g. "Implementer · deep · Opus 5.5 · 14m · 98k tokens".
  const stats = [roleLine(task.task.role, task.task.tier), model, elapsed, tokens ? `${formatTokens(tokens)} tokens` : null].filter(Boolean).join(" · ");

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5 px-1">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-sm font-medium text-fg">{task.title}</h1>
          <TaskStatusBadge status={task.task.status} />
        </div>
        <p className="hidden min-w-0 items-center gap-1.5 text-xs text-fg-subtle sm:flex">
          {repo && (
            <Tip content={copied ? "Copied" : `Copy branch name · ${repo.worktree}`}>
              <button
                type="button"
                onClick={() => void copy(repo.branch)}
                className="flex min-w-0 items-center gap-1 rounded-md font-mono transition-colors hover:text-fg-muted"
              >
                {copied ? <Check className="size-3 shrink-0" /> : <GitBranch className="size-3 shrink-0" />}
                <span className="truncate">
                  {repoLabel(repo.source)} · {repo.branch}
                </span>
              </button>
            </Tip>
          )}
          {repo && stats && <span aria-hidden="true">·</span>}
          <span className="shrink-0 tabular-nums">{stats}</span>
        </p>
      </div>
    </div>
  );
}

/** "localhost:41000/" from "http://localhost:41000/": the preview's address, for its tooltip. */
const previewHost = (url: string) => url.replace(/^https?:\/\//, "");

/** "Preview ↗": the dev server TOT runs for the task (module 09), opening in a new tab. Phones have it in "…". */
function PreviewChip({ preview }: { preview: TaskPreview }) {
  return (
    <Tip content={`Open ${previewHost(preview.url)}`}>
      <a
        href={preview.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mr-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-edge px-2.5 text-xs font-medium text-fg-muted transition-colors hover:border-edge-strong hover:bg-hover hover:text-fg max-sm:hidden"
      >
        Preview
        <ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0" />
      </a>
    </Tip>
  );
}

export function TaskHeaderActions({ task }: { task: TaskConversation }) {
  const panelOpen = useStore((s) => s.taskPanelOpen);
  const panelTab = useStore((s) => s.taskPanelTab);
  // The provider it's on (its last reply's, or the one it was moved to), and whether the other is signed in.
  const lastProvider = useStore((s) => s.messages[task.id]?.findLast((m) => m.role === "assistant" && m.provider)?.provider);
  const current = task.task.provider ?? lastProvider ?? "claude";
  const other = current === "claude" ? "chatgpt" : "claude";
  const otherReady = useStore((s) => Boolean(s.providers.find((p) => p.id === other)?.loggedIn));
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const { status, repo } = task.task;
  const preview = task.task.preview ?? null;
  const { copy } = useCopy();
  const canPause = status === "running" || status === "queued" || status === "needs-input";
  const canResume = status === "paused" || status === "interrupted";
  // A finished coding task's next step (module 09): its Land bar, at the bottom of the Changes tab.
  const readyToLand = status === "done" && Boolean(repo?.headSha) && !task.task.landing;
  const stopPreview = () => void api.stopTaskPreview(task.id).catch(notifyError);
  const reviewAndLand = () => {
    setTaskPanelTab("changes");
    setTaskPanelOpen(true);
  };

  return (
    <div className="flex items-center gap-1">
      {preview && <PreviewChip preview={preview} />}
      {readyToLand && !(panelOpen && panelTab === "changes") && (
        <Button size="sm" variant="primary" onClick={reviewAndLand}>
          <GitMerge />
          Review & land
        </Button>
      )}
      {canPause && (
        <Button size="sm" variant="secondary" aria-label="Pause" className="max-sm:w-8 max-sm:px-0" onClick={() => void pauseTask(task.id)}>
          <Pause />
          <span className="max-sm:hidden">Pause</span>
        </Button>
      )}
      {canResume && (
        <Button size="sm" variant="secondary" aria-label="Resume" className="max-sm:w-8 max-sm:px-0" onClick={() => void resumeTask(task.id)}>
          <Play />
          <span className="max-sm:hidden">Resume</span>
        </Button>
      )}
      {isOpenTask(status) && (
        <Tip content="Stop the task">
          <IconButton label="Stop the task" className="max-sm:hidden" onClick={() => void stopTask(task.id)}>
            <CircleStop />
          </IconButton>
        </Tip>
      )}
      <Tip content="Plan, changes and activity">
        <IconButton label="Task details" aria-pressed={panelOpen} onClick={() => setTaskPanelOpen(!panelOpen)}>
          <PanelRight />
        </IconButton>
      </Tip>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <IconButton label="More task actions">
            <Ellipsis />
          </IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="menu w-56"
            onCloseAutoFocus={(event) => {
              if (dialog) event.preventDefault();
            }}
          >
            {isOpenTask(status) && (
              <DropdownMenu.Item className="menu-item sm:hidden" onSelect={() => void stopTask(task.id)}>
                <CircleStop className="size-4 text-fg-muted" /> Stop the task
              </DropdownMenu.Item>
            )}
            {preview && (
              <>
                <DropdownMenu.Item className="menu-item sm:hidden" onSelect={() => window.open(preview.url, "_blank", "noopener,noreferrer")}>
                  <ArrowUpRight className="size-4 text-fg-muted" /> Open preview
                </DropdownMenu.Item>
                <DropdownMenu.Item className="menu-item" onSelect={stopPreview}>
                  <MonitorStop className="size-4 text-fg-muted" /> Stop preview
                </DropdownMenu.Item>
              </>
            )}
            <DropdownMenu.Item className="menu-item" onSelect={() => setDialog("rename")}>
              <Pencil className="size-4 text-fg-muted" /> Rename
            </DropdownMenu.Item>
            {repo && (
              <>
                <DropdownMenu.Item className="menu-item" onSelect={() => void copy(repo.worktree)}>
                  <Copy className="size-4 text-fg-muted" /> Copy worktree path
                </DropdownMenu.Item>
                <DropdownMenu.Item className="menu-item" onSelect={() => setComputerPanelOpen(true)}>
                  <FolderOpen className="size-4 text-fg-muted" /> Open the computer
                </DropdownMenu.Item>
              </>
            )}
            <DropdownMenu.Item className="menu-item" disabled={!otherReady} onSelect={() => void continueTaskOn(task.id, other)}>
              <ArrowLeftRight className="size-4 text-fg-muted" />
              <span className="flex-1">Continue on {PROVIDER_LABELS[other]}</span>
            </DropdownMenu.Item>
            {!isOpenTask(status) || status === "paused" || status === "interrupted" ? (
              <DropdownMenu.Item className="menu-item" onSelect={() => void taskToChat(task.id)}>
                <MessagesSquare className="size-4 text-fg-muted" /> Turn back into a chat
              </DropdownMenu.Item>
            ) : null}
            <DropdownMenu.Separator className="menu-separator" />
            <DropdownMenu.Item className="menu-item menu-item-danger" onSelect={() => setDialog("delete")}>
              <Trash className="size-4" /> Delete
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <RenameTaskDialog task={task} open={dialog === "rename"} onOpenChange={(open) => setDialog(open ? "rename" : null)} />
      <DeleteTaskDialog task={task} open={dialog === "delete"} onOpenChange={(open) => setDialog(open ? "delete" : null)} />
    </div>
  );
}
