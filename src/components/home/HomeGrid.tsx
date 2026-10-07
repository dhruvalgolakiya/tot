import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { Activity, CheckCheck, CircleCheck, CircleX, Clock, GitBranch, GitMerge, GitPullRequest, Hand, LoaderCircle, Pause, Repeat, X } from "lucide-react";
import type { Agent, Routine } from "@shared/types";
import { useNow } from "../../hooks/useNow";
import { boardSections, statsLine, taskStatusLine } from "../../lib/mission";
import { selectDevice, useDevices } from "../../lib/remote";
import { conversationPath, missionPath } from "../../lib/router";
import { isTask, taskElapsed, type TaskConversation } from "../../lib/tasks";
import { navigateToConversation, navigateToMission, openAgentSettings, selectActiveAgent, useStore } from "../../store";
import { Mascot } from "../mascot";
import { useMissionOverview } from "../mission/useMissionOverview";
import { ProjectsCard, useHomeProjects } from "../projects/HomeProjects";
import { formatRelative, formatSchedule } from "../routines/format";
import { routinesApi } from "../routines/routinesApi";
import { Suggestions } from "../Suggestions";
import { StatusDot } from "../ui/StatusDot";
import { HomeCard, HomeCardGroup, HomeItem, HomeMore } from "./HomeCard";

/**
 * Under the composer on an agent's home: what's working now, what's waiting on you, every project, this
 * agent's next routines and what finished today, as a grid of cards. Every task is listed whichever agent runs
 * it (like mission control). With nothing to show yet, the starter prompts instead.
 */

const SHOWN = 4;

/** Plain clicks route in-app; modified ones (new tab, and so on) follow the link. */
const routeTo = (go: () => void) => (event: MouseEvent<HTMLElement>) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  go();
};

export function HomeGrid() {
  const agent = useStore(selectActiveAgent);
  const agents = useStore((s) => s.agents);
  const conversations = useStore((s) => s.conversations);
  const projects = useHomeProjects();
  const { state } = useMissionOverview(null);
  const routines = useNextRoutines(agent);

  // The store's copy of each task is the live one; the overview's is a fallback until it arrives.
  const sections = useMemo(() => {
    if (state.status !== "ready") return null;
    const tasks = state.overview.tasks.map((t) => conversations.find((c) => c.id === t.conversation.id) ?? t.conversation).filter(isTask);
    return boardSections(tasks, state.overview.landOrder);
  }, [state, conversations]);
  const now = useNow(true, sections?.working.length ? 30_000 : 60_000);

  if (projects === null || state.status === "loading" || routines === null) return <div aria-busy="true" aria-label="Loading Home" />;

  const agentOf = (task: TaskConversation) => agents.find((a) => a.id === task.agentId);
  const cards: ReactNode[] = [];
  if (sections?.working.length) cards.push(<WorkingCard key="working" tasks={sections.working} agentOf={agentOf} now={now} />);
  if (sections && (sections["needs-you"].length || sections.ready.length))
    cards.push(<WaitingCard key="waiting" needsYou={sections["needs-you"]} ready={sections.ready} agentOf={agentOf} />);
  if (projects.length) cards.push(<ProjectsCard key="projects" rows={projects} now={now} />);
  if (agent && routines.length) cards.push(<RoutinesCard key="routines" agent={agent} routines={routines} now={now} />);
  if (sections?.landed.length) cards.push(<LandedCard key="landed" tasks={sections.landed} agentOf={agentOf} />);

  if (!cards.length) return <Suggestions />;
  return (
    // One card spans the width; from two on, two columns (one on phones).
    <div className="mx-auto grid w-full max-w-4xl grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-3 px-3 sm:px-4">{cards}</div>
  );
}

