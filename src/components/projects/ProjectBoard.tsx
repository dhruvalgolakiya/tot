import { useMemo, useState } from "react";
import { SquareKanban } from "lucide-react";
import type { Project } from "@shared/types";
import { useNow } from "../../hooks/useNow";
import { boardSections, SECTION_TITLES } from "../../lib/mission";
import { isTask, type TaskConversation } from "../../lib/tasks";
import { navigateToMission, useStore } from "../../store";
import { MissionRow } from "../mission/MissionRow";
import { useMissionOverview } from "../mission/useMissionOverview";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { LedgerPanel, LedgerSection } from "../ui/Ledger";
import { Skeleton } from "../ui/Skeleton";
import { ProjectSignals } from "./ProjectSignals";

/**
 * A project's board, compact (roadmap module 11, lane D): mission control (module 09) for one project in
 * one column, beside its Lead. Needs you, Working and Ready to land (in the order to land), then what
 * landed today, folded. Live like the board page: the rows read each task from the store. Below them, what
 * the Lead heard about on its own (module 12: ProjectSignals).
 */
export function ProjectBoard({ project }: { project: Project }) {
  const { state, reload } = useMissionOverview(project.id);
  const conversations = useStore((s) => s.conversations);
  const agents = useStore((s) => s.agents);
  const [showLanded, setShowLanded] = useState(false);
  const overview = state.status === "ready" ? state.overview : null;
  const tasks = useMemo(
    () => (overview?.tasks ?? []).map((t) => conversations.find((c) => c.id === t.conversation.id) ?? t.conversation).filter(isTask),
    [overview, conversations],
  );
  const overlaps = useMemo(() => new Map((overview?.tasks ?? []).map((t) => [t.conversation.id, t.overlaps])), [overview]);
  const sections = useMemo(() => boardSections(tasks, overview?.landOrder ?? []), [tasks, overview]);
  const now = useNow(sections.working.length > 0, 30_000);

  if (state.status === "loading") {
    return (
      <div aria-busy="true" aria-label="Loading tasks" className="space-y-1 rounded-2xl border border-hairline p-2">
        {[0, 1, 2].map((key) => (
          <Skeleton key={key} className="h-10 rounded-lg" />
        ))}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <Callout
        tone="danger"
        action={
          <button type="button" onClick={reload} className="link-muted">
            Try again
          </button>
        }
      >
        Couldn't load the board. {state.message}
      </Callout>
    );
  }

  const rows = (list: TaskConversation[]) =>
    list.map((task) => (
      <MissionRow key={task.id} compact task={task} agent={agents.find((a) => a.id === task.agentId)} overlaps={overlaps.get(task.id) ?? []} now={now} />
    ));

  return (
    <div className="space-y-4">
      <LedgerPanel aria-label="Board">
        {tasks.length === 0 ? (
          <EmptyState
            variant="quiet"
            icon={<SquareKanban />}
            title="Nothing on the board"
            description="Ask the Lead to plan the work. Tasks show here while they work, and until they land."
          />
        ) : (
          (["needs-you", "working", "ready"] as const).map(
            (key) =>
              sections[key].length > 0 && (
                <LedgerSection
                  key={key}
                  layout="stacked"
                  as="h3"
                  label={SECTION_TITLES[key]}
                  count={sections[key].length}
                  tone={key === "needs-you" ? "warning" : "neutral"}
                >
                  {rows(sections[key])}
                </LedgerSection>
              ),
          )
        )}
        {sections.landed.length > 0 && (
          <LedgerSection
            layout="stacked"
            as="h3"
            label={SECTION_TITLES.landed}
            count={sections.landed.length}
            collapsed={!showLanded}
            onToggle={() => setShowLanded((value) => !value)}
          >
            {rows(sections.landed)}
          </LedgerSection>
        )}
      </LedgerPanel>
      <ProjectSignals project={project} />
      <button type="button" onClick={() => navigateToMission(project.id)} className="link-muted px-2 text-xs">
        Open mission control
      </button>
    </div>
  );
}
