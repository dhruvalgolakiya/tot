import { useEffect, useState } from "react";
import clsx from "clsx";
import { ArrowRight, ArrowUp, CalendarClock, ChevronDown, GitBranch, Lightbulb, Monitor, Plus, Search, SquarePen } from "lucide-react";
import type { MascotState } from "@shared/types";
import { Mascot } from "../src/components/mascot";
import { Badge } from "../src/components/ui/Badge";
import { StatusDot } from "../src/components/ui/StatusDot";
import { crew, type CrewMember } from "./crew";
import { ctaClass, Reveal, useReducedMotion } from "./ui";

export function Hero() {
  return (
    <header className="relative isolate overflow-hidden px-4 pt-32 pb-16 sm:px-6 sm:pt-40 sm:pb-24">
      <div aria-hidden="true" className="dot-grid absolute inset-0 -z-10" />
      <div aria-hidden="true" className="hero-glow absolute inset-x-0 top-0 -z-10 h-160" />
      <div className="mx-auto max-w-6xl text-center">
        <Reveal>
          <a
            href="#features"
            className="inline-flex items-center gap-2 rounded-full border border-edge bg-fill-subtle py-1 pr-3 pl-1 text-ui text-fg-muted transition-colors hover:border-edge-strong hover:text-fg"
          >
            <Badge tone="success">New</Badge>
            Chats now hear back when their tasks finish
            <ArrowRight className="size-3.5" />
          </a>
          <h1 className="mt-7 font-display text-5xl font-semibold tracking-tight text-balance text-fg-strong sm:text-7xl">
            Meet your tiny AI team.
            <span className="block text-fg-subtle">They have computers. And hats.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-pretty text-fg-muted sm:text-xl">
            Agents with their own computers, memories that stick, and faces you'll get weirdly attached to. They run on the Claude and
            ChatGPT plans you already pay for.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a href="#start" className={ctaClass("primary")}>
              Run it on your Mac
            </a>
            <a href="#roadmap" className={ctaClass("secondary")}>
              See what's coming
            </a>
          </div>
          <p className="mt-5 text-ui text-fg-subtle">Works with Claude Pro or Max and ChatGPT Plus or Pro. No API keys.</p>
        </Reveal>

        <Reveal delay={150} className="relative mx-auto mt-28 max-w-5xl">
          <PeekingCrew />
          <AppMock />
        </Reveal>
      </div>
    </header>
  );
}

/** Mascots peeking over the top edge of the app window, like neighbours over a fence. */
function PeekingCrew() {
  // Each sits low enough that the window hides its bottom half; taller shapes sit higher.
  const peekers: { who: CrewMember; state: MascotState; className: string }[] = [
    { who: "perry", state: "idle", className: "-top-16 left-[6%]" },
    { who: "mochi", state: "thinking", className: "-top-13 left-[22%] hidden sm:block" },
    { who: "bolt", state: "speaking", className: "-top-13 right-[24%] hidden sm:block" },
    { who: "nova", state: "idle", className: "-top-14 right-[8%]" },
  ];
  return (
    <div aria-hidden="true">
      {peekers.map(({ who, state, className }) => (
        <div key={who} className={clsx("absolute z-0", className)}>
          <Mascot spec={crew[who].spec} state={state} size={76} />
        </div>
      ))}
      <div className="absolute -top-22 left-[calc(22%+68px)] z-0 hidden rounded-2xl rounded-bl-sm border border-edge bg-elevated px-3 py-1.5 text-ui text-fg shadow-popover sm:block">
        psst… it's actually working
      </div>
      <div className="absolute -top-11 right-[1%] z-20 hidden rotate-12 md:block">
        <Mascot spec={crew.ribbit.spec} state="sleeping" size={56} />
      </div>
    </div>
  );
}

type Status = "queued" | "running" | "done";

const TASKS = [
  {
    title: "Reproduce the flaky checkout test",
    doing: "Running cart.spec.ts 20 times in a row…",
    role: "Tester · fast",
    took: "48s",
    result: "Fails 1 run in 6: the total is read before the coupon loads.",
  },
  {
    title: "Fix the race in cart.ts",
    doing: "Waiting for the coupon before adding up the total…",
    role: "Implementer · deep",
    branch: "tot/fix-checkout-flake",
    took: "3m 12s",
    result: "Awaits the coupon and adds a regression test. 214 tests pass.",
  },
  {
    title: "Review the fix",
    doing: "Reading the diff with fresh eyes…",
    role: "Reviewer · on ChatGPT",
    took: "36s",
    result: "Approved, with one nit: rename t to total.",
  },
] as const;

