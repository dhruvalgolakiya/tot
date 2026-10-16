import { useState } from "react";
import clsx from "clsx";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { Project } from "@tot/shared/types";
import { api } from "../../lib/api";
import { memoryChanged, projectMemoryRepo } from "../../lib/memory";
import { notifyError } from "../../store";
import { Button } from "../ui/Button";
import { KnowledgeHistory } from "./KnowledgeHistory";
import { KnowledgeUpdates } from "./KnowledgeUpdates";

/**
 * A project's History in the Knowledge page (roadmap module 11): the updates TOT made after chats and landed tasks,
 * then every change to its pages and facts, each one undoable. Check now (projects with repos) sits in the header.
 * A page's own versions stay in that page's "…" menu.
 */
export function KnowledgeHistoryView({
  project,
  pageIds,
  onOpenPage,
  onChanged,
}: {
  project: Project;
  pageIds: Set<string> | null;
  onOpenPage: (pageId: string) => void;
  onChanged: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const hasRepos = (project.repos?.length ?? (project.kind !== "none" && project.source ? 1 : 0)) > 0;

  async function checkNow() {
    setChecking(true);
    try {
      const result = await api.refreshKnowledge(project.id);
      memoryChanged(projectMemoryRepo(project.slug));
      if (!result.moved) toast.success("Up to date");
    } catch (error) {
      notifyError(error);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8 sm:px-8">
        <div className="flex items-start justify-between gap-3">
          <h1 className="min-w-0 text-2xl font-semibold tracking-[-0.01em] text-fg-strong sm:text-display">History</h1>
          {hasRepos && (
            <Button size="sm" variant="ghost" disabled={checking} onClick={() => void checkNow()} className="mt-1 shrink-0">
              <RefreshCw className={clsx(checking && "animate-spin")} /> {checking ? "Checking…" : "Check now"}
            </Button>
          )}
        </div>
        <KnowledgeUpdates project={project} onOpenPage={onOpenPage} />
        <KnowledgeHistory project={project} pageIds={pageIds} onOpenPage={onOpenPage} onChanged={onChanged} />
      </div>
    </div>
  );
}
