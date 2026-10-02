import { useEffect, useState } from "react";
import { toast } from "sonner";
import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import type { WikiAuthor, WikiPage, WikiRevision } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { selectActiveAgent, useStore } from "../../store";
import { LazyMarkdown } from "../LazyMarkdown";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { cardClass } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { Modal, ModalBody } from "../ui/Modal";
import { Skeleton } from "../ui/Skeleton";

type WikiHistoryDialogProps = {
  page: WikiPage;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestored: (page: WikiPage) => void;
};

/** Earlier versions of a wiki page (each one is the page's state right before a change), with restore. */
export function WikiHistoryDialog({ page, open, onOpenChange, onRestored }: WikiHistoryDialogProps) {
  const agent = useStore(selectActiveAgent);
  const agentName = agent?.name ?? "the agent";
  const [revisions, setRevisions] = useState<WikiRevision[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  function load() {
    setLoadError(null);
    api.listWikiRevisions(page.id).then(setRevisions, (error: unknown) => setLoadError(errorMessage(error)));
  }

  useEffect(() => {
    if (!open) return;
    setRevisions(null);
    load();
    // Refetch every time the dialog opens, in case it changed since last time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, page.id]);

  function handleRestored(updated: WikiPage) {
    onRestored(updated);
    onOpenChange(false);
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="History" description={page.title}>
      <ModalBody className="max-h-[65vh] min-h-24">
        {loadError && (
          <Callout tone="danger" action={<button type="button" onClick={load} className="link-muted">Retry</button>}>
            {loadError}
          </Callout>
        )}

        {!revisions && !loadError && (
          <div className="space-y-2" aria-busy="true" aria-label="Loading history">
            <Skeleton className="h-14 rounded-xl" />
            <Skeleton className="h-14 rounded-xl" />
            <Skeleton className="h-14 rounded-xl" />
          </div>
        )}

        {revisions && revisions.length === 0 && <EmptyState size="sm" title="No earlier versions yet." />}

        {revisions && revisions.length > 0 && (
          <ul className="space-y-2">
            {revisions.map((revision) => (
              <RevisionRow key={revision.id} pageId={page.id} revision={revision} agentName={agentName} onRestored={handleRestored} />
            ))}
          </ul>
        )}
      </ModalBody>
    </Modal>
  );
}

function authorLabel(updatedBy: WikiAuthor, agentName: string): string {
  if (updatedBy === "user") return "by you";
  if (updatedBy === "agent") return `by ${agentName}`;
  return "after a chat";
}

type RevisionRowProps = {
  pageId: string;
  revision: WikiRevision;
  agentName: string;
  onRestored: (page: WikiPage) => void;
};

function RevisionRow({ pageId, revision, agentName, onRestored }: RevisionRowProps) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    setRestoring(true);
    setError(null);
    try {
      const updated = await api.restoreWikiRevision(pageId, revision.id);
      toast.success("Restored");
      onRestored(updated);
    } catch (err) {
      setError(errorMessage(err));
      setRestoring(false);
      setConfirming(false);
    }
  }

  return (
    <li className={cardClass({ padding: "none" })}>
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left text-sm text-fg-muted transition-colors hover:text-fg"
        >
          <ChevronRight className={clsx("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
          <span className="truncate">
            <span className="font-medium text-fg">{authorLabel(revision.updatedBy, agentName)}</span>
            <span className="text-fg-subtle"> · {relativeTime(revision.createdAt)}</span>
          </span>
        </button>

        {confirming ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={restoring}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={() => void restore()} disabled={restoring}>
              {restoring ? "Restoring…" : "Restore this version?"}
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" className="shrink-0" onClick={() => setConfirming(true)}>
            Restore
          </Button>
        )}
      </div>

      {open && (
        <div className="border-t border-hairline px-3.5 py-3">
          <LazyMarkdown text={revision.content || "*Empty page.*"} muted />
        </div>
      )}

      {error && <p className="px-3.5 pb-3 text-xs text-danger">{error}</p>}
    </li>
  );
}
