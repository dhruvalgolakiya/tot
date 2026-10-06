import { useCallback, useEffect, useState, type ComponentType } from "react";
import clsx from "clsx";
import { CloudUpload, Download, Flag, Minus, MoonStar, Pencil, Plus, RefreshCw, SquarePen, Undo2 } from "lucide-react";
import type { MemoryCommit } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { commitActor, describeCommit, useMemoryUi } from "../../lib/memory";
import { notifyError } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { cardClass } from "../ui/Card";
import { SectionHeader } from "../ui/SectionHeader";
import { Skeleton } from "../ui/Skeleton";

const ICONS: Record<MemoryCommit["kind"], ComponentType<{ className?: string }>> = {
  start: Flag,
  import: Download,
  remember: Plus,
  edit: Pencil,
  forget: Minus,
  undo: Undo2,
  dream: MoonStar,
  sync: RefreshCw,
  backup: CloudUpload,
  outside: SquarePen,
};

const PAGE = 8;

/** A memory repo's commits, newest first, with Undo on each but syncs (roadmap module 10). */
export function MemoryHistory({ repo, onChanged }: { repo: string; onChanged: () => void }) {
  const version = useMemoryUi((s) => s.versions[repo] ?? 0);
  const [commits, setCommits] = useState<MemoryCommit[] | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<MemoryCommit | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.memoryHistory(repo, { limit: limit + 1 });
      setMore(list.length > limit);
      setCommits(list.slice(0, limit));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [repo, limit]);

  useEffect(() => {
    void load();
  }, [load, version]);

  async function undo(commit: MemoryCommit) {
    try {
      await api.revertMemory(repo, commit.sha);
      void load();
      onChanged();
    } catch (err) {
      notifyError(err);
    }
  }

  return (
    <section className="space-y-3">
      <SectionHeader title="History" description="Every change is a commit. Undo puts back what one changed, as a new change; a sync can't be undone." />
      {error && !commits && <Callout tone="danger">{error}</Callout>}
      {!error && !commits && <Skeleton className="h-40 rounded-xl" />}
      {commits && (
        <>
          <ul className={cardClass({ padding: "none" })}>
            {commits.map((commit, index) => (
              <CommitRow key={commit.sha} commit={commit} first={index === 0} onUndo={() => setUndoing(commit)} />
            ))}
          </ul>
          {more && (
            <button type="button" className="link-muted text-xs" onClick={() => setLimit((n) => n + 20)}>
              Show older changes
            </button>
          )}
        </>
      )}
      <ConfirmDialog
        open={Boolean(undoing)}
        onOpenChange={(open) => !open && setUndoing(null)}
        title="Undo this change?"
        description={undoing ? `“${describeCommit(undoing)}” by ${commitActor(undoing)}. A new change puts back what it changed; nothing else is touched.` : ""}
        confirmLabel="Undo"
        onConfirm={() => undoing && void undo(undoing)}
      />
    </section>
  );
}

function CommitRow({ commit, first, onUndo }: { commit: MemoryCommit; first: boolean; onUndo: () => void }) {
  const Icon = ICONS[commit.kind];
  const details = commit.kind === "dream" || commit.kind === "sync" || commit.kind === "import" ? commit.body.split("\n").filter(Boolean).slice(0, 3) : [];

  return (
    <li className={clsx("group flex items-start gap-3 px-4 py-2.5", !first && "border-t border-hairline")}>
      <Icon className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm text-fg [overflow-wrap:anywhere]" title={commit.subject}>
          {describeCommit(commit)}
        </p>
        <p className="mt-0.5 text-xs text-fg-subtle tabular-nums">
          {commitActor(commit)}
          {/* The first commit has the same fixed date on every device (so they share history): no time for it. */}
          {commit.kind !== "start" && ` · ${relativeTime(commit.at)}`}
          {commit.kind !== "start" && commit.added + commit.removed > 0 && (
            <>
              {" · "}+{commit.added} −{commit.removed}
            </>
          )}
        </p>
        {details.map((line) => (
          <p key={line} className="mt-0.5 truncate text-xs text-fg-muted" title={line}>
            {line.replace(/^- /, "")}
          </p>
        ))}
      </div>
      {commit.revertible && (
        <Button
          size="sm"
          variant="ghost"
          onClick={onUndo}
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          Undo
        </Button>
      )}
    </li>
  );
}
