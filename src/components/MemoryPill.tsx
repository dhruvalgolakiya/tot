import { useState } from "react";
import clsx from "clsx";
import { Brain, ChevronDown, LoaderCircle } from "lucide-react";
import { memoryTextOf, toolDisplayStatus, type ToolPart } from "../lib/tools";
import { goToSettings } from "../store";
import { cardClass } from "./ui/Card";

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
          "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-ui font-medium transition-colors disabled:cursor-default",
          status === "error"
            ? "border-danger-edge bg-danger-soft text-danger"
            : "border-accent-edge bg-accent-soft text-accent-text hover:bg-accent-soft-hover",
        )}
      >
        {status === "running" ? <LoaderCircle className="size-3.5 animate-spin" /> : <Brain className="size-3.5" />}
        {label}
        {text && <ChevronDown className={clsx("size-3.5 opacity-70 transition-transform", open && "rotate-180")} />}
      </button>

      {open && text && (
        <div className={clsx(cardClass({ padding: "none" }), "mt-2 max-w-xl px-3.5 py-2.5")}>
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-fg-muted">{text}</p>
          <button type="button" onClick={() => goToSettings("memory")} className="link-muted mt-2 inline-block text-xs">
            Manage memories →
          </button>
        </div>
      )}
    </div>
  );
}
