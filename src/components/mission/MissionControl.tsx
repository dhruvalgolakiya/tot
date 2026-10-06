import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ChevronRight, SquareKanban } from "lucide-react";
import type { MissionOverview } from "@shared/types";
import { useAppEvents } from "../../hooks/useAppEvents";
import { useNow } from "../../hooks/useNow";
import { api, errorMessage } from "../../lib/api";
import { boardSections, SECTION_TITLES, type MissionSection } from "../../lib/mission";
import { useProjects } from "../../lib/projects";
import { isTask, type TaskConversation } from "../../lib/tasks";
import { navigateToMission, useStore } from "../../store";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { Kbd } from "../ui/Kbd";
import { Select } from "../ui/Select";
import { Skeleton } from "../ui/Skeleton";
import { MissionCard } from "./MissionCard";

/**
 * Mission control (roadmap module 09): every task on one board, or one project's (`/mission?project=`).
 * Needs you first, then what's working, what's ready to land (in the order to land it) and, folded, what
 * landed today. The overview (overlaps, land order) is refetched shortly after any task changes; the
 * cards themselves read each task from the store, so their status and progress are live.
 */

const REFETCH_MS = 600;

const DESCRIPTIONS: Partial<Record<MissionSection, string>> = {
  ready: "In the order to land them: fewest overlaps with other tasks first, then the smallest.",
};

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; overview: MissionOverview };

export function MissionControl() {
  const projectId = useStore((s) => s.missionProjectId);
  const [state, setState] = useState<State>({ status: "loading" });
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    try {
      const overview = await api.getMission({ projectId });
      if (id === request.current) setState({ status: "ready", overview });
    } catch (error) {
      if (id === request.current) setState((current) => (current.status === "ready" ? current : { status: "error", message: errorMessage(error) }));
    }
  }, [projectId]);

  useEffect(() => {
    setState({ status: "loading" });
    void load();
  }, [load]);

  // Live: any task changing (or going away) refetches the overview, a moment later so a burst gives one fetch.
  const timer = useRef<number | undefined>(undefined);
  const schedule = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void load(), REFETCH_MS);
  }, [load]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useAppEvents(
    (event) => {
      if (event.type === "task" || event.type === "conversation-deleted") schedule();
    },
    () => void load(),
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 pt-20 pb-12 sm:px-6 md:pt-24">
        <BoardHeader projectId={projectId} overview={state.status === "ready" ? state.overview : null} />
        {state.status === "loading" ? (
          <div aria-busy="true" aria-label="Loading tasks" className="mt-8 grid gap-2 sm:grid-cols-2">
            {[0, 1, 2, 3].map((key) => (
              <Skeleton key={key} className="h-28 rounded-xl" />
            ))}
          </div>
        ) : state.status === "error" ? (
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
          <Board overview={state.overview} />
        )}
      </div>
    </div>
  );
}

/** Title, one line of counts, and the project filter. */
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
    <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-title text-fg-strong">Mission control</h1>
        <p className="mt-1 flex items-center gap-2 text-sm text-fg-muted">
          {counts === null ? <span>Every task, and where it stands</span> : counts.length ? counts.join(" · ") : "Nothing in flight"}
          <span className="hidden md:inline-flex">
            <Kbd keys={["mod", "shift", "M"]} />
          </span>
        </p>
      </div>
      <Select
        size="sm"
        aria-label="Project"
        value={projectId ?? ""}
        onValueChange={(value) => navigateToMission(value || null)}
        options={options}
        className="w-48 max-sm:w-full"
      />
    </header>
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
        variant="dashed"
        className="mt-8"
        icon={<SquareKanban />}
        title="No tasks here yet"
        description="Start one from the composer: turn on Task (⌘↩), or type /task, /parallel or /best-of. They show up here while they work, and until you land them."
      />
    );
  }

  const grid = (list: TaskConversation[]) => (
    <ul className="mt-3 grid gap-2 sm:grid-cols-2">
      {list.map((task) => (
        <li key={task.id} className="min-w-0">
          <MissionCard task={task} agent={agents.find((a) => a.id === task.agentId)} overlaps={overlaps.get(task.id) ?? []} now={now} />
        </li>
      ))}
    </ul>
  );

  return (
    <div className="mt-8 space-y-8">
      {(["needs-you", "working", "ready"] as const).map(
        (key) =>
          sections[key].length > 0 && (
            <section key={key} aria-labelledby={`mission-${key}`}>
              <h2 id={`mission-${key}`} className="flex items-baseline gap-2 text-sm font-semibold text-fg">
                {SECTION_TITLES[key]}
                <span className="text-xs font-normal text-fg-subtle tabular-nums">{sections[key].length}</span>
              </h2>
              {DESCRIPTIONS[key] && <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">{DESCRIPTIONS[key]}</p>}
              {grid(sections[key])}
            </section>
          ),
      )}
      {sections.landed.length > 0 && (
        <section aria-labelledby="mission-landed">
          <button
            id="mission-landed"
            type="button"
            aria-expanded={showLanded}
            onClick={() => setShowLanded((value) => !value)}
            className="-ml-2 flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-fg transition-colors hover:bg-hover"
          >
            <ChevronRight className={clsx("size-3.5 text-fg-subtle transition-transform", showLanded && "rotate-90")} />
            {SECTION_TITLES.landed}
            <span className="text-xs font-normal text-fg-subtle tabular-nums">{sections.landed.length}</span>
          </button>
          {showLanded && grid(sections.landed)}
        </section>
      )}
    </div>
  );
}
