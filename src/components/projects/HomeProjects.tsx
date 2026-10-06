import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { HomeProject } from "@shared/types";
import { useAppEvents } from "../../hooks/useAppEvents";
import { useNow } from "../../hooks/useNow";
import { homeCounts, loadHome } from "../../lib/lead";
import { PROJECT_ICONS, shortTime } from "../../lib/projects";
import { projectPath } from "../../lib/router";
import { navigateToProject, selectActiveAgentId, useStore } from "../../store";
import { StatusDot } from "../ui/StatusDot";

/**
 * Home (roadmap module 11, lane D): under the composer on an agent's home, every project as one row: what
 * needs you, what's working and what's ready to land, when it last moved, and its Lead (the row opens the
 * project's page, which is its Lead). Kept live, a moment after tasks, chats or projects change. With no
 * projects, `fallback` shows instead (the starter prompts).
 */

const REFETCH_MS = 800;
const SHOWN = 5;

export function HomeProjects({ fallback }: { fallback: ReactNode }) {
  const [rows, setRows] = useState<HomeProject[] | null>(null);
  const [all, setAll] = useState(false);
  const now = useNow(true, 60_000);
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    try {
      const home = await loadHome();
      if (id === request.current) setRows(home);
    } catch {
      // Quiet: Home falls back to the starter prompts; the sidebar still lists the projects.
      if (id === request.current) setRows((current) => current ?? []);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useAppEvents(
    (event) => {
      if (event.type !== "task" && event.type !== "project" && event.type !== "conversation" && event.type !== "conversation-deleted") return;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void load(), REFETCH_MS);
    },
    () => void load(),
  );

  if (rows === null) return <div aria-busy="true" aria-label="Loading projects" />;
  if (!rows.length) return <>{fallback}</>;
  const shown = all ? rows : rows.slice(0, SHOWN);

  return (
    <section aria-labelledby="home-projects" className="mx-auto w-full max-w-3xl px-3 sm:px-4">
      <h2 id="home-projects" className="group-label px-2.5 pb-1">
        Projects
      </h2>
      <ul className="space-y-px">
        {shown.map((row) => (
          <li key={row.project.id}>
            <HomeRow row={row} now={now} />
          </li>
        ))}
      </ul>
      {rows.length > SHOWN && (
        <button
          type="button"
          onClick={() => setAll((value) => !value)}
          className="mt-1 flex h-8 items-center rounded-lg px-2.5 text-xs text-fg-subtle transition-colors hover:bg-hover hover:text-fg-muted"
        >
          {all ? "Show fewer" : `Show all · ${rows.length}`}
        </button>
      )}
    </section>
  );
}

/** One project: the row opens its page (its Lead); "Open Lead" says so. */
function HomeRow({ row, now }: { row: HomeProject; now: number }) {
  const agentId = useStore(selectActiveAgentId);
  const { project } = row;
  const Icon = PROJECT_ICONS[project.kind];
  const counts = homeCounts(row);

  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigateToProject(project.id);
  };

  return (
    <a
      href={agentId ? projectPath(agentId, project.id) : undefined}
      onClick={open}
      className="group/home flex min-h-12 w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-1.5 text-sm text-fg transition-colors hover:bg-hover focus-visible:-outline-offset-2"
    >
      <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
      <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-3">
        <span className="truncate font-medium sm:w-40 sm:shrink-0">{project.name}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-subtle">
          {row.needsYou > 0 && <StatusDot tone="amber" />}
          {row.needsYou === 0 && row.working > 0 && <StatusDot tone="green" pulse />}
          <span className="truncate">{counts ?? "Nothing in flight"}</span>
        </span>
      </span>
      {row.lastActivityAt !== null && <span className="shrink-0 text-xs text-fg-subtle tabular-nums max-sm:hidden">{shortTime(row.lastActivityAt, now)}</span>}
      <span
        aria-hidden="true"
        className="inline-flex h-7 shrink-0 items-center rounded-full border border-edge px-3 text-xs font-medium text-fg-muted transition-colors group-hover/home:border-edge-strong group-hover/home:text-fg"
      >
        Open Lead
      </span>
    </a>
  );
}
