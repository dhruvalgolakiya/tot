import type { ReactNode } from "react";
import { MascotStage } from "../../src/components/mascot";
import { StatusDot } from "../../src/components/ui/StatusDot";
import { crew, type CrewMember } from "../crew";
import { ClaudeMark, OpenAIMark } from "../os/BrandMarks";
import { useTicker } from "./ticker";

/** The crew as characters: what each one is for, its own computer, the brains attached to it, and its model. */

type Member = {
  who: CrewMember;
  role: string;
  computer: { specs: string; cpu: number } | null;
  brains: string[];
  model: "auto" | "claude" | "chatgpt";
};

const MEMBERS: Member[] = [
  { who: "tot", role: "Your generalist. Plans the work, answers questions and keeps the routines running.", computer: { specs: "4 CPU · 8 GB", cpu: 18 }, brains: ["Notebook", "Research"], model: "auto" },
  { who: "bolt", role: "Ships code. Works on its own branch and opens a draft PR when it's done.", computer: { specs: "8 CPU · 16 GB", cpu: 64 }, brains: ["shop", "Acme"], model: "claude" },
  { who: "nimbus", role: "Digs into a question, benchmarks what it can and writes up what it finds.", computer: { specs: "4 CPU · 8 GB", cpu: 31 }, brains: ["Research"], model: "chatgpt" },
  { who: "mochi", role: "Design and copy. Always asks before anything goes out.", computer: null, brains: ["Brand", "shop"], model: "claude" },
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

export function Crew() {
  const seconds = useTicker();
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {MEMBERS.map((member, index) => (
        <li key={member.who}>
          <CrewCard member={member} seconds={seconds} phase={index * 3} />
        </li>
      ))}
    </ul>
  );
}

function CrewCard({ member, seconds, phase }: { member: Member; seconds: number; phase: number }) {
  const { name, spec } = crew[member.who];
  // A little drift, so the CPU meters look alive.
  const cpu = member.computer ? Math.min(96, Math.max(4, member.computer.cpu + Math.sin((seconds + phase) / 2) * 9)) : 0;
  return (
    <article className="flex h-full flex-col rounded-2xl border border-hairline bg-fill-subtle p-5">
      <MascotStage spec={spec} size={52} state={member.computer ? "working" : "sleeping"} title={name} className="self-start" />
      <h3 className="mt-4 text-heading text-fg-strong">{name}</h3>
      <p className="mt-1 text-sm leading-relaxed text-fg-muted">{member.role}</p>
      <dl className="mt-auto space-y-3 border-t border-hairline pt-4 text-xs [&_dt]:text-fg-subtle">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <dt>Computer</dt>
            <dd className="flex items-center gap-1.5 text-fg-muted tabular-nums">
              <StatusDot tone={member.computer ? "green" : "gray"} />
              {member.computer?.specs ?? "Asleep"}
            </dd>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-fill">
            <div className="h-full rounded-full bg-fg-subtle transition-[width] duration-700" style={{ width: `${cpu}%` }} />
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt>Brains</dt>
          <dd className="flex justify-end gap-1">
            {member.brains.map((brain) => (
              <span key={brain} className="rounded-full border border-edge px-2 py-0.5 text-2xs whitespace-nowrap text-fg-muted">
                {brain}
              </span>
            ))}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt>Model</dt>
          <dd className="flex items-center gap-1.5 text-fg-muted">{MODELS[member.model]}</dd>
        </div>
      </dl>
    </article>
  );
}
