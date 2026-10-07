import { useMemo, useState } from "react";
import clsx from "clsx";
import { ChevronRight, SquareKanban } from "lucide-react";
import type { Project } from "@shared/types";
import { useNow } from "../../hooks/useNow";
import { boardSections, SECTION_TITLES } from "../../lib/mission";
import { isTask, type TaskConversation } from "../../lib/tasks";
import { navigateToMission, useStore } from "../../store";
import { MissionCard } from "../mission/MissionCard";
import { useMissionOverview } from "../mission/useMissionOverview";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { Skeleton } from "../ui/Skeleton";

/**
 * A project's board, compact (roadmap module 11, lane D): mission control (module 09) for one project in
 * one column, beside its Lead. Needs you, Working and Ready to land (in the order to land), then what
 * landed today, folded. Live like the board page: the cards read each task from the store.
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
      <div aria-busy="true" aria-label="Loading tasks" className="space-y-2">
        {[0, 1, 2].map((key) => (
          <Skeleton key={key} className="h-24 rounded-xl" />
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

  const cards = (list: TaskConversation[]) => (
    <ul className="mt-2 space-y-2">
      {list.map((task) => (
        <li key={task.id} className="min-w-0">
          <MissionCard task={task} agent={agents.find((a) => a.id === task.agentId)} overlaps={overlaps.get(task.id) ?? []} now={now} />
        </li>
      ))}
    </ul>
  );

  return (
    <div className="space-y-6">
      {tasks.length === 0 ? (
        <EmptyState
          size="sm"
          variant="dashed"
          icon={<SquareKanban />}
          title="Nothing on the board"
          description="Ask the Lead to plan the work. Tasks show here while they work, and until they land."
        />
      ) : (
        (["needs-you", "working", "ready"] as const).map(
          (key) =>
            sections[key].length > 0 && (
              <section key={key} aria-labelledby={`board-${key}`}>
                <h3 id={`board-${key}`} className="flex items-baseline gap-2 text-ui font-semibold text-fg">
                  {SECTION_TITLES[key]}
                  <span className="text-xs font-normal text-fg-subtle tabular-nums">{sections[key].length}</span>
                </h3>
                {cards(sections[key])}
              </section>
            ),
        )
      )}
      {sections.landed.length > 0 && (
        <section aria-labelledby="board-landed">
          <button
            id="board-landed"
            type="button"
            aria-expanded={showLanded}
            onClick={() => setShowLanded((value) => !value)}
            className="-ml-2 flex h-8 items-center gap-1.5 rounded-lg px-2 text-ui font-semibold text-fg transition-colors hover:bg-hover"
          >
            <ChevronRight className={clsx("size-3.5 text-fg-subtle transition-transform", showLanded && "rotate-90")} />
            {SECTION_TITLES.landed}
            <span className="text-xs font-normal text-fg-subtle tabular-nums">{sections.landed.length}</span>
          </button>
          {showLanded && cards(sections.landed)}
        </section>
      )}
      <button type="button" onClick={() => navigateToMission(project.id)} className="link-muted text-xs">
        Open mission control
      </button>
    </div>
  );
}
