import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { TaskChanges } from "@tot/shared/types";
import { api, errorMessage } from "../../lib/api";
import type { TaskConversation } from "../../lib/tasks";
import { Callout } from "../ui/Callout";
import { IconButton } from "../ui/IconButton";
import { Skeleton } from "../ui/Skeleton";
import { Tip } from "../ui/Tip";
import { ChangedFiles } from "./ChangedFiles";

/**
 * A coding task's changes against its base: files with +/− counts; open one to read its diff. Read-only.
 * Once it's merged or discarded its worktree is gone, and the Land bar under this tab says where the code went.
 */
export function ChangesTab({ task }: { task: TaskConversation }) {
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; changes: TaskChanges }>({ status: "loading" });
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
          <ChangedFiles files={changes.files} patch={changes.patch} />
          {changes.truncated && <p className="text-xs text-fg-subtle">The diff is large; some of it isn't shown.</p>}
        </>
      )}
    </div>
  );
}
