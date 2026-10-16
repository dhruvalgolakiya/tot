import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { CheckCheck, CircleCheck, CircleX, Clock, GitBranch, GitMerge, GitPullRequest, LoaderCircle, Pause, X } from "lucide-react";
import type { Agent, Routine } from "@tot/shared/types";
import { useNow } from "../../hooks/useNow";
import { boardSections, statsLine, taskStatusLine } from "../../lib/mission";
import { selectDevice, useDevices } from "../../lib/remote";
import { conversationPath, missionPath } from "../../lib/router";
import { isTask, taskElapsed, type TaskConversation } from "../../lib/tasks";
import { navigateToConversation, navigateToMission, openAgentSettings, selectActiveAgent, useStore } from "../../store";
import { Mascot } from "../mascot";
import { useMissionOverview } from "../mission/useMissionOverview";
import { ProjectsSection, useHomeProjects } from "../projects/HomeProjects";
import { formatRelative, formatSchedule } from "../routines/format";
import { routinesApi } from "../routines/routinesApi";
import { Suggestions } from "../Suggestions";
import { NeedsYou as NeedsYouIcon } from "../ui/Working";
import { Ledger, LedgerMore, LedgerRow, LedgerSection } from "./Ledger";

/**
 * Under the composer on an agent's home, one ledger: what needs you, what's working, what's ready to land,
 * this agent's next routines, every project and what finished today. Every task is listed whichever agent runs
 * it (like mission control). With nothing to show yet, the starter prompts instead.
 */

const SHOWN = 4;

/** Plain clicks route in-app; modified ones (new tab, and so on) follow the link. */
const routeTo = (go: () => void) => (event: MouseEvent<HTMLElement>) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  go();
};

export function HomeLedger() {
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
  const parts: ReactNode[] = [];
  if (sections?.["needs-you"].length) parts.push(<NeedsYou key="needs-you" tasks={sections["needs-you"]} agentOf={agentOf} />);
  if (sections?.working.length) parts.push(<Working key="working" tasks={sections.working} agentOf={agentOf} now={now} />);
  if (sections?.ready.length) parts.push(<ReadyToLand key="ready" tasks={sections.ready} agentOf={agentOf} />);
  if (agent && routines.length) parts.push(<ComingUp key="routines" agent={agent} routines={routines} now={now} />);
  if (projects.length) parts.push(<ProjectsSection key="projects" rows={projects} now={now} />);
  if (sections?.landed.length) parts.push(<DoneToday key="done" tasks={sections.landed} agentOf={agentOf} />);

  if (!parts.length) return <Suggestions />;
  return <Ledger className="mx-auto w-full max-w-3xl px-3 sm:px-4">{parts}</Ledger>;
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
        // Quiet: Home just has no routines section. The routines panel reports errors itself.
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

function TaskRow({ task, leading, detail, mono, trailing }: { task: TaskConversation; leading: ReactNode; detail: string; mono?: boolean; trailing: ReactNode }) {
  return (
    <LedgerRow
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

/** The first few tasks, then "+N more", which opens mission control. */
function TaskList({ tasks, render }: { tasks: TaskConversation[]; render: (task: TaskConversation) => ReactNode }) {
  return (
    <>
      {tasks.slice(0, SHOWN).map(render)}
      {tasks.length > SHOWN && <LedgerMore label={`+${tasks.length - SHOWN} more`} href={missionPath()} onClick={routeTo(() => navigateToMission(null))} />}
    </>
  );
}

type AgentOf = (task: TaskConversation) => Agent | undefined;

/** A question or an OK the task is waiting on. */
function NeedsYou({ tasks, agentOf }: { tasks: TaskConversation[]; agentOf: AgentOf }) {
  return (
    <LedgerSection label="Needs you" count={tasks.length} tone="warning">
      <TaskList
        tasks={tasks}
        render={(task) => <TaskRow key={task.id} task={task} leading={<NeedsYouIcon label="Needs you" />} detail={taskStatusLine(task)} trailing={<Avatar agent={agentOf(task)} />} />}
      />
    </LedgerSection>
  );
}

const WORKING_ICONS = { running: LoaderCircle, queued: Clock, paused: Pause } as const;

function Working({ tasks, agentOf, now }: { tasks: TaskConversation[]; agentOf: AgentOf; now: number }) {
  return (
    <LedgerSection label="Working" count={tasks.length}>
      <TaskList
        tasks={tasks}
        render={(task) => {
          const { status } = task.task;
          const Icon = WORKING_ICONS[status as keyof typeof WORKING_ICONS] ?? LoaderCircle;
          const running = status === "running";
          return (
            <TaskRow
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
        }}
      />
    </LedgerSection>
  );
}

const CHECK_ICONS = {
  passing: <CircleCheck aria-label="Checks passing" className="size-3.5 text-success" />,
  failing: <CircleX aria-label="Checks failing" className="size-3.5 text-danger" />,
  running: <LoaderCircle aria-label="Checks running" className="size-3.5 animate-spin" />,
  none: null,
};

/** Finished work with code to land, in the order to land it. */
function ReadyToLand({ tasks, agentOf }: { tasks: TaskConversation[]; agentOf: AgentOf }) {
  return (
    <LedgerSection label="Ready to land" count={tasks.length}>
      <TaskList
        tasks={tasks}
        render={(task) => (
          <TaskRow
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
        )}
      />
    </LedgerSection>
  );
}

/** This agent's next routines; a row opens its routines settings. */
function ComingUp({ agent, routines, now }: { agent: Agent; routines: Routine[]; now: number }) {
  const open = () => openAgentSettings(agent.id, "routines");
  return (
    <LedgerSection label="Coming up" count={routines.length}>
      {routines.slice(0, SHOWN).map((routine) => (
        <LedgerRow
          key={routine.id}
          onClick={open}
          leading={<Clock className="size-3.5 text-fg-subtle" />}
          title={routine.name}
          detail={formatSchedule(routine.schedule)}
          trailing={formatRelative(routine.nextRunAt!, now)}
        />
      ))}
      {routines.length > SHOWN && <LedgerMore label={`+${routines.length - SHOWN} more`} onClick={open} />}
    </LedgerSection>
  );
}

const DONE_ICONS = { merged: GitMerge, pr: GitPullRequest, discarded: X } as const;

/** Landed today, and finished today without code. */
function DoneToday({ tasks, agentOf }: { tasks: TaskConversation[]; agentOf: AgentOf }) {
  return (
    <LedgerSection label="Done today" count={tasks.length}>
      <TaskList
        tasks={tasks}
        render={(task) => {
          const Icon = task.task.landing ? DONE_ICONS[task.task.landing.kind] : CheckCheck;
          return (
            <TaskRow
              key={task.id}
              task={task}
              leading={<Icon className="size-3.5 text-fg-subtle" />}
              detail={taskStatusLine(task)}
              trailing={<Avatar agent={agentOf(task)} />}
            />
          );
        }}
      />
    </LedgerSection>
  );
}
