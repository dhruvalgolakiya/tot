import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { ChevronRight, RefreshCw } from "lucide-react";
import type { TaskChangedFile, TaskChanges } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import type { TaskConversation } from "../../lib/tasks";
import { Callout } from "../ui/Callout";
import { IconButton } from "../ui/IconButton";
import { Skeleton } from "../ui/Skeleton";
import { Tip } from "../ui/Tip";

const STATUS_LETTERS: Record<TaskChangedFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

/** The unified diff split per file, keyed by the file's (new) path. */
function splitPatch(patch: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    if (header) files.set(header[2]!, chunk);
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

/**
 * A coding task's changes against its base: files with +/− counts; open one to read its diff. Read-only.
 * Once it's merged or discarded its worktree is gone, and the Land bar under this tab says where the code went.
 */
export function ChangesTab({ task }: { task: TaskConversation }) {
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; changes: TaskChanges }>({ status: "loading" });
  const [openFile, setOpenFile] = useState<string | null>(null);
  const landed = task.task.landing?.kind === "merged" || task.task.landing?.kind === "discarded" ? task.task.landing.kind : null;
  const headSha = landed ? null : (task.task.repo?.headSha ?? null);

  const load = useCallback(async () => {
    setState((current) => (current.status === "ready" ? current : { status: "loading" }));
    try {
      setState({ status: "ready", changes: await api.taskChanges(task.id) });
    } catch (error) {
      setState({ status: "error", message: errorMessage(error) });
    }
  }, [task.id]);

  // Reload whenever the branch moves (the task committed) or the task's status changes.
  useEffect(() => {
    if (headSha) void load();
  }, [load, headSha, task.task.status]);

  const patches = useMemo(() => (state.status === "ready" ? splitPatch(state.changes.patch) : new Map<string, string>()), [state]);

  if (landed === "merged") return <p className="text-sm text-fg-subtle">These changes are merged, and the task's worktree was removed.</p>;
  if (landed === "discarded") return <p className="text-sm text-fg-subtle">These changes were discarded with the task's worktree.</p>;
  if (!headSha) return <p className="text-sm text-fg-subtle">The branch is set up when the task starts; its changes show up here.</p>;
  if (state.status === "loading") {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Loading changes">
        {[70, 55, 80].map((width) => (
          <Skeleton key={width} className="h-4" style={{ width: `${width}%` }} />
        ))}
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
        Couldn't load the changes. {state.message}
      </Callout>
    );
  }

  const { changes } = state;
  const additions = changes.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = changes.files.reduce((sum, file) => sum + file.deletions, 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-xs text-fg-subtle">
          <span className="font-mono">{changes.branch}</span> against <span className="font-mono">{changes.baseBranch}</span>
        </p>
        <Tip content="Refresh">
          <IconButton label="Refresh changes" size="sm" onClick={() => void load()}>
            <RefreshCw />
          </IconButton>
        </Tip>
      </div>

      {changes.files.length === 0 ? (
        <p className="text-sm text-fg-subtle">No changes yet.</p>
      ) : (
        <>
          <p className="text-xs text-fg-subtle tabular-nums">
            {changes.files.length} file{changes.files.length === 1 ? "" : "s"} · <span className="text-success">+{additions}</span>{" "}
            <span className="text-danger">−{deletions}</span>
          </p>
          <ul className="divide-y divide-hairline overflow-hidden rounded-xl border border-hairline">
            {changes.files.map((file) => {
              const expanded = openFile === file.path;
              const patch = patches.get(file.path);
              return (
                <li key={file.path}>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpenFile(expanded ? null : file.path)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-hover focus-visible:-outline-offset-2"
                  >
                    <ChevronRight className={clsx("size-3.5 shrink-0 text-fg-subtle transition-transform", expanded && "rotate-90")} />
                    <span className="w-3 shrink-0 font-mono text-xs text-fg-subtle" title={file.status}>
                      {STATUS_LETTERS[file.status]}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-ui text-fg" title={file.path}>
                      {file.path}
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums">
                      <span className="text-success">+{file.additions}</span> <span className="text-danger">−{file.deletions}</span>
                    </span>
                  </button>
                  {expanded && (
                    <pre className="max-h-96 overflow-auto border-t border-hairline bg-sunken py-1 font-mono text-xs leading-relaxed">
                      {/* As wide as the longest line, so added and removed lines stay shaded when scrolled sideways. */}
                      <div className="inline-block min-w-full">
                        {(patch ?? "No diff to show (binary or too large).").split("\n").map((line, index) => (
                          <div key={index} className={clsx("px-3 whitespace-pre", lineClass(line))}>
                            {line || " "}
                          </div>
                        ))}
                      </div>
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
          {changes.truncated && <p className="text-xs text-fg-subtle">The diff is large; some of it isn't shown.</p>}
        </>
      )}
    </div>
  );
}
