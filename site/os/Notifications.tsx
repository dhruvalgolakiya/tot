import { useEffect, useState } from "react";
import clsx from "clsx";
import { X } from "lucide-react";
import { Mascot } from "../../src/components/mascot";
import { crew, type CrewMember } from "../crew";
import { useOs } from "./context";
import type { AppId } from "./ids";

const NOTES: { who: CrewMember; title: string; text: string; app: AppId }[] = [
  { who: "tot", title: "Task done", text: "Fix the race in cart.ts. 214 tests pass.", app: "tot" },
  { who: "nova", title: "Your 9:00 brief is ready", text: "Three bullets. One of them actually matters.", app: "calendar" },
  { who: "bolt", title: "Claude hit its limit", text: "ChatGPT is taking the next shift. Nobody panic.", app: "brains" },
  { who: "perry", title: "Review: approved", text: "One nit: rename t to total. I'm not sorry.", app: "tot" },
  { who: "mochi", title: "Forked the launch plan", text: "Tried a wilder idea. Bringing the good bits back.", app: "calendar" },
  { who: "ribbit", title: "Ribbit is napping", text: "Back at the next routine. Do not disturb.", app: "maker" },
];

const SHOW_MS = 6500;
const GAP_MS = 5000;

/** A notification every few seconds, like the team is busy (because it is). */
export function Notifications({ className }: { className?: string }) {
  const { open } = useOs();
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(false);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    if (muted) return;
    const timer = setTimeout(
      () => {
        if (visible) {
          setVisible(false);
          setIndex((current) => (current + 1) % NOTES.length);
        } else {
          setVisible(true);
        }
      },
      visible ? SHOW_MS : index === 0 ? 2500 : GAP_MS,
    );
    return () => clearTimeout(timer);
  }, [visible, index, muted]);

  if (!visible || muted) return null;
  const note = NOTES[index]!;
  return (
    <div
      role="status"
      className={clsx("toast-in glass flex w-80 items-start gap-3 rounded-2xl border border-edge p-3 shadow-popover", className)}
    >
      <button type="button" onClick={() => open(note.app)} className="flex min-w-0 flex-1 items-start gap-3 text-left">
        <span className="shrink-0">
          <Mascot spec={crew[note.who].spec} state="speaking" size={36} />
        </span>
        <span className="min-w-0">
          <span className="block text-xs text-fg-subtle">{crew[note.who].name} · now</span>
          <span className="block text-sm font-medium text-fg">{note.title}</span>
          <span className="block text-ui text-fg-muted">{note.text}</span>
        </span>
      </button>
      <button
        type="button"
        aria-label="Turn off notifications"
        onClick={() => setMuted(true)}
        className="grid size-6 shrink-0 place-items-center rounded-full text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
