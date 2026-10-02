import { useState } from "react";
import clsx from "clsx";
import { Brain, ChevronDown, LoaderCircle } from "lucide-react";
import { memoryTextOf, toolDisplayStatus, type ToolPart } from "../lib/tools";
import { goToSettings } from "../store";

/** `memory_save` renders as a small pill; expanding shows what was saved. */
export function MemoryPill({ part, live }: { part: ToolPart; live: boolean }) {
  const [open, setOpen] = useState(false);
  const status = toolDisplayStatus(part, live);
  const text = memoryTextOf(part);
  const label =
    status === "running" ? "Updating memory…" : status === "error" ? "Couldn't update memory" : "Memory updated";

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={!text}
        aria-expanded={text ? open : undefined}
        className={clsx(
          "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors disabled:cursor-default",
          status === "error"
            ? "border-red-400/20 bg-red-400/[0.08] text-red-300"
            : "border-[var(--agent-accent-border)] bg-[var(--agent-accent-08)] text-[var(--agent-accent-text)] hover:bg-[var(--agent-accent-16)]",
        )}
      >
        {status === "running" ? <LoaderCircle className="size-3.5 animate-spin" /> : <Brain className="size-3.5" />}
        {label}
        {text && <ChevronDown className={clsx("size-3.5 opacity-70 transition-transform", open && "rotate-180")} />}
      </button>

      {open && text && (
        <div className="mt-2 max-w-xl rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5">
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-zinc-300">{text}</p>
          <button
            type="button"
            onClick={() => goToSettings("memory")}
            className="mt-2 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            Manage memories →
          </button>
        </div>
      )}
    </div>
  );
}
