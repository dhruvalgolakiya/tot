import { LoaderCircle } from "lucide-react";
import type { KnowledgeStatus, Project } from "@tot/shared/types";
import { projectMemoryRepo } from "../../lib/memory";
import { MemoryEntries } from "../memory/MemoryEntries";
import { Callout } from "../ui/Callout";
import { Skeleton } from "../ui/Skeleton";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * A project's Facts in the Knowledge page (roadmap modules 10 and 11): its memory entries, loaded at the start of
 * every chat in the project. One quiet line says how many and where they live; the list adds with a one-line field.
 */
export function KnowledgeFacts({
  project,
  status,
  statusError,
  onRetry,
  onChanged,
}: {
  project: Project;
  status: KnowledgeStatus | null;
  statusError: string | null;
  onRetry: () => void;
  onChanged: () => void;
}) {
  const repo = projectMemoryRepo(project.slug);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8">
        <h1 className="text-2xl font-semibold tracking-[-0.01em] text-fg-strong sm:text-display">Facts</h1>
        <div className="mt-1.5 mb-6">
          <StatusLine status={status} error={statusError} onRetry={onRetry} />
        </div>
        <MemoryEntries key={repo} repo={repo} kind="project" compact onChanged={onChanged} />
      </div>
    </div>
  );
}

/** One quiet line: the count, that they load in every chat, and the folder; while the wiki moves into git, or after that failed, a note instead. */
function StatusLine({ status, error, onRetry }: { status: KnowledgeStatus | null; error: string | null; onRetry: () => void }) {
  if (!status) {
    if (error) {
      return (
        <Callout
          tone="danger"
          action={
            <button type="button" onClick={onRetry} className="link-muted">
              Retry
            </button>
          }
        >
          Couldn't load this project's knowledge. {error}
        </Callout>
      );
    }
    return (
      <div className="flex h-5 items-center" aria-busy="true" aria-label="Loading knowledge">
        <Skeleton className="h-3.5 w-3/5" />
      </div>
    );
  }
  if (status.state === "database" && status.error) {
    return (
      <Callout tone="warning">
        The pages couldn't move into git yet; they work as before and TOT tries again at the next start.
        <span className="mt-1 block font-mono text-xs opacity-80">{status.error}</span>
      </Callout>
    );
  }
  if (status.state === "moving") {
    return (
      <p className="flex h-5 items-center gap-1.5 text-sm text-fg-muted">
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
        Moving the pages into git…
      </p>
    );
  }
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm text-fg-muted tabular-nums">
      <span>{plural(status.facts, "fact", "facts")}, loaded in every chat</span>
      <span className="hidden text-fg-subtle sm:inline">·</span>
      <span className="hidden min-w-0 truncate font-mono text-xs text-fg-subtle sm:inline" title="This project's pages and facts, in one git repo on this Mac">
        {status.path}
      </span>
    </p>
  );
}
