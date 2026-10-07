import type { ReactNode } from "react";
import { LoaderCircle, Lock } from "lucide-react";
import { Mascot } from "../../src/components/mascot";
import { StatusDot } from "../../src/components/ui/StatusDot";
import { crew, type CrewMember } from "../crew";
import { ClaudeMark, OpenAIMark } from "../os/BrandMarks";
import { WORKING } from "./DemoLedger";
import { useTicker } from "./ticker";

/**
 * The crew as a roster: each agent works from one of the islands in the scene (its computer), shown as a crop of
 * the painting with the agent's face on it, beside what it's doing right now, its CPU, its brains and its model.
 */

type Member = {
  who: CrewMember;
  island: { file: string; name: string };
  role: string;
  /** Null when its computer is asleep. */
  computer: { specs: string; cpu: number } | null;
  brains: { name: string; readOnly?: boolean }[];
  model: "auto" | "claude" | "chatgpt";
};

const MEMBERS: Member[] = [
  {
    who: "bolt",
    island: { file: "workshop", name: "the workshop" },
    role: "Ships code on its own branch, then opens a draft PR.",
    computer: { specs: "8 CPU · 16 GB", cpu: 64 },
    brains: [{ name: "shop" }, { name: "Acme", readOnly: true }],
    model: "claude",
  },
  {
    who: "nimbus",
    island: { file: "observatory", name: "the observatory" },
    role: "Digs into a question, benchmarks what it can and writes it up.",
    computer: { specs: "4 CPU · 8 GB", cpu: 38 },
    brains: [{ name: "Research" }],
    model: "chatgpt",
  },
  {
    who: "tot",
    island: { file: "tower", name: "the signal tower" },
    role: "Plans the work and keeps the routines running.",
    computer: { specs: "4 CPU · 8 GB", cpu: 22 },
    brains: [{ name: "Notebook" }, { name: "Research" }],
    model: "auto",
  },
  {
    who: "mochi",
    island: { file: "greenhouse", name: "the greenhouse" },
    role: "Design and copy. Always asks before anything goes out.",
    computer: null,
    brains: [{ name: "Brand" }, { name: "shop" }],
    model: "claude",
  },
];

const MODELS: Record<Member["model"], ReactNode> = {
  auto: "TOT Auto",
  claude: (
    <>
      <ClaudeMark className="size-3.5" /> Claude
    </>
  ),
  chatgpt: (
    <>
      <OpenAIMark className="size-3.5" /> ChatGPT
    </>
  ),
};

/** Agent, then computer, brains and model; on phones the last three wrap under the agent. */
const COLUMNS = "md:grid-cols-[minmax(0,1fr)_10.5rem_9rem_6.5rem]";

