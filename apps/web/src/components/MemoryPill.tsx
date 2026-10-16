import { useState } from "react";
import clsx from "clsx";
import { Brain, ChevronRight, LoaderCircle } from "lucide-react";
import { memoryTextOf, toolDisplayStatus, type ToolPart } from "../lib/tools";
import { goToSettings } from "../store";

/** `memory_save` renders as a muted line, matching ToolPart; expanding shows what was saved. */
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
          "flex h-7 items-center gap-1.5 text-sm transition-colors disabled:cursor-default",
          status === "error" ? "text-danger" : "text-fg-muted hover:text-fg",
        )}
      >
        {status === "running" ? <LoaderCircle className="size-4 animate-spin" /> : <Brain className="size-4" />}
        {label}
        {text && <ChevronRight className={clsx("size-3.5 text-fg-subtle transition-transform", open && "rotate-90")} />}
      </button>

      {open && text && (
        <div className="mt-1.5 max-w-xl rounded-xl bg-fill-subtle px-3.5 py-2.5">
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-fg-muted">{text}</p>
          <button type="button" onClick={() => goToSettings("memory")} className="link-muted mt-2 inline-block text-xs">
            Manage memories →
          </button>
        </div>
      )}
    </div>
  );
}