/** Each step of the loop: the three tasks' states, and how long the step stays on screen. */
const STEPS: { states: [Status, Status, Status]; ms: number }[] = [
  { states: ["running", "queued", "queued"], ms: 2600 },
  { states: ["done", "running", "queued"], ms: 2800 },
  { states: ["done", "done", "running"], ms: 2600 },
  { states: ["done", "done", "done"], ms: 6500 },
];

const LABELS: Record<Status, string> = { queued: "Queued", running: "Running", done: "Done" };

/** A small, static copy of TOT's chat screen, where a bug fix plays out as three tasks on a loop. */
function AppMock() {
  const reduced = useReducedMotion();
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const timer = setTimeout(() => setStep((current) => (current + 1) % STEPS.length), STEPS[step]!.ms);
    return () => clearTimeout(timer);
  }, [step, reduced]);
  const { states } = STEPS[reduced ? STEPS.length - 1 : step]!;
  const finished = states.every((state) => state === "done");
  const totState: MascotState = finished ? "happy" : "working";

  return (
    <div className="relative z-10 overflow-hidden rounded-2xl border border-edge bg-canvas text-left shadow-dialog">
      <div className="flex h-9 items-center gap-1.5 border-b border-hairline bg-panel px-3.5">
        <span className="size-2.5 rounded-full bg-fill-strong" />
        <span className="size-2.5 rounded-full bg-fill-strong" />
        <span className="size-2.5 rounded-full bg-fill-strong" />
        <span className="flex-1 pr-10 text-center text-xs text-fg-subtle">TOT</span>
      </div>
      <div className="flex h-155">
        <MockRail totState={totState} />
        <MockSidebar running={!finished} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline px-4">
            <p className="min-w-0 flex-1 truncate text-sm font-medium text-fg">Flaky checkout test</p>
            <span className="flex h-7 items-center gap-1 rounded-full px-2.5 text-ui text-fg-muted">
              Auto <ChevronDown className="size-3.5" />
            </span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden px-4 sm:px-8">
            <div className="mx-auto w-full max-w-2xl space-y-5 pb-4">
              <div className="flex justify-end">
                <p className="max-w-[85%] rounded-3xl bg-bubble px-4 py-2.5 text-[15px] leading-relaxed text-fg">
                  The checkout test is flaky again. Can you fix it?
                </p>
              </div>
              <div className="space-y-3">
                <p className="text-[15px] leading-relaxed text-fg">
                  On it. I'll reproduce it first, fix it on its own branch, then have the other model review the fix.
                </p>
                {TASKS.map((task, index) => (
                  <MockTaskCard key={task.title} task={task} status={states[index]!} />
                ))}
              </div>
              <p
                className={clsx(
                  "text-[15px] leading-relaxed text-fg transition-opacity duration-500",
                  finished ? "opacity-100" : "opacity-0",
                )}
              >
                All green. The coupon race is fixed on <code className="rounded-md bg-fill px-1.5 py-0.5 font-mono text-ui">tot/fix-checkout-flake</code>
                , 214 tests pass, and ChatGPT approved it with one nit. Want a draft PR?
              </p>
            </div>
          </div>
          <MockComposer />
        </div>
      </div>
    </div>
  );
}

function MockTaskCard({ task, status }: { task: (typeof TASKS)[number]; status: Status }) {
  const done = status === "done";
  return (
    <div className="space-y-2 rounded-xl border border-hairline p-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5 inline-flex">
          <StatusDot tone={status === "running" ? "green" : "gray"} pulse={status === "running"} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{task.title}</p>
          <p className="truncate text-xs text-fg-subtle">{done ? task.result : status === "running" ? task.doing : "Waiting in line · next up"}</p>
        </div>
        <Badge tone={done ? "success" : "neutral"}>{LABELS[status]}</Badge>
      </div>
      <p className="flex min-w-0 items-center gap-1.5 text-xs text-fg-subtle">
        {"branch" in task && (
          <>
            <GitBranch className="size-3.5 shrink-0" />
            <span className="truncate font-mono">shop · {task.branch}</span>
            <span aria-hidden="true">·</span>
          </>
        )}
        <span className="shrink-0">{task.role}</span>
        {done && <span className="shrink-0 tabular-nums before:mr-1.5 before:content-['·']">{task.took}</span>}
      </p>
    </div>
  );
}

