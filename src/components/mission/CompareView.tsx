import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { toast } from "sonner";
import { ArrowLeft, ArrowUpRight, ChevronRight, CircleCheck, CircleDashed, CircleX, GitBranch, LoaderCircle } from "lucide-react";
import type { Conversation, TaskChanges, TaskChecks, TaskLandOptions } from "@shared/types";
import { useNow } from "../../hooks/useNow";
import { api, errorMessage } from "../../lib/api";
import { bestOfLabel, CHECKS_LABELS, landingLine } from "../../lib/mission";
import { modelLabel, PROVIDER_LABELS } from "../../lib/models";
import { useProjects } from "../../lib/projects";
import { isOpenTask, isTask, taskElapsed, type TaskConversation } from "../../lib/tasks";
import { navigateToConversation, navigateToMission, notifyError, useStore } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { TaskStatusBadge } from "../tasks/TaskStatus";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { cardClass } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { Skeleton } from "../ui/Skeleton";

/**
 * A best-of run side by side (roadmap module 09, `/tasks/compare/:group`): a column per task with its
 * provider, model, status, lines changed, checks and summary; below, every file any of them changed, each
 * opening to the runs' diffs next to each other. "Keep this one" lands it with lane A's API (merge into
 * the folder when that's possible, else a draft PR) and discards the others, after a confirmation.
 */

const CHECK_ICONS: Record<TaskChecks["state"], typeof CircleCheck> = { running: LoaderCircle, passing: CircleCheck, failing: CircleX, none: CircleDashed };
const COLUMNS: Record<number, string> = { 1: "", 2: "md:grid-cols-2", 3: "md:grid-cols-2 xl:grid-cols-3", 4: "md:grid-cols-2 xl:grid-cols-4" };

/** "Fix cart total · Claude 1" → "Claude 1"; the shared part is the page's title. */
const runLabel = (task: TaskConversation) => task.title.split(" · ").at(-1) ?? (task.task.provider ? PROVIDER_LABELS[task.task.provider] : "Auto");
const baseTitle = (task: TaskConversation) => task.title.replace(/ · [^·]+$/, "");

/** The unified diff split per file, keyed by the file's (new) path; each file's diff from its first hunk (the git header says nothing new here). */
function splitPatch(patch: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    if (!header) continue;
    const hunk = chunk.search(/^@@/m);
    files.set(header[2]!, (hunk === -1 ? chunk : chunk.slice(hunk)).replace(/\n+$/, ""));
  }
  return files;
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) return "text-fg-subtle";
  if (line.startsWith("@@")) return "text-fg-subtle bg-fill-subtle";
  if (line.startsWith("+")) return "bg-success-soft text-success";
  if (line.startsWith("-")) return "bg-danger-soft text-danger";
  return "text-fg-muted";
}

type Changes = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; changes: TaskChanges; patches: Map<string, string> };

/** Each run's changes, refetched when its branch moves or its status changes. */
function useRunChanges(runs: TaskConversation[]): Record<string, Changes> {
  const [changes, setChanges] = useState<Record<string, Changes>>({});
  const key = runs.map((run) => `${run.id}:${run.task.repo?.headSha ?? ""}:${run.task.status}:${run.task.stats?.at ?? ""}`).join("|");
  useEffect(() => {
    let cancelled = false;
    for (const run of runs) {
      if (!run.task.repo?.headSha || run.task.landing?.kind === "discarded") continue;
      setChanges((current) => (current[run.id]?.status === "ready" ? current : { ...current, [run.id]: { status: "loading" } }));
      api
        .taskChanges(run.id)
        .then((result) => !cancelled && setChanges((current) => ({ ...current, [run.id]: { status: "ready", changes: result, patches: splitPatch(result.patch) } })))
        .catch((error) => !cancelled && setChanges((current) => ({ ...current, [run.id]: { status: "error", message: errorMessage(error) } })));
    }
    return () => {
      cancelled = true;
    };
    // `key` covers what matters in `runs`.
  }, [key]);
  return changes;
}

