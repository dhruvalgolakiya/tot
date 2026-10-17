import { Suspense, useEffect, useState } from "react";
import type { Project } from "@tot/shared/types";
import { api } from "../../lib/api";
import { lazyComponent } from "../../lib/lazyComponent";
import { selectActiveAgentId, useStore } from "../../store";

const ImportSessionsDialog = lazyComponent(() => import("./ImportSessionsDialog"), "ImportSessionsDialog");

/**
 * A quiet line under a code project's composer when Claude Code or Codex sessions ran in its folders since its last
 * import (or any, before the first), opening the import dialog. Asks quickly: on a large history it counts what's
 * been read so far.
 */
export function ProjectSessionsHint({ project }: { project: Project }) {
  const agentId = useStore(selectActiveAgentId);
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (open) return;
    let cancelled = false;
    api.listProjectSessions(project.id, { quick: true }).then(
      (list) => {
        if (cancelled) return;
        const since = list.lastImportAt ?? 0;
        setCount(list.sessions.filter((session) => !session.importedChatId && session.lastActivityAt > since).length);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [project.id, open]);

  return (
    <>
      {count > 0 && (
        <p className="mt-3 text-center text-xs text-fg-subtle">
          {count === 1 ? "1 new session" : `${count} new sessions`} here from Claude Code or Codex.{" "}
          <button
            type="button"
            className="link-muted"
            onClick={() => {
              setMounted(true);
              setOpen(true);
            }}
          >
            Import…
          </button>
        </p>
      )}
      {mounted && (
        <Suspense fallback={null}>
          <ImportSessionsDialog project={project} agentId={agentId ?? null} open={open} onOpenChange={setOpen} />
        </Suspense>
      )}
    </>
  );
}