export function Crew() {
  const seconds = useTicker();
  return (
    <div className="overflow-hidden rounded-2xl border border-hairline bg-panel">
      <div className={`hidden h-9 items-center gap-x-6 border-b border-hairline px-4 text-2xs font-medium text-fg-subtle md:grid ${COLUMNS}`}>
        <span>Agent</span>
        <span>Computer</span>
        <span>Brains</span>
        <span>Model</span>
      </div>
      <ul>
        {MEMBERS.map((member) => (
          <li key={member.who} className="border-t border-hairline first:border-t-0">
            <Row member={member} seconds={seconds} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Row({ member, seconds }: { member: Member; seconds: number }) {
  const { name, spec } = crew[member.who];
  return (
    <div className={`flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3.5 md:grid ${COLUMNS}`}>
      <div className="flex w-full min-w-0 items-center gap-4 md:w-auto">
        <div className="relative shrink-0">
          <img
            src={`/hero/islands/${member.island.file}.webp`}
            alt={`${member.island.name} island`}
            width={84}
            height={56}
            loading="lazy"
            className="h-14 w-21 rounded-lg object-cover ring-1 ring-hairline"
          />
          <span className="absolute -right-2 -bottom-2 grid size-7 place-items-center rounded-full border border-hairline bg-panel">
            <Mascot spec={spec} size={20} title={name} />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">
            <span className="font-medium text-fg">{name}</span>
            <span className="text-fg-subtle"> · {member.island.name}</span>
          </p>
          <p className="truncate text-xs text-fg-muted">{member.role}</p>
          <Now member={member} seconds={seconds} />
        </div>
      </div>

      {/* Phones: under the agent, lined up with its text. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 max-md:pl-25 md:contents">
        <Computer member={member} seconds={seconds} />
        <div className="flex flex-wrap gap-1">
          {member.brains.map((brain) => (
            <span
              key={brain.name}
              title={brain.readOnly ? "Read-only for this agent" : undefined}
              className="inline-flex items-center gap-1 rounded-full border border-edge px-2 py-0.5 text-2xs whitespace-nowrap text-fg-muted"
            >
              {brain.readOnly && <Lock aria-label="read-only" className="size-2.5" />}
              {brain.name}
            </span>
          ))}
        </div>
        <span className="flex items-center gap-1.5 text-xs text-fg-muted">{MODELS[member.model]}</span>
      </div>
    </div>
  );
}

/** What the agent is doing this second: the same steps as Home's Working rows, or what it's waiting on. */
function Now({ member, seconds }: { member: Member; seconds: number }) {
  const index = WORKING.findIndex((task) => task.who === member.who);
  if (index < 0)
    return (
      <p className="mt-1 flex items-center gap-1.5 text-2xs text-warning">
        <StatusDot tone="amber" />
        <span className="truncate">Waiting on you: purple or black for the logo?</span>
      </p>
    );
  const { steps } = WORKING[index]!;
  return (
    <p className="mt-1 flex items-center gap-1.5 font-mono text-2xs text-fg-subtle">
      <LoaderCircle className="size-3 shrink-0 animate-spin text-accent" />
      <span className="truncate">{steps[Math.floor((seconds + index * 2) / 5) % steps.length]}</span>
    </p>
  );
}

const SPARK_POINTS = 24;
const SPARK_W = 80;
const SPARK_H = 18;
/** The sparkline spans the agent's usual load ± this much, so its swings are visible at this size. */
const SPARK_RANGE = 18;

/** CPU at a given second: a slow swell and a quicker flutter around the agent's usual load. */
const cpuAt = (base: number, t: number) => Math.min(96, Math.max(3, base + Math.sin(t / 2.3) * 10 + Math.sin(t * 1.7) * 4));

function Computer({ member, seconds }: { member: Member; seconds: number }) {
  if (!member.computer)
    return (
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 text-xs text-fg-muted">
          <StatusDot tone="gray" /> Asleep
        </span>
        <span className="text-2xs text-fg-subtle max-md:hidden">Wakes up for work</span>
      </div>
    );
  const { specs, cpu } = member.computer;
  // Offset each agent's curve so the sparklines don't move in step.
  const t0 = seconds + cpu;
  const values = Array.from({ length: SPARK_POINTS }, (_, i) => cpuAt(cpu, t0 - (SPARK_POINTS - 1 - i)));
  const low = cpu - SPARK_RANGE;
  const points = values.map((v, i) => [(i / (SPARK_POINTS - 1)) * SPARK_W, SPARK_H - ((v - low) / (SPARK_RANGE * 2)) * SPARK_H] as const);
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = points[points.length - 1]!;
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-xs text-fg-muted tabular-nums">
        <StatusDot tone="green" /> {specs}
      </span>
      <span className="flex items-center gap-2 text-2xs text-fg-subtle tabular-nums max-md:hidden">
        <svg aria-hidden="true" width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} className="overflow-visible text-fg-muted">
          <polygon points={`0,${SPARK_H} ${line} ${SPARK_W},${SPARK_H}`} fill="currentColor" opacity={0.08} />
          <polyline points={line} fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinejoin="round" />
          <circle cx={lastX} cy={lastY} r={1.75} className="fill-fg" />
        </svg>
        CPU {Math.round(values[values.length - 1]!)}%
      </span>
    </div>
  );
}