export function CompareView() {
  const group = useStore((s) => s.compareGroup);
  const conversations = useStore((s) => s.conversations);
  const [fetched, setFetched] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; tasks: Conversation[] }>({
    status: "loading",
  });

  const load = useCallback(async () => {
    if (!group) return;
    try {
      const overview = await api.getMission({ group });
      setFetched({ status: "ready", tasks: overview.tasks.map((t) => t.conversation) });
    } catch (error) {
      setFetched({ status: "error", message: errorMessage(error) });
    }
  }, [group]);
  useEffect(() => void load(), [load]);

  // The store's copies are live (task events); oldest first, as they were started.
  const runs = useMemo(
    () =>
      fetched.status === "ready"
        ? fetched.tasks
            .map((task) => conversations.find((c) => c.id === task.id) ?? task)
            .filter(isTask)
            .sort((a, b) => a.createdAt - b.createdAt)
        : [],
    [fetched, conversations],
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 pt-20 pb-12 sm:px-6 md:pt-24">
        <button type="button" onClick={() => navigateToMission(runs[0]?.projectId ?? null)} className="flex items-center gap-1.5 text-ui link-muted">
          <ArrowLeft className="size-3.5" />
          Mission control
        </button>
        {fetched.status === "loading" ? (
          <div aria-busy="true" aria-label="Loading the runs" className="mt-6 space-y-4">
            <Skeleton className="h-7 w-72" />
            <div className="grid gap-4 md:grid-cols-2">
              <Skeleton className="h-64 rounded-xl" />
              <Skeleton className="h-64 rounded-xl" />
            </div>
          </div>
        ) : fetched.status === "error" ? (
          <Callout
            tone="danger"
            className="mt-6"
            action={
              <button type="button" onClick={() => void load()} className="link-muted">
                Try again
              </button>
            }
          >
            Couldn't load the runs. {fetched.message}
          </Callout>
        ) : runs.length === 0 ? (
          <EmptyState className="mt-6" title="Nothing to compare" description="These runs were deleted, or the link is wrong." />
        ) : (
          <Comparison runs={runs} />
        )}
      </div>
    </div>
  );
}

