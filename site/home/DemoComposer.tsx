import { useEffect, useState } from "react";
import clsx from "clsx";
import { ArrowUp, Folder, Plus } from "lucide-react";
import { ClaudeMark } from "../os/BrandMarks";
import { useReducedMotion } from "../ui";

/** What the composer types, one after another: the kinds of things people hand their agents. */
const PROMPTS = [
  "Fix the flaky checkout test and open a draft PR",
  "Read our Slack this morning and tell me what needs me",
  "Research the best open-source vector databases",
  "Add a CSV export for orders",
  "Every weekday at 9, send me the AI news that matters",
];

const TYPE_MS = 38;
const ERASE_MS = 14;
const HOLD_MS = 1900;

/** The prompt being typed, and how much of it shows. Reduced motion holds the first one. */
function useTyping(): string {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [length, setLength] = useState(0);
  const [erasing, setErasing] = useState(false);
  const prompt = PROMPTS[index]!;

  useEffect(() => {
    if (reduced) return;
    if (!erasing && length < prompt.length) {
      const timer = setTimeout(() => setLength(length + 1), TYPE_MS);
      return () => clearTimeout(timer);
    }
    if (!erasing) {
      const timer = setTimeout(() => setErasing(true), HOLD_MS);
      return () => clearTimeout(timer);
    }
    if (length > 0) {
      const timer = setTimeout(() => setLength(length - 1), ERASE_MS);
      return () => clearTimeout(timer);
    }
    setErasing(false);
    setIndex((index + 1) % PROMPTS.length);
  }, [reduced, erasing, length, prompt, index]);

  return reduced ? prompt : prompt.slice(0, length);
}

/** The app's composer, typing a few example tasks by itself. Decorative: the page says the same in words. */
export function DemoComposer({ className }: { className?: string }) {
  const text = useTyping();
  const chip = "inline-flex h-7 items-center gap-1.5 rounded-full border border-edge px-2.5 text-xs text-fg-muted";

  return (
    <div aria-hidden="true" className={clsx("surface-raised rounded-3xl text-left", className)}>
      <p className="min-h-15 px-4 pt-4 pb-1 text-chat text-fg">
        {text}
        <span className="caret" />
      </p>
      <div className="flex items-center gap-1.5 px-3 pt-1 pb-3">
        <span className="grid size-9 place-items-center rounded-full text-fg-muted">
          <Plus className="size-4" />
        </span>
        <span className={chip}>
          <Folder className="size-3.5" />
          shop
        </span>
        <span className={clsx(chip, "max-sm:hidden")}>
          <span className="size-1.5 rounded-full bg-emerald-400" />
          Tot's computer
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-fg-muted">
          <ClaudeMark className="size-3.5" />
          Claude
        </span>
        <span
          className={clsx(
            "ml-1 grid size-9 place-items-center rounded-full transition-colors",
            text ? "bg-fg text-canvas" : "bg-fill-strong text-fg-faint",
          )}
        >
          <ArrowUp className="size-4.5" strokeWidth={2.25} />
        </span>
      </div>
    </div>
  );
}