/** This agent's enabled routines that have a next run, soonest first; null while loading. */
function useNextRoutines(agent: Agent | undefined): Routine[] | null {
  const device = useDevices(selectDevice(agent?.deviceId));
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const offline = !!device && !device.online;

  useEffect(() => {
    if (!agent || offline) {
      setRoutines([]);
      return;
    }
    let cancelled = false;
    routinesApi.list(agent.id).then(
      (list) => {
        if (cancelled) return;
        setRoutines(list.filter((r) => r.enabled && r.nextRunAt !== null).sort((a, b) => a.nextRunAt! - b.nextRunAt!));
      },
      () => {
        // Quiet: Home just has no routines card. The routines panel reports errors itself.
        if (!cancelled) setRoutines([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agent?.id, offline]);

  return routines;
}

function Avatar({ agent, working = false }: { agent: Agent | undefined; working?: boolean }) {
  return agent ? <Mascot spec={agent.mascot} size={18} state={working ? "working" : "idle"} title={agent.name} /> : null;
}

function TaskItem({ task, leading, detail, mono, trailing }: { task: TaskConversation; leading: ReactNode; detail: string; mono?: boolean; trailing: ReactNode }) {
  return (
    <HomeItem
      href={conversationPath(task.id)}
      onClick={routeTo(() => navigateToConversation(task.id))}
      leading={leading}
      title={task.title}
      detail={detail}
      mono={mono}
      trailing={trailing}
    />
  );
}

function MoreTasks({ count }: { count: number }) {
  if (count <= 0) return null;
  return <HomeMore label={`+${count} more`} href={missionPath()} onClick={routeTo(() => navigateToMission(null))} />;
}

const WORKING_ICONS = { running: LoaderCircle, queued: Clock, paused: Pause } as const;

function WorkingCard({ tasks, agentOf, now }: { tasks: TaskConversation[]; agentOf: (task: TaskConversation) => Agent | undefined; now: number }) {
  return (
    <HomeCard icon={Activity} title="Working now" count={tasks.length}>
      {tasks.slice(0, SHOWN).map((task) => {
        const { status } = task.task;
        const Icon = WORKING_ICONS[status as keyof typeof WORKING_ICONS] ?? LoaderCircle;
        const running = status === "running";
        return (
          <TaskItem
            key={task.id}
            task={task}
            leading={<Icon className={running ? "size-3.5 animate-spin text-accent" : "size-3.5 text-fg-subtle"} />}
            detail={taskStatusLine(task)}
            mono={running && !!task.task.progress}
            trailing={
              <>
                <Avatar agent={agentOf(task)} working={running} />
                {taskElapsed(task.task, now)}
              </>
            }
          />
        );
      })}
      <MoreTasks count={tasks.length - SHOWN} />
    </HomeCard>
  );
}

const CHECK_ICONS = {
  passing: <CircleCheck aria-label="Checks passing" className="size-3.5 text-success" />,
  failing: <CircleX aria-label="Checks failing" className="size-3.5 text-danger" />,
  running: <LoaderCircle aria-label="Checks running" className="size-3.5 animate-spin" />,
  none: null,
};

/** Tasks waiting on the user: a question or an OK first, then finished work to land (in the order to land it). */
function WaitingCard({
  needsYou,
  ready,
  agentOf,
}: {
  needsYou: TaskConversation[];
  ready: TaskConversation[];
  agentOf: (task: TaskConversation) => Agent | undefined;
}) {
  const shownNeeds = needsYou.slice(0, SHOWN);
  const shownReady = ready.slice(0, Math.max(0, SHOWN - shownNeeds.length));
  return (
    <HomeCard icon={Hand} title="Waiting on you" count={needsYou.length + ready.length}>
      {shownNeeds.length > 0 && <HomeCardGroup label="Needs you" count={needsYou.length} tone="warning" />}
      {shownNeeds.map((task) => (
        <TaskItem key={task.id} task={task} leading={<StatusDot tone="amber" />} detail={taskStatusLine(task)} trailing={<Avatar agent={agentOf(task)} />} />
      ))}
      {shownReady.length > 0 && <HomeCardGroup label="Ready to land" count={ready.length} />}
      {shownReady.map((task) => (
        <TaskItem
          key={task.id}
          task={task}
          leading={<GitBranch className="size-3.5 text-fg-subtle" />}
          detail={task.task.stats ? statsLine(task.task.stats) : taskStatusLine(task)}
          trailing={
            <>
              {task.task.checks && CHECK_ICONS[task.task.checks.state]}
              <Avatar agent={agentOf(task)} />
            </>
          }
        />
      ))}
      <MoreTasks count={needsYou.length + ready.length - shownNeeds.length - shownReady.length} />
    </HomeCard>
  );
}

function RoutinesCard({ agent, routines, now }: { agent: Agent; routines: Routine[]; now: number }) {
  const open = () => openAgentSettings(agent.id, "routines");
  return (
    <HomeCard icon={Repeat} title="Next routines" count={routines.length}>
      {routines.slice(0, SHOWN).map((routine) => (
        <HomeItem
          key={routine.id}
          onClick={open}
          leading={<Clock className="size-3.5 text-fg-subtle" />}
          title={routine.name}
          detail={formatSchedule(routine.schedule)}
          trailing={formatRelative(routine.nextRunAt!, now)}
        />
      ))}
      {routines.length > SHOWN && <HomeMore label={`+${routines.length - SHOWN} more`} onClick={open} />}
    </HomeCard>
  );
}

const LANDED_ICONS = { merged: GitMerge, pr: GitPullRequest, discarded: X } as const;

function LandedCard({ tasks, agentOf }: { tasks: TaskConversation[]; agentOf: (task: TaskConversation) => Agent | undefined }) {
  return (
    <HomeCard icon={CheckCheck} title="Done today" count={tasks.length}>
      {tasks.slice(0, SHOWN).map((task) => {
        const Icon = task.task.landing ? LANDED_ICONS[task.task.landing.kind] : CheckCheck;
        return (
          <TaskItem
            key={task.id}
            task={task}
            leading={<Icon className="size-3.5 text-fg-subtle" />}
            detail={taskStatusLine(task)}
            trailing={<Avatar agent={agentOf(task)} />}
          />
        );
      })}
      <MoreTasks count={tasks.length - SHOWN} />
    </HomeCard>
  );
}
