import { useEffect, useState } from "react";
import clsx from "clsx";
import { ArrowUp, LoaderCircle, Repeat } from "lucide-react";
import { Mascot } from "../../src/components/mascot";
import { crew, type CrewMember } from "../crew";
import { useReducedMotion } from "../ui";

/** Handing things off, one exchange after another: you ask, an agent answers and starts the work. */
const EXCHANGES: { who: CrewMember; ask: string; reply: string; started: { kind: "task" | "routine"; label: string } }[] = [
  {
    who: "bolt",
    ask: "Fix the flaky checkout test and open a draft PR",
    reply: "On it. I'll reproduce it first, then fix it on its own branch.",
    started: { kind: "task", label: "Fix the flaky checkout test" },
  },
  {
    who: "nimbus",
    ask: "Compare the best open-source vector databases",
    reply: "I'll benchmark the top four on my computer and save the notes to the research brain.",
    started: { kind: "task", label: "Compare vector databases" },
  },
  {
    who: "tot",
    ask: "Every weekday at 9, send me the AI news that matters",
    reply: "Done. First one's tomorrow morning, short and skimmable.",
    started: { kind: "routine", label: "Morning AI news · weekdays at 09:00" },
  },
  {
    who: "mochi",
    ask: "Draft three subject lines for the launch email",
    reply: "Here they come. I'll match the tone of last month's launch.",
    started: { kind: "task", label: "Launch email subject lines" },
  },
];

const TYPE_MS = 32;
const SEND_MS = 450;
const THINK_MS = 1300;
const HOLD_MS = 4200;

type Phase = "typing" | "sent" | "replied";

/** Earlier exchanges kept above the current one; the chat opens with them already there. */
const HISTORY = 3;

/** Which round we're on (it keeps counting, for keys), how much of its ask is typed, and how far it has got. */
function useRounds(): { round: number; typed: number; phase: Phase } {
  const reduced = useReducedMotion();
  const [round, setRound] = useState(HISTORY);
  const [typed, setTyped] = useState(0);
  const [phase, setPhase] = useState<Phase>("typing");
  const ask = EXCHANGES[round % EXCHANGES.length]!.ask;

  useEffect(() => {
    if (reduced) return;
    let timer: ReturnType<typeof setTimeout>;
    if (phase === "typing") timer = typed < ask.length ? setTimeout(() => setTyped(typed + 1), TYPE_MS) : setTimeout(() => setPhase("sent"), SEND_MS);
    else if (phase === "sent") timer = setTimeout(() => setPhase("replied"), THINK_MS);
    else
      timer = setTimeout(() => {
        setRound(round + 1);
        setTyped(0);
        setPhase("typing");
      }, HOLD_MS);
    return () => clearTimeout(timer);
  }, [reduced, phase, typed, ask, round]);

  return reduced ? { round: HISTORY, typed: 0, phase: "replied" } : { round, typed, phase };
}

/** A small chat where you hand work to the crew; earlier exchanges scroll up and fade. Decorative: the page says it in words. */
export function DemoChat() {
  const { round, typed, phase } = useRounds();
  const current = EXCHANGES[round % EXCHANGES.length]!;
  const shown = Array.from({ length: HISTORY + 1 }, (_, i) => round - HISTORY + i);

  return (
    <div aria-hidden="true" className="flex h-full min-h-96 flex-col p-4">
      <div className="relative flex min-h-0 flex-1 flex-col justify-end gap-5 overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,#000_30%)]">
        {shown.map((r) => (
          <Exchange key={r} exchange={EXCHANGES[r % EXCHANGES.length]!} phase={r === round ? phase : "replied"} />
        ))}
      </div>
      <div className="surface-raised mt-4 flex h-11 shrink-0 items-center gap-2 rounded-full pr-1.5 pl-4 text-sm">
        <span className={clsx("min-w-0 flex-1 truncate", phase === "typing" && typed ? "text-fg" : "text-fg-subtle")}>
          {phase === "typing" && typed ? current.ask.slice(0, typed) : `Ask ${crew[current.who].name} anything`}
          {phase === "typing" && typed > 0 && <span className="caret" />}
        </span>
        <span
          className={clsx(
            "grid size-8 shrink-0 place-items-center rounded-full transition-colors",
            phase === "typing" && typed ? "bg-fg text-canvas" : "bg-fill-strong text-fg-faint",
          )}
        >
          <ArrowUp className="size-4" strokeWidth={2.25} />
        </span>
      </div>
    </div>
  );
}

function Exchange({ exchange, phase }: { exchange: (typeof EXCHANGES)[number]; phase: Phase }) {
  if (phase === "typing") return null;
  const agent = crew[exchange.who];
  const StartedIcon = exchange.started.kind === "task" ? LoaderCircle : Repeat;
  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-[85%] animate-fade-in self-end rounded-3xl bg-bubble px-4 py-2 text-sm text-fg">{exchange.ask}</p>
      <div className="flex animate-fade-in gap-2.5">
        <Mascot spec={agent.spec} size={26} state={phase === "sent" ? "thinking" : "idle"} title={agent.name} />
        <div className="flex min-w-0 flex-col items-start gap-2 pt-0.5">
          {phase === "sent" ? (
            <span className="shimmer-text text-sm">{agent.name} is thinking…</span>
          ) : (
            <>
              <p className="animate-fade-in text-sm text-fg">{exchange.reply}</p>
              <span className="inline-flex h-7 max-w-full animate-fade-in items-center gap-1.5 rounded-full border border-edge px-2.5 text-xs text-fg-muted">
                <StartedIcon className={clsx("size-3.5 shrink-0", exchange.started.kind === "task" && "animate-spin text-accent")} />
                <span className="truncate">
                  {exchange.started.kind === "task" ? "Task started" : "Routine set"} · {exchange.started.label}
                </span>
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
