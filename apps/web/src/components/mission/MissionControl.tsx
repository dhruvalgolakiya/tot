import { useMemo, useState } from "react";
import { SquareKanban } from "lucide-react";
import type { MissionOverview } from "@tot/shared/types";
import { useNow } from "../../hooks/useNow";
import { boardSections, SECTION_TITLES, type MissionSection } from "../../lib/mission";
import { useProjects } from "../../lib/projects";
import { isTask, type TaskConversation } from "../../lib/tasks";
import { navigateToMission, useStore } from "../../store";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { Kbd } from "../ui/Kbd";
import { LedgerHeader, LedgerPanel, LedgerSection } from "../ui/Ledger";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";
import { Skeleton } from "../ui/Skeleton";
import { MissionRow } from "./MissionRow";
import { useMissionOverview } from "./useMissionOverview";

/**
 * Mission control (roadmap module 09): every task on one board, or one project's (`/mission?project=`).
 * Needs you first, then what's working, what's ready to land (in the order to land it) and, folded, what
 * landed today. The overview (overlaps, land order) is refetched shortly after any task changes; the
 * cards themselves read each task from the store, so their status and progress are live.
 */

const DESCRIPTIONS: Partial<Record<MissionSection, string>> = {
  ready: "In the order to land them: fewest overlaps with other tasks first, then the smallest.",
};

export function MissionControl() {
  const projectId = useStore((s) => s.missionProjectId);
  const { state, reload: load } = useMissionOverview(projectId);
  const overview = state.status === "ready" ? state.overview : null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 pt-20 pb-12 sm:px-6 md:pt-24">
        <PageHeader
          title="Mission control"
          description={
            <span className="flex items-center gap-2">
              Every task from every agent, and where it stands.
              <span className="hidden md:inline-flex">
                <Kbd keys={["mod", "shift", "M"]} />
              </span>
            </span>
          }
        />
        {state.status === "error" ? (
          <Callout
            tone="danger"
            className="mt-8"
            action={
              <button type="button" onClick={() => void load()} className="link-muted">
                Try again
              </button>
            }
          >
            Couldn't load your tasks. {state.message}
          </Callout>
        ) : (
          <LedgerPanel className="mt-8" header={<BoardHeader projectId={projectId} overview={overview} />}>
            {overview ? (
              <Board overview={overview} />
            ) : (
              <div aria-busy="true" aria-label="Loading tasks" className="space-y-1 p-2">
                {[0, 1, 2, 3].map((key) => (
                  <Skeleton key={key} className="h-10 rounded-lg" />
                ))}
              </div>
            )}
          </LedgerPanel>
        )}
      </div>
    </div>
  );
}

/** The board panel's header row: what's in flight, in one line, and the project filter. */
function BoardHeader({ projectId, overview }: { projectId: string | null; overview: MissionOverview | null }) {
  const projects = useProjects((s) => s.projects);
  const conversations = useStore((s) => s.conversations);
  const options = useMemo(
    () => [
      { value: "", label: "All projects" },
      ...projects.filter((p) => !p.archived || p.id === projectId).map((p) => ({ value: p.id, label: p.name })),
    ],
    [projects, projectId],
  );
  const counts = useMemo(() => {
    if (!overview) return null;
    const live = overview.tasks.map((t) => conversations.find((c) => c.id === t.conversation.id) ?? t.conversation).filter(isTask);
    const sections = boardSections(live, overview.landOrder);
    return [
      sections["needs-you"].length ? `${sections["needs-you"].length} need${sections["needs-you"].length === 1 ? "s" : ""} you` : null,
      sections.working.length ? `${sections.working.length} working` : null,
      sections.ready.length ? `${sections.ready.length} ready to land` : null,
    ].filter(Boolean);
  }, [overview, conversations]);

  return (
    <LedgerHeader
      title={projectId ? (projects.find((p) => p.id === projectId)?.name ?? "Project") : "All tasks"}
      meta={counts === null ? "Loading…" : counts.length ? counts.join(" · ") : "Nothing in flight"}
      action={
        <Select
          size="sm"
          aria-label="Project"
          value={projectId ?? ""}
          onValueChange={(value) => navigateToMission(value || null)}
          options={options}
          className="w-44"
        />
      }
    />
  );
}

function Board({ overview }: { overview: MissionOverview }) {
  const conversations = useStore((s) => s.conversations);
  const agents = useStore((s) => s.agents);
  const [showLanded, setShowLanded] = useState(false);
  // The store's copy of each task is the live one (task events); the overview's is a fallback until it arrives.
  const tasks = useMemo(
    () => overview.tasks.map((t) => conversations.find((c) => c.id === t.conversation.id) ?? t.conversation).filter(isTask),
    [overview, conversations],
  );
  const overlaps = useMemo(() => new Map(overview.tasks.map((t) => [t.conversation.id, t.overlaps])), [overview]);
  const sections = useMemo(() => boardSections(tasks, overview.landOrder), [tasks, overview.landOrder]);
  const now = useNow(sections.working.length > 0, 30_000);

  if (!tasks.length) {
    return (
      <EmptyState
        variant="quiet"
        className="py-3"
        icon={<SquareKanban />}
        title="No tasks here yet"
        description="Ask for real work in a chat (the agent starts a task when it needs one), or type /best-of to compare two attempts. Tasks show up here while they work, and until you land them."
      />
    );
  }

  const rows = (list: TaskConversation[]) =>
    list.map((task) => <MissionRow key={task.id} task={task} agent={agents.find((a) => a.id === task.agentId)} overlaps={overlaps.get(task.id) ?? []} now={now} />);

  return (
    <>
      {(["needs-you", "working", "ready"] as const).map(
        (key) =>
          sections[key].length > 0 && (
            <LedgerSection
              key={key}
              layout="stacked"
              label={SECTION_TITLES[key]}
              count={sections[key].length}
              tone={key === "needs-you" ? "warning" : "neutral"}
              description={DESCRIPTIONS[key]}
            >
              {rows(sections[key])}
            </LedgerSection>
          ),
      )}
      {sections.landed.length > 0 && (
        <LedgerSection
          layout="stacked"
          label={SECTION_TITLES.landed}
          count={sections.landed.length}
          collapsed={!showLanded}
          onToggle={() => setShowLanded((value) => !value)}
        >
          {rows(sections.landed)}
        </LedgerSection>
      )}
    </>
  );
}
