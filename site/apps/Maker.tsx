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
} from "../../src/components/mascot";

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

/** Build-a-mascot: shuffle one, read its name, try its moods. */
export function Maker() {
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
    <div className="flex min-h-full flex-col px-6 py-6">
      <p className="text-center text-sm text-fg-muted">
        Pick a shape, a color and a hat. Add a personality (“blunt, loves tables”) and a default model.
      </p>
      <div className="isolate grid h-56 place-items-center">
        <MascotStage key={arrival} spec={spec} state={mood.state} size={160} />
      </div>
      <div className="text-center" aria-live="polite">
        <p className="font-display text-3xl font-semibold tracking-tight text-fg-strong">{suggestName(spec)}</p>
        <p className="mt-1 text-sm text-fg-subtle">{mascotLabel(spec)}</p>
        <p className="mt-3 min-h-6 text-base text-fg">{mood.line}</p>
      </div>
      <div className="mx-auto mt-5 flex max-w-80 flex-wrap justify-center gap-1" role="group" aria-label="Mood">
        {MOODS.map((option) => (
          <button
            key={option.state}
            type="button"
            aria-pressed={option.state === mood.state}
            onClick={() => setMood(option)}
            className={clsx(
              "h-8 rounded-full px-3 text-ui font-medium transition-colors",
              option.state === mood.state ? "bg-selected text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="mt-5 flex justify-center">
        <button
          type="button"
          onClick={shuffle}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-fg px-5 text-sm font-medium text-canvas transition-colors hover:bg-fg/90"
        >
          <Dices className="size-4" /> Shuffle
        </button>
      </div>
      <p className="mt-auto pt-6 text-center text-xs text-fg-subtle">
        <span className="font-medium text-fg tabular-nums">{COMBOS.toLocaleString("en-US")}</span> possible coworkers. Every one of them
        blinks.
      </p>
    </div>
  );
}