function Comparison({ runs }: { runs: TaskConversation[] }) {
  const models = useStore((s) => s.models);
  const projects = useProjects((s) => s.projects);
  const changes = useRunChanges(runs);
  const now = useNow(runs.some((run) => run.task.status === "running"), 30_000);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [keeping, setKeeping] = useState<{ run: TaskConversation; method: "merge" | "pr" | null; options: TaskLandOptions | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const kept = runs.find((run) => run.task.landing && run.task.landing.kind !== "discarded");
  const first = runs[0]!;
  const providers = runs.map((run) => run.task.provider ?? "claude");
  const base = first.task.repo?.baseBranch;

  // Every file any run changed, in the order they first appear.
  const files = useMemo(() => {
    const paths: string[] = [];
    for (const run of runs) {
      const state = changes[run.id];
      if (state?.status !== "ready") continue;
      for (const file of state.changes.files) if (!paths.includes(file.path)) paths.push(file.path);
    }
    return paths;
  }, [runs, changes]);

  /** Asks how it can land (lane A), then confirms. Only a run without code is kept without landing. */
  async function askToKeep(run: TaskConversation) {
    if (!run.task.repo) {
      setKeeping({ run, method: null, options: null });
      return;
    }
    setBusy(run.id);
    try {
      const options = await api.taskLandOptions(run.id);
      const method = options.merge.available ? "merge" : options.pr.available ? "pr" : null;
      if (!method) {
        // The reason for the way this project lands: merging for a folder on this Mac, a draft PR otherwise.
        const folder = projects.find((project) => project.id === run.projectId)?.kind === "folder";
        toast.error((folder ? options.merge.reason : options.pr.reason) ?? "This run can't land right now.");
        return;
      }
      setKeeping({ run, method, options });
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(null);
    }
  }

  /** Lands the kept run, then discards the others still unlanded. */
  async function keep() {
    if (!keeping) return;
    const { run, method, options } = keeping;
    setBusy(run.id);
    try {
      // The head the user compared lands, or nothing does.
      if (method) await api.landTask(run.id, { method, headSha: run.task.repo?.headSha ?? undefined });
      const others = runs.filter((other) => other.id !== run.id && !other.task.landing);
      const failed: string[] = [];
      for (const other of others) {
        await api.discardTask(other.id).catch((error) => failed.push(`${runLabel(other)}: ${errorMessage(error)}`));
      }
      if (failed.length) toast.error(`Couldn't discard ${failed.join("; ")}`);
      else toast.success(method === "merge" ? `Merged into ${options?.merge.target ?? "main"}` : method === "pr" ? "Draft PR opened" : `Kept ${runLabel(run)}`);
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(null);
    }
  }

  const others = keeping ? runs.filter((other) => other.id !== keeping.run.id && !other.task.landing).length : 0;
  const discardText = others ? ` The other ${others === 1 ? "run is" : `${others} runs are`} discarded: worktree removed, branch deleted unless it was pushed.` : "";

  return (
    <>
      <header className="mt-4">
        <h1 className="text-title text-fg-strong">{baseTitle(first)}</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Best of {runs.length} · {bestOfLabel(providers)}
          {first.task.repo ? ` · each on its own branch off ${base || "main"}` : ""}
        </p>
        {first.task.goal !== baseTitle(first) && <p className="mt-3 line-clamp-3 max-w-3xl text-sm leading-relaxed whitespace-pre-line text-fg">{first.task.goal}</p>}
      </header>

      <ul className={clsx("mt-8 grid gap-4", COLUMNS[Math.min(runs.length, 4)])}>
        {runs.map((run) => (
          <li key={run.id} className="min-w-0">
            <RunColumn
              run={run}
              model={modelLabel(models, run.modelId)}
              now={now}
              changes={changes[run.id]}
              kept={kept ? kept.id === run.id : null}
              busy={busy === run.id}
              disabled={Boolean(kept) || busy !== null}
              onKeep={() => void askToKeep(run)}
            />
          </li>
        ))}
      </ul>

      {files.length > 0 && (
        <section aria-labelledby="compare-files" className="mt-10">
          <h2 id="compare-files" className="text-sm font-semibold text-fg">
            Files
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">Open a file to see each run's change to it side by side.</p>
          <ul className="mt-3 divide-y divide-hairline overflow-hidden rounded-xl border border-hairline">
            <li aria-hidden="true" className="flex items-center gap-2 bg-fill-subtle px-3 py-1.5 text-xs text-fg-subtle max-sm:hidden">
              <span className="min-w-0 flex-1 pl-5.5">{files.length} file{files.length === 1 ? "" : "s"}</span>
              {runs.map((run) => (
                <span key={run.id} className="w-20 shrink-0 truncate text-right">
                  {runLabel(run)}
                </span>
              ))}
            </li>
            {files.map((path) => {
              const expanded = openFile === path;
              return (
                <li key={path}>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpenFile(expanded ? null : path)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-hover focus-visible:-outline-offset-2"
                  >
                    <ChevronRight className={clsx("size-3.5 shrink-0 text-fg-subtle transition-transform", expanded && "rotate-90")} />
                    <span className="min-w-0 flex-1 truncate font-mono text-ui text-fg" title={path}>
                      {path}
                    </span>
                    {runs.map((run) => {
                      const state = changes[run.id];
                      const file = state?.status === "ready" ? state.changes.files.find((f) => f.path === path) : undefined;
                      return (
                        <span key={run.id} title={runLabel(run)} className="w-20 shrink-0 text-right font-mono text-xs tabular-nums max-sm:hidden">
                          {file ? (
                            <>
                              <span className="text-success">+{file.additions}</span> <span className="text-danger">−{file.deletions}</span>
                            </>
                          ) : (
                            <span className="text-fg-faint">—</span>
                          )}
                        </span>
                      );
                    })}
                  </button>
                  {expanded && (
                    <div className={clsx("grid gap-px border-t border-hairline bg-hairline", COLUMNS[Math.min(runs.length, 4)])}>
                      {runs.map((run) => {
                        const state = changes[run.id];
                        const patch = state?.status === "ready" ? state.patches.get(path) : undefined;
                        const touched = state?.status === "ready" && state.changes.files.some((f) => f.path === path);
                        return (
                          <div key={run.id} className="min-w-0 bg-sunken">
                            <p className="border-b border-hairline px-3 py-1.5 text-xs font-medium text-fg-muted">{runLabel(run)}</p>
                            {touched ? (
                              <pre className="max-h-96 overflow-auto py-1 font-mono text-xs leading-relaxed">
                                <div className="inline-block min-w-full">
                                  {(patch ?? "No diff to show (binary or too large).").split("\n").map((line, index) => (
                                    <div key={index} className={clsx("px-3 whitespace-pre", lineClass(line))}>
                                      {line || " "}
                                    </div>
                                  ))}
                                </div>
                              </pre>
                            ) : (
                              <p className="px-3 py-3 text-xs text-fg-subtle">Not changed in this run.</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <ConfirmDialog
        open={keeping !== null}
        onOpenChange={(open) => !open && setKeeping(null)}
        title={keeping ? `Keep ${runLabel(keeping.run)}'s run?` : ""}
        description={
          keeping?.method === "merge"
            ? `It's merged into ${keeping.options?.merge.target ?? "main"} in your folder.${discardText}`
            : keeping?.method === "pr"
              ? `Its branch is pushed and opened as a draft PR against ${keeping.options?.pr.base ?? "main"}.${discardText}`
              : `${discardText.trim() || "Nothing else changes."}`
        }
        confirmLabel={keeping?.method === "merge" ? "Keep and merge" : keeping?.method === "pr" ? "Keep and open PR" : "Keep"}
        onConfirm={() => void keep()}
      />
    </>
  );
}

function RunColumn({
  run,
  model,
  now,
  changes,
  kept,
  busy,
  disabled,
  onKeep,
}: {
  run: TaskConversation;
  model: string;
  now: number;
  changes: Changes | undefined;
  /** This run was kept (true), another one was (false), or none yet (null). */
  kept: boolean | null;
  busy: boolean;
  disabled: boolean;
  onKeep: () => void;
}) {
  const { status, stats, checks, repo, landing, summary, result, progress, goal } = run.task;
  const finished = !isOpenTask(status);
  const elapsed = taskElapsed(run.task, now);
  const CheckIcon = checks ? CHECK_ICONS[checks.state] : null;
  const text = finished ? (result?.summary ?? summary) : (progress ?? (status === "queued" ? "Waiting in line" : goal));
  const fileCount = changes?.status === "ready" ? changes.changes.files.length : stats?.files;

  return (
    <div className={cardClass({ className: "flex h-full flex-col gap-4" })}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{runLabel(run)}</p>
          <p className="truncate text-xs text-fg-subtle">
            {model}
            {elapsed ? ` · ${elapsed}` : ""}
          </p>
        </div>
        {landing ? (
          <Badge tone={kept ? "success" : "neutral"}>{kept ? "Kept" : landing.kind === "discarded" ? "Discarded" : landingLine(landing)}</Badge>
        ) : (
          <TaskStatusBadge status={status} />
        )}
      </div>

      {repo && (
        <div className="space-y-1 text-xs text-fg-subtle">
          <p className="flex min-w-0 items-center gap-1.5">
            <GitBranch className="size-3.5 shrink-0" />
            <span className="truncate font-mono">{repo.branch}</span>
          </p>
          <p className="font-mono tabular-nums">
            {stats ? (
              <>
                <span className="text-success">+{stats.added}</span> <span className="text-danger">−{stats.removed}</span> · {fileCount} file{fileCount === 1 ? "" : "s"}
              </>
            ) : (
              "No changes yet"
            )}
          </p>
        </div>
      )}

      {checks && CheckIcon && (
        <div className="space-y-1">
          <p className={clsx("flex items-center gap-1.5 text-xs font-medium", checks.state === "failing" ? "text-danger" : checks.state === "passing" ? "text-success" : "text-fg-muted")}>
            <CheckIcon className={clsx("size-3.5", checks.state === "running" && "animate-spin")} />
            {CHECKS_LABELS[checks.state]}
          </p>
          {checks.lines.length > 0 && (
            <ul className="space-y-0.5 pl-5 text-xs text-fg-subtle">
              {checks.lines.map((line) => (
                <li key={line} className="truncate">
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {text && <p className="line-clamp-[8] text-ui leading-relaxed whitespace-pre-line text-fg-muted">{text}</p>}
      {changes?.status === "error" && <p className="text-xs text-danger">Couldn't load its changes. {changes.message}</p>}

      <div className="mt-auto flex items-center gap-2 pt-1">
        <Button size="sm" variant="ghost" onClick={() => navigateToConversation(run.id)}>
          Open
          <ArrowUpRight />
        </Button>
        {landing?.pr && (
          <a href={landing.pr.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-0.5 text-ui link-muted">
            PR #{landing.pr.number}
            <ArrowUpRight className="size-3.5" />
          </a>
        )}
        {kept === null && (
          <Button size="sm" className="ml-auto" disabled={!finished || disabled} onClick={onKeep}>
            {busy ? "Keeping…" : "Keep this one"}
          </Button>
        )}
      </div>
    </div>
  );
}
