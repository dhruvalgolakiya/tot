import { Fragment, useCallback, useEffect, useState, type ComponentType } from "react";
import clsx from "clsx";
import { GitBranch, GitMerge, LoaderCircle, MessageSquare, MoonStar } from "lucide-react";
import type { KnowledgeTrigger, KnowledgeUpdate, Project } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { projectMemoryRepo, useMemoryUi } from "../../lib/memory";
import { notifyError } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { cardClass } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { Skeleton } from "../ui/Skeleton";

/**
 * Module 11 (docs/roadmap/11-workspaces.md), lane C: a project's knowledge auto-updates, newest first: "Updated
 * after “Fix cart” · 2 pages, 1 fact", with Undo (confirmed) on hover and runs in progress on top. The Knowledge
 * page's History view shows it above every change (Check now lives in that view's header). Reloads on `memory`
 * events for the project's knowledge repo, which every change to the log sends. Knowledge stays on its device:
 * nothing for another device's project.
 */

const ICONS: Record<KnowledgeTrigger, ComponentType<{ className?: string }>> = {
  landed: GitMerge,
  "base-moved": GitBranch,
  manual: GitBranch,
  chat: MessageSquare,
  dreaming: MoonStar,
};

const PAGE = 6;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 pages, 1 fact"; empty when it changed nothing. */
function changeText(update: KnowledgeUpdate): string {
  return [update.pages.length && plural(update.pages.length, "page"), update.facts && plural(update.facts, "fact")].filter(Boolean).join(", ");
}

const undoable = (update: KnowledgeUpdate) => !update.running && !update.undoneAt && !update.error && (update.sha !== null || update.pages.length > 0);

export function KnowledgeUpdates({ project, onOpenPage }: { project: Project; onOpenPage: (pageId: string) => void }) {
  const repo = projectMemoryRepo(project.slug);
  const version = useMemoryUi((s) => s.versions[repo] ?? 0);
  const remote = Boolean(project.deviceId);
  const [updates, setUpdates] = useState<KnowledgeUpdate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [undoing, setUndoing] = useState<KnowledgeUpdate | null>(null);

  const load = useCallback(async () => {
    try {
      setUpdates(await api.knowledgeUpdates(project.id));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [project.id]);

  useEffect(() => {
    if (!remote) void load();
  }, [load, version, remote]);

  if (remote) return null;

  async function undo(update: KnowledgeUpdate) {
    try {
      await api.undoKnowledgeUpdate(project.id, update.id);
      void load();
    } catch (err) {
      notifyError(err);
    }
  }

  const shown = updates?.slice(0, limit) ?? [];

  return (
    <section className="space-y-2">
      <h2 className="group-label px-1">Updates after chats and landed tasks</h2>
      {error && !updates && (
        <Callout
          tone="danger"
          action={
            <button type="button" className="link-muted" onClick={() => void load()}>
              Try again
            </button>
          }
        >
          Couldn't load the updates.
        </Callout>
      )}
      {!error && !updates && (
        <div aria-busy aria-label="Loading updates">
          <Skeleton className="h-28 rounded-xl" />
        </div>
      )}
      {updates && !updates.length && (
        <EmptyState variant="quiet" title="None yet. After a chat or a landed task, TOT updates the pages and facts here." />
      )}
      {shown.length > 0 && (
        <>
          <ul className={cardClass({ padding: "none" })}>
            {shown.map((update, index) => (
              <UpdateRow
                key={update.id}
                update={update}
                first={index === 0}
                onOpenPage={onOpenPage}
                onUndo={() => setUndoing(update)}
              />
            ))}
          </ul>
          {updates!.length > limit && (
            <button type="button" className="link-muted text-xs" onClick={() => setLimit((n) => n + 20)}>
              Show older updates
            </button>
          )}
        </>
      )}
      <ConfirmDialog
        open={Boolean(undoing)}
        onOpenChange={(open) => !open && setUndoing(null)}
        title="Undo this update?"
        description={
          undoing
            ? `“${undoing.summary}”. ${changeText(undoing) ? `Its ${changeText(undoing)} go back` : "What it changed goes back"} to how they were, as a new change; nothing else is touched.`
            : ""
        }
        confirmLabel="Undo"
        onConfirm={() => undoing && void undo(undoing)}
      />
    </section>
  );
}

function UpdateRow({
  update,
  first,
  onOpenPage,
  onUndo,
}: {
  update: KnowledgeUpdate;
  first: boolean;
  onOpenPage: ((pageId: string) => void) | null;
  onUndo: () => void;
}) {
  const Icon = ICONS[update.trigger] ?? GitBranch;
  const busy = update.running && !update.error;
  const changed = changeText(update);
  const meta = [changed, update.undoneAt ? "Undone" : "", relativeTime(update.undoneAt ?? update.at)].filter(Boolean).join(" · ");

  return (
    <li className={clsx("group flex items-start gap-3 px-4 py-2.5", !first && "border-t border-hairline")}>
      {busy ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-fg-subtle" /> : <Icon className="mt-0.5 size-4 shrink-0 text-fg-subtle" />}
      <div className="min-w-0 flex-1">
        <p className={clsx("line-clamp-2 text-sm [overflow-wrap:anywhere]", update.undoneAt ? "text-fg-muted" : "text-fg")} title={update.summary}>
          {update.summary}
          {busy && "…"}
        </p>
        <p className="mt-0.5 text-xs text-fg-subtle tabular-nums">{meta}</p>
        {update.error && <p className={clsx("mt-0.5 line-clamp-2 text-xs", update.running ? "text-warning" : "text-danger")}>{update.error}</p>}
        {update.pages.length > 0 && !update.undoneAt && (
          <p className="mt-0.5 truncate text-xs text-fg-muted">
            {update.pages.map((page, index) => (
              <Fragment key={page.id}>
                {index > 0 && ", "}
                {onOpenPage ? (
                  <button type="button" className="link-muted" onClick={() => onOpenPage(page.id)}>
                    {page.title}
                  </button>
                ) : (
                  page.title
                )}
              </Fragment>
            ))}
          </p>
        )}
      </div>
      {undoable(update) && (
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
