import { useCallback, useEffect, useState, type ComponentType } from "react";
import clsx from "clsx";
import {
  CloudUpload,
  Download,
  FileClock,
  FileMinus,
  FilePen,
  FilePlus,
  FileText,
  Flag,
  FolderInput,
  Minus,
  MoonStar,
  Pencil,
  Plus,
  RefreshCw,
  SquarePen,
  Undo2,
} from "lucide-react";
import type { KnowledgeCommit, MemoryCommit, Project } from "@tot/shared/types";
import { api, errorMessage } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { commitActor, describeCommit, projectMemoryRepo, useMemoryUi } from "../../lib/memory";
import { notifyError } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { Callout } from "../ui/Callout";
import { cardClass } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { Skeleton } from "../ui/Skeleton";
import { Tip } from "../ui/Tip";

type Icon = ComponentType<{ className?: string }>;

/** As Settings → Memory's history (module 10). */
const ICONS: Record<MemoryCommit["kind"], Icon> = {
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

/** A change to pages (rather than facts) shows a page icon. */
const PAGE_ICONS: Record<KnowledgeCommit["pages"][number]["action"], Icon> = {
  created: FilePlus,
  edited: FilePen,
  moved: FolderInput,
  deleted: FileMinus,
  restored: FileClock,
  imported: Download,
};

const PAGE = 10;
/** Page titles listed under a change before "+N more". */
const TITLES = 3;

function iconFor(commit: KnowledgeCommit): Icon {
  const first = commit.pages[0];
  if (first && (commit.kind === "remember" || commit.kind === "edit" || commit.kind === "forget")) return PAGE_ICONS[first.action];
  return ICONS[commit.kind];
}

/**
 * The Knowledge page's History view (roadmap module 11), under the updates: one timeline of the project's facts and pages, newest
 * first. The pages a change touched are listed under it (open them from there); Undo puts back what one change did.
 */
export function KnowledgeHistory({
  project,
  pageIds,
  onOpenPage,
  onChanged,
}: {
  project: Project;
  /** The pages the wiki has now (once loaded): a page gone since can't be opened. */
  pageIds: Set<string> | null;
  onOpenPage: (pageId: string) => void;
  onChanged: () => void;
}) {
  const version = useMemoryUi((s) => s.versions[projectMemoryRepo(project.slug)] ?? 0);
  const [commits, setCommits] = useState<KnowledgeCommit[] | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<KnowledgeCommit | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.knowledgeHistory(project.id, { limit: limit + 1 });
      setMore(list.length > limit);
      setCommits(list.slice(0, limit));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [project.id, limit]);

  useEffect(() => {
    void load();
  }, [load, version]);

  async function undo(commit: KnowledgeCommit) {
    try {
      await api.undoKnowledge(project.id, commit.sha);
      void load();
      onChanged();
    } catch (err) {
      // 409: later changes touched the same lines (the server says so).
      notifyError(err);
    }
  }

  return (
    <section className="space-y-2">
      <h2 className="group-label px-1">Every change</h2>
      {error && !commits && (
        <Callout
          tone="danger"
          action={
            <button type="button" onClick={() => void load()} className="link-muted">
              Retry
            </button>
          }
        >
          Couldn't load the history. {error}
        </Callout>
      )}
      {!error && !commits && (
        <div className="space-y-2" aria-busy="true" aria-label="Loading history">
          <Skeleton className="h-14 rounded-xl" />
          <Skeleton className="h-14 rounded-xl" />
          <Skeleton className="h-14 rounded-xl" />
        </div>
      )}
      {commits && commits.length === 0 && (
        <EmptyState variant="quiet" title="No changes yet." />
      )}
      {commits && commits.length > 0 && (
        <>
          <ul className={cardClass({ padding: "none" })}>
            {commits.map((commit, index) => (
              <CommitRow key={commit.sha} commit={commit} first={index === 0} pageIds={pageIds} onOpenPage={onOpenPage} onUndo={() => setUndoing(commit)} />
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
        description={undoing ? `${describeCommit(undoing)}, by ${commitActor(undoing)}. A new change puts back what it changed; nothing else is touched.` : ""}
        confirmLabel="Undo"
        onConfirm={() => undoing && void undo(undoing)}
      />
    </section>
  );
}

function CommitRow({
  commit,
  first,
  pageIds,
  onOpenPage,
  onUndo,
}: {
  commit: KnowledgeCommit;
  first: boolean;
  pageIds: Set<string> | null;
  onOpenPage: (pageId: string) => void;
  onUndo: () => void;
}) {
  const Icon = iconFor(commit);
  const text = describeCommit(commit);
  // One page, already named in the line ("Edited page “Cart”"): its title there opens it, with no list under it.
  const only = commit.pages.length === 1 ? commit.pages[0]! : null;
  const named = only ? text.indexOf(`“${only.title}”`) : -1;
  const listsDetails = commit.kind === "dream" || commit.kind === "sync" || (commit.kind === "import" && !commit.pages.length);
  const details = listsDetails ? commit.body.split("\n").filter(Boolean).slice(0, 3) : [];

  return (
    <li className={clsx("group flex items-start gap-3 py-2.5 pr-2 pl-4", !first && "border-t border-hairline")}>
      <Icon className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm text-fg [overflow-wrap:anywhere]" title={commit.subject}>
          {only && named >= 0 ? (
            <>
              {text.slice(0, named + 1)}
              <PageTitle page={only} pageIds={pageIds} onOpen={onOpenPage} inline />
              {text.slice(named + 1 + only.title.length)}
            </>
          ) : (
            text
          )}
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
        {commit.pages.length > 0 && named < 0 && <PageTitles pages={commit.pages} pageIds={pageIds} onOpen={onOpenPage} />}
      </div>
      {commit.revertible ? (
        <Tip content="Undo">
          <IconButton
            label="Undo this change"
            size="sm"
            onClick={onUndo}
            className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
          >
            <Undo2 />
          </IconButton>
        </Tip>
      ) : (
        <span className="size-7 shrink-0" aria-hidden="true" />
      )}
    </li>
  );
}

/** "Checkout flow, Payments, Cart +2 more": the pages a change touched, each opening the page (one deleted or gone since can't). */
function PageTitles({ pages, pageIds, onOpen }: { pages: KnowledgeCommit["pages"]; pageIds: Set<string> | null; onOpen: (pageId: string) => void }) {
  const shown = pages.slice(0, TITLES);
  const rest = pages.length - shown.length;
  return (
    <div className="mt-1 flex items-start gap-1.5 text-xs text-fg-subtle">
      <FileText className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <p className="min-w-0 [overflow-wrap:anywhere]">
        {shown.map((page, index) => (
          <span key={page.id}>
            <PageTitle page={page} pageIds={pageIds} onOpen={onOpen} />
            {index < shown.length - 1 && ", "}
          </span>
        ))}
        {rest > 0 && ` +${rest}\u00a0more`}
      </p>
    </div>
  );
}

/** A page's title that opens it; a page deleted (or gone since) is just its title. */
function PageTitle({
  page,
  pageIds,
  onOpen,
  inline = false,
}: {
  page: KnowledgeCommit["pages"][number];
  pageIds: Set<string> | null;
  onOpen: (pageId: string) => void;
  /** Inside the change's own line (text-fg): a quiet underline instead of the muted link style. */
  inline?: boolean;
}) {
  if (page.action === "deleted") {
    return (
      <span className="line-through decoration-fg-faint" title="Deleted">
        {page.title}
      </span>
    );
  }
  if (pageIds && !pageIds.has(page.id)) return <span title="No longer in Knowledge">{page.title}</span>;
  return (
    <button
      type="button"
      onClick={() => onOpen(page.id)}
      title="Open the page"
      className={
        inline
          ? "underline decoration-edge-strong underline-offset-2 transition-colors hover:decoration-fg-muted"
          : "link-muted font-normal"
      }
    >
      {page.title}
    </button>
  );
}
