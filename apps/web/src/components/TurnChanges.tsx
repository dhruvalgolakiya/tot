import { useEffect, useState } from "react";
import clsx from "clsx";
import { ChevronRight, FileDiff } from "lucide-react";
import type { TurnChanges as Changes, TurnDiff } from "@tot/shared/types";
import { api, errorMessage } from "../lib/api";
import { ChangedFiles } from "./tasks/ChangedFiles";
import { Callout } from "./ui/Callout";
import { Skeleton } from "./ui/Skeleton";

/** At the end of a turn that changed files: "3 files changed +42 −7", opening to the files and their diffs (loaded then). */
export function TurnChanges({ conversationId, messageId, changes }: { conversationId: string; messageId: string; changes: Changes }) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [diff, setDiff] = useState<TurnDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || diff) return;
    let current = true;
    setError(null);
    api.turnChanges(conversationId, messageId).then(
      (found) => current && setDiff(found),
      (failed: unknown) => current && setError(errorMessage(failed)),
    );
    return () => {
      current = false;
    };
  }, [open, diff, conversationId, messageId, attempt]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex h-7 min-w-0 items-center gap-1.5 text-sm text-fg-muted transition-colors hover:text-fg"
      >
        <FileDiff className="size-4 shrink-0" />
        <span className="truncate">
          {changes.files} file{changes.files === 1 ? "" : "s"} changed
        </span>
        <span className="shrink-0 text-xs tabular-nums">
          <span className="text-success">+{changes.additions}</span> <span className="text-danger">−{changes.deletions}</span>
        </span>
        <ChevronRight className={clsx("size-3.5 shrink-0 text-fg-subtle transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mt-1.5">
          {diff ? (
            <div className="space-y-2">
              <ChangedFiles files={diff.files} patch={diff.patch} />
              {diff.truncated && <p className="text-xs text-fg-subtle">The diff is large; some of it isn't shown.</p>}
            </div>
          ) : error !== null ? (
            <Callout
              tone="danger"
              action={
                <button type="button" onClick={() => setAttempt((n) => n + 1)} className="link-muted">
                  Try again
                </button>
              }
            >
              Couldn't load the changes. {error}
            </Callout>
          ) : (
            <div className="space-y-2" aria-busy="true" aria-label="Loading changes">
              {[70, 55].map((width) => (
                <Skeleton key={width} className="h-4" style={{ width: `${width}%` }} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
