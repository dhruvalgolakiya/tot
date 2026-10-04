import { useEffect, useState, type CSSProperties } from "react";
import type { MascotState } from "@shared/types";
import { Mascot } from "../../src/components/mascot";
import { crew, type CrewMember } from "../crew";

const PETS: { who: CrewMember; state: MascotState; seconds: number; delay: number }[] = [
  { who: "ribbit", state: "idle", seconds: 46, delay: 0 },
  { who: "nova", state: "working", seconds: 34, delay: -12 },
  { who: "splash", state: "speaking", seconds: 58, delay: -30 },
];

const LINES = [
  "I'm on break. Routines start at 9.",
  "Have you tried turning the agent off and on again?",
  "I reviewed your diff. It's… brave.",
  "No, I won't merge it. Nice try.",
  "My computer, my rules.",
  "I've been told I'm “a lot of hat”.",
  "Shh. Ribbit's thinking. Or asleep. Hard to tell.",
];

/** Mascots wandering along the bottom of the desktop. Click one and it says something. */
export function Pets() {
  const [talking, setTalking] = useState<{ who: CrewMember; line: string } | null>(null);
  useEffect(() => {
    if (!talking) return;
    const timer = setTimeout(() => setTalking(null), 3200);
    return () => clearTimeout(timer);
  }, [talking]);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-24 z-[5] h-20">
      {PETS.map((pet) => (
        <div
          key={pet.who}
          className="pet pointer-events-auto absolute bottom-0"
          style={{ "--pet-seconds": `${pet.seconds}s`, "--pet-delay": `${pet.delay}s` } as CSSProperties}
        >
          {talking?.who === pet.who && (
            <p className="animate-pop-in absolute bottom-full left-1/2 mb-1 w-max max-w-56 -translate-x-1/2 rounded-2xl border border-edge bg-elevated px-3 py-1.5 text-center text-ui text-fg shadow-popover">
              {talking.line}
            </p>
          )}
          <button
            type="button"
            aria-label={`Poke ${crew[pet.who].name}`}
            onClick={() => setTalking({ who: pet.who, line: LINES[Math.floor(Math.random() * LINES.length)]! })}
            className="block rounded-full"
          >
            <Mascot spec={crew[pet.who].spec} state={talking?.who === pet.who ? "happy" : pet.state} size={56} />
          </button>
        </div>
      ))}
    </div>
  );
}
