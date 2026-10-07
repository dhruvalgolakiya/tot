import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import type { HomeProject } from "@shared/types";
import { useAppEvents } from "../../hooks/useAppEvents";
import { homeCounts, loadHome } from "../../lib/lead";
import { PROJECT_ICONS, shortTime } from "../../lib/projects";
import { projectPath } from "../../lib/router";
import { navigateToProject, selectActiveAgentId, useStore } from "../../store";
import { LedgerMore, LedgerRow, LedgerSection } from "../home/Ledger";
import { StatusDot } from "../ui/StatusDot";

/**
 * Home (roadmap module 11, lane D): every project as one row in the ledger on an agent's home: what needs you,
 * what's working and what's ready to land, and when it last moved. A row opens the project's page, which is
 * its Lead. Kept live, a moment after tasks, chats or projects change.
 */

const REFETCH_MS = 800;
const SHOWN = 4;

/** Home's project rows, kept live; null while loading, empty when there are none (or they couldn't load). */
export function useHomeProjects(): HomeProject[] | null {
  const [rows, setRows] = useState<HomeProject[] | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    try {
      const home = await loadHome();
      if (id === request.current) setRows(home);
    } catch {
      // Quiet: Home just shows no projects section; the sidebar still lists the projects.
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

  return rows;
}

export function ProjectsSection({ rows, now }: { rows: HomeProject[]; now: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, SHOWN);
  return (
    <LedgerSection label="Projects" count={rows.length}>
      {shown.map((row) => (
        <ProjectRow key={`${row.project.deviceId ?? ""}:${row.project.id}`} row={row} now={now} />
      ))}
      {rows.length > SHOWN && <LedgerMore label={all ? "Show fewer" : `Show all · ${rows.length}`} onClick={() => setAll((value) => !value)} />}
    </LedgerSection>
  );
}

/** One project; the row opens its page (its Lead). */
function ProjectRow({ row, now }: { row: HomeProject; now: number }) {
  const agentId = useStore(selectActiveAgentId);
  const { project } = row;
  const Icon = PROJECT_ICONS[project.kind];

  const open = (event: MouseEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigateToProject(project.id);
  };

  return (
    <LedgerRow
      href={agentId ? projectPath(agentId, project.id) : undefined}
      onClick={open}
      leading={<Icon aria-hidden="true" className="size-4 text-fg-muted" />}
      title={project.name}
      detail={homeCounts(row) ?? "Nothing in flight"}
      trailing={
        <>
          {row.needsYou > 0 ? <StatusDot tone="amber" /> : row.working > 0 ? <StatusDot tone="green" pulse /> : null}
          {row.lastActivityAt !== null && <span>{shortTime(row.lastActivityAt, now)}</span>}
        </>
      }
    />
  );
}
