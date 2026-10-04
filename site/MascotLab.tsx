import { useState } from "react";
import clsx from "clsx";
import { Dices } from "lucide-react";
import type { MascotSpec, MascotState } from "@shared/types";
import {
  MASCOT_ACCESSORIES,
  MASCOT_COLORS,
  MASCOT_EYES,
  MASCOT_SHAPES,
  MascotStage,
  mascotLabel,
  randomMascot,
  suggestName,
} from "../src/components/mascot";
import { Heading, Reveal, Section } from "./ui";

const MOODS: { state: MascotState; label: string; line: string }[] = [
  { state: "idle", label: "Idle", line: "Just vibing. Ready when you are." },
  { state: "thinking", label: "Thinking", line: "Thinking. Possibly about lunch." },
  { state: "working", label: "Working", line: "Running npm install. Again." },
  { state: "speaking", label: "Talking", line: "Explaining the diff, slowly and kindly." },
  { state: "happy", label: "Happy", line: "All 214 tests pass!" },
  { state: "sleeping", label: "Napping", line: "Napping until the next routine." },
  { state: "error", label: "Oops", line: "Something broke. It wasn't me. (It was me.)" },
];

const COMBOS = MASCOT_SHAPES.length * MASCOT_COLORS.length * MASCOT_ACCESSORIES.length * MASCOT_EYES.length;

export function MascotLab() {
  const [spec, setSpec] = useState<MascotSpec>({ shape: "cloud", color: "#facc15", accessory: "beret", eyes: "happy" });
  const [mood, setMood] = useState(MOODS[0]!);
  // Re-mounting the stage replays its bounce-in, so every shuffle "arrives".
  const [arrival, setArrival] = useState(0);

  function shuffle() {
    let next = randomMascot();
    while (next.shape === spec.shape && next.color === spec.color) next = randomMascot();
    setSpec(next);
    setArrival((count) => count + 1);
  }

  return (
    <Section id="make-one" className="border-y border-hairline bg-panel">
      <div className="grid items-center gap-12 lg:grid-cols-2">
        <div>
          <Heading
            eyebrow="Make one"
            title="A new coworker in four seconds."
            intro="Pick a shape, a color and a hat. Give it a personality (“blunt, loves tables”) and a default model. It gets its own computer the first time it needs one."
          />
          <Reveal>
            <p className="text-sm text-fg-subtle">
              <span className="font-medium text-fg tabular-nums">{COMBOS.toLocaleString("en-US")}</span> possible coworkers, and every
              one of them blinks.
            </p>
          </Reveal>
        </div>

        <Reveal delay={120}>
          <div className="surface-raised rounded-3xl border border-edge p-6 sm:p-8">
            <div className="isolate grid h-64 place-items-center">
              <MascotStage key={arrival} spec={spec} state={mood.state} size={176} />
            </div>
            <div className="mt-2 text-center" aria-live="polite">
              <p className="font-display text-3xl font-semibold tracking-tight text-fg-strong">{suggestName(spec)}</p>
              <p className="mt-1 text-sm text-fg-subtle">{mascotLabel(spec)}</p>
              <p className="mt-4 min-h-6 text-base text-fg">{mood.line}</p>
            </div>
            <div className="mx-auto mt-6 flex max-w-80 flex-wrap justify-center gap-1" role="group" aria-label="Mood">
              {MOODS.map((option) => (
                <button
                  key={option.state}
                  type="button"
                  aria-pressed={option.state === mood.state}
                  onClick={() => setMood(option)}
                  className={clsx(
                    "h-8 rounded-full px-3.5 text-ui font-medium transition-colors",
                    option.state === mood.state ? "bg-selected text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="mt-6 flex justify-center">
              <button
                type="button"
                onClick={shuffle}
                className="inline-flex h-10 items-center gap-2 rounded-full bg-fg px-5 text-sm font-medium text-canvas transition-colors hover:bg-fg/90"
              >
                <Dices className="size-4" /> Shuffle
              </button>
            </div>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
