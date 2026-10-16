import clsx from "clsx";
import type { DotTone } from "../../lib/computer";

const TONES: Record<DotTone, string> = {
  green: "bg-emerald-400",
  gray: "bg-zinc-600",
  amber: "bg-amber-400",
  red: "bg-red-400",
};

export function StatusDot({ tone, pulse = false }: { tone: DotTone; pulse?: boolean }) {
  return (
    <span className="relative inline-flex size-2 shrink-0">
      {pulse && <span className={clsx("absolute inset-0 animate-ping rounded-full opacity-60", TONES[tone])} />}
      <span className={clsx("relative inline-flex size-2 rounded-full", TONES[tone])} />
    </span>
  );
}
