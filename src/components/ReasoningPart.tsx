import { useState } from "react";
import clsx from "clsx";
import { ChevronRight, Lightbulb } from "lucide-react";
import type { MessagePart } from "@shared/types";
import { formatDuration } from "../lib/format";
import { LazyMarkdown } from "./LazyMarkdown";

type ReasoningPartProps = {
  part: Extract<MessagePart, { type: "reasoning" }>;
  /** Still thinking (the newest part of a streaming message). */
  active: boolean;
};

export function ReasoningPart({ part, active }: ReasoningPartProps) {
  const [open, setOpen] = useState(false);
  const hasText = part.text.trim().length > 0;
  const label = active
    ? "Thinking…"
    : part.durationMs
      ? `Thought for ${formatDuration(part.durationMs)}`
      : "Thought";

  const row = (
    <>
      <Lightbulb className="size-4 shrink-0" />
      <span className={clsx(active && "shimmer-text")}>{label}</span>
      {hasText && <ChevronRight className={clsx("size-3.5 transition-transform", open && "rotate-90")} />}
    </>
  );

  return (
    <div>
      {hasText ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex h-7 items-center gap-1.5 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
        >
          {row}
        </button>
      ) : (
        <div className="flex h-7 items-center gap-1.5 text-sm text-zinc-400">{row}</div>
      )}
      {open && hasText && (
        <div className="mt-1.5 mb-1 border-l-2 border-white/10 pl-4">
          <LazyMarkdown text={part.text} muted />
        </div>
      )}
    </div>
  );
}
