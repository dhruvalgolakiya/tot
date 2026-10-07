import { useEffect, useState } from "react";
import { Activity, Brain, CircleCheck, Clock, FolderGit2, FolderKanban, GitBranch, Hand, LoaderCircle, Monitor, Repeat } from "lucide-react";
import { HomeCard, HomeCardGroup, HomeItem } from "../../src/components/home/HomeCard";
import { Mascot } from "../../src/components/mascot";
import { StatusDot } from "../../src/components/ui/StatusDot";
import { crew, type CrewMember } from "../crew";
import { useReducedMotion } from "../ui";

/**
 * Home's cards as the app shows them, filled in by the crew: what's working (it ticks), what's waiting on
 * you, their brains, their computers, routines and projects. Every card is a real one in TOT.
 */

/** Seconds since the page opened, for elapsed times and the progress lines that move on. */
function useTicker(): number {
  const reduced = useReducedMotion();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [reduced]);
  return seconds;
}

const elapsed = (seconds: number) => `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;

function Face({ who, working = false }: { who: CrewMember; working?: boolean }) {
  return <Mascot spec={crew[who].spec} size={18} state={working ? "working" : "idle"} title={crew[who].name} />;
}

const WORKING: { who: CrewMember; title: string; startedAt: number; steps: string[] }[] = [
  {
    who: "perry",
    title: "Tune the judge prompt",
    startedAt: 133,
    steps: ["pnpm test --filter judge", "reading evals/judge.md", "grading 40 answers again"],
  },
  {
    who: "bolt",
    title: "Add a CSV export for orders",
    startedAt: 421,
    steps: ["writing src/orders/export.ts", "npm test -- orders", "opening a draft PR"],
  },
  {
    who: "nimbus",
    title: "Compare open-source vector databases",
    startedAt: 58,
    steps: ["reading source 3 of 12", "benchmarking on the computer", "saving notes to the research brain"],
  },
];

function WorkingCard({ seconds }: { seconds: number }) {
  return (
    <HomeCard icon={Activity} title="Working now" count={WORKING.length}>
      {WORKING.map((task, index) => (
        <HomeItem
          key={task.title}
          leading={<LoaderCircle className="size-3.5 animate-spin text-accent" />}
          title={task.title}
          // Each task moves on to its next step every few seconds, out of step with the others.
          detail={task.steps[Math.floor((seconds + index * 2) / 5) % task.steps.length]}
          mono
          trailing={
            <>
              <Face who={task.who} working />
              {elapsed(task.startedAt + seconds)}
            </>
          }
        />
      ))}
    </HomeCard>
  );
}

function WaitingCard() {
  return (
    <HomeCard icon={Hand} title="Waiting on you" count={3}>
      <HomeCardGroup label="Needs you" count={1} tone="warning" />
      <HomeItem leading={<StatusDot tone="amber" />} title="Dark logo for transactional emails" detail="Use the new purple, or keep it black?" trailing={<Face who="mochi" />} />
      <HomeCardGroup label="Ready to land" count={2} />
      <HomeItem
        leading={<GitBranch className="size-3.5 text-fg-subtle" />}
        title="Retry checkout webhooks with backoff"
        detail="+84 −12 · 3 files"
        trailing={
          <>
            <CircleCheck aria-label="Checks passing" className="size-3.5 text-success" />
            <Face who="bolt" />
          </>
        }
      />
      <HomeItem
        leading={<GitBranch className="size-3.5 text-fg-subtle" />}
        title="Fix the flaky checkout e2e test"
        detail="+9 −31 · 2 files"
        trailing={
          <>
            <CircleCheck aria-label="Checks passing" className="size-3.5 text-success" />
            <Face who="perry" />
          </>
        }
      />
    </HomeCard>
  );
}

function BrainsCard() {
  return (
    <HomeCard icon={Brain} title="Brains" count={3}>
      <HomeItem leading={<FolderGit2 className="size-4 text-fg-muted" />} title="shop" detail="142 pages · learned from the repo" trailing="4m ago" />
      <HomeItem leading={<Brain className="size-4 text-fg-muted" />} title="Acme (client)" detail="38 pages · read-only for Bolt" trailing="1h ago" />
      <HomeItem leading={<Brain className="size-4 text-fg-muted" />} title="Research notes" detail="61 pages · shared with every agent" trailing="just now" />
    </HomeCard>
  );
}

/** A tiny labelled bar, like a system monitor's. */
function Meter({ label, value }: { label: string; value: number }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex justify-between text-2xs text-fg-subtle tabular-nums">
        {label}
        <span>{Math.round(value)}%</span>
      </span>
      <span className="h-1 overflow-hidden rounded-full bg-fill">
        <span className="block h-full rounded-full bg-fg-subtle transition-[width] duration-700" style={{ width: `${value}%` }} />
      </span>
    </span>
  );
}

const COMPUTERS: { who: CrewMember; specs: string; cpu: number; mem: number; disk: number }[] = [
  { who: "tot", specs: "4 CPU · 8 GB", cpu: 18, mem: 52, disk: 41 },
  { who: "bolt", specs: "8 CPU · 16 GB", cpu: 64, mem: 71, disk: 58 },
];

function ComputersCard({ seconds }: { seconds: number }) {
  // A little drift, so the meters look alive.
  const wobble = (base: number, phase: number) => Math.min(96, Math.max(4, base + Math.sin((seconds + phase) / 2) * 9));
  return (
    <HomeCard icon={Monitor} title="Computers" count={3}>
      {COMPUTERS.map((computer, index) => (
        <div key={computer.who} className="flex flex-col gap-2 rounded-lg px-2 py-2">
          <span className="flex items-center gap-2">
            <StatusDot tone="green" />
            <span className="text-ui text-fg">{crew[computer.who].name}'s computer</span>
            <span className="text-xs text-fg-subtle">{computer.specs}</span>
            <span className="ml-auto">
              <Face who={computer.who} working={index === 1} />
            </span>
          </span>
          <span className="flex gap-3 pl-4">
            <Meter label="CPU" value={wobble(computer.cpu, index * 3)} />
            <Meter label="Mem" value={wobble(computer.mem, index * 5 + 1) * 0.4 + computer.mem * 0.6} />
            <Meter label="Disk" value={computer.disk} />
          </span>
        </div>
      ))}
      <p className="px-2 pt-0.5 text-xs text-fg-subtle">
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone="gray" /> Perry's computer is asleep
        </span>
      </p>
    </HomeCard>
  );
}

function RoutinesCard() {
  return (
    <HomeCard icon={Repeat} title="Next routines" count={3}>
      <HomeItem leading={<Clock className="size-3.5 text-fg-subtle" />} title="Inbox triage" detail="Every 2 hours" trailing="in 41m" />
      <HomeItem leading={<Clock className="size-3.5 text-fg-subtle" />} title="Morning AI news" detail="Every weekday at 09:00" trailing="in 14h" />
      <HomeItem leading={<Clock className="size-3.5 text-fg-subtle" />} title="Weekly notes" detail="Every Fri at 17:00" trailing="in 3d" />
    </HomeCard>
  );
}

function ProjectsCard() {
  return (
    <HomeCard icon={FolderKanban} title="Projects" count={3}>
      <HomeItem
        leading={<FolderGit2 className="size-4 text-fg-muted" />}
        title="shop"
        detail="1 needs you · 2 working · 2 ready to land"
        trailing={
          <>
            <StatusDot tone="amber" />
            now
          </>
        }
      />
      <HomeItem
        leading={<FolderGit2 className="size-4 text-fg-muted" />}
        title="evals"
        detail="1 working"
        trailing={
          <>
            <StatusDot tone="green" pulse />
            2m
          </>
        }
      />
      <HomeItem leading={<FolderKanban className="size-4 text-fg-muted" />} title="Acme launch" detail="Nothing in flight" trailing="Tue" />
    </HomeCard>
  );
}

export function DemoGrid() {
  const seconds = useTicker();
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <WorkingCard seconds={seconds} />
      <WaitingCard />
      <ProjectsCard />
      <ComputersCard seconds={seconds} />
      <BrainsCard />
      <RoutinesCard />
    </div>
  );
}