function MockRail({ totState }: { totState: MascotState }) {
  const others: CrewMember[] = ["perry", "mochi", "bolt"];
  return (
    <div className="hidden w-16 shrink-0 flex-col items-center gap-2 border-r border-hairline bg-rail py-3 md:flex">
      <div className="relative grid size-11 place-items-center rounded-xl bg-selected">
        <span className="absolute top-2.5 -left-2.5 h-6 w-1 rounded-r-full bg-accent" />
        <Mascot spec={crew.tot.spec} state={totState} size={34} />
      </div>
      {others.map((who) => (
        <div key={who} className="grid size-11 place-items-center rounded-xl">
          <Mascot spec={crew[who].spec} state={who === "perry" ? "sleeping" : "idle"} size={34} />
        </div>
      ))}
      <div className="grid size-11 place-items-center rounded-xl text-fg-subtle">
        <Plus className="size-4.5" />
      </div>
    </div>
  );
}

function MockSidebar({ running }: { running: boolean }) {
  const row = "flex h-8 items-center gap-2 rounded-lg px-2.5 text-ui";
  return (
    <div className="hidden w-60 shrink-0 flex-col border-r border-hairline bg-panel p-2 lg:flex">
      <div className="flex h-10 items-center gap-2 px-2">
        <Mascot spec={crew.tot.spec} state="idle" size={24} />
        <span className="text-heading text-fg-strong">Tot</span>
        <ChevronDown className="size-3.5 text-fg-subtle" />
      </div>
      <p className={clsx(row, "text-fg-muted")}>
        <SquarePen className="size-4" /> New chat
      </p>
      <p className={clsx(row, "text-fg-muted")}>
        <Search className="size-4" /> Search chats
      </p>
      <p className="group-label mt-4 mb-1 px-2.5">Today</p>
      <p className={clsx(row, "bg-selected text-fg")}>
        <span className="min-w-0 flex-1 truncate">Flaky checkout test</span>
        {running && <StatusDot tone="green" pulse />}
      </p>
      <p className={clsx(row, "text-fg-muted")}>
        <CalendarClock className="size-3.5 shrink-0 text-fg-subtle" />
        <span className="truncate">Morning AI brief</span>
      </p>
      <p className={clsx(row, "text-fg-muted")}>Q4 launch blog draft</p>
      <p className={clsx(row, "text-fg-muted")}>Why is staging slow?</p>
      <p className="group-label mt-4 mb-1 px-2.5">Yesterday</p>
      <p className={clsx(row, "text-fg-muted")}>Plan the team offsite</p>
      <p className={clsx(row, "text-fg-muted")}>Learn the shop repo</p>
      <p className={clsx(row, "text-fg-muted")}>Compare three CRMs</p>
      <div className="mt-auto flex h-10 items-center gap-2 rounded-lg border border-hairline px-2.5 text-ui text-fg-muted">
        <Monitor className="size-4 text-fg-subtle" />
        <span className="flex-1">Tot's computer</span>
        <StatusDot tone={running ? "green" : "gray"} />
      </div>
    </div>
  );
}

function MockComposer() {
  return (
    <div className="px-4 pb-4 sm:px-8">
      <div className="surface-raised mx-auto max-w-2xl rounded-3xl border border-edge">
        <p className="px-4 pt-3.5 pb-1 text-[15px] text-fg-subtle">Ask Tot anything</p>
        <div className="flex items-center gap-1.5 px-3 pt-1 pb-2.5">
          <span className="grid size-8 place-items-center rounded-full text-fg-muted">
            <Plus className="size-4" />
          </span>
          <span className="flex h-8 items-center gap-1.5 rounded-full px-3 text-ui font-medium text-fg-muted">
            <Lightbulb className="size-3.5" /> Think harder
          </span>
          <span className="ml-auto grid size-8 place-items-center rounded-full bg-fill-strong text-fg-faint">
            <ArrowUp className="size-4" strokeWidth={2.25} />
          </span>
        </div>
      </div>
    </div>
  );
}
