import { useState } from "react";
import clsx from "clsx";
import { BookOpen, ChevronDown, LoaderCircle } from "lucide-react";
import { toolDisplayStatus, toolTitle, wikiPreviewOf, type ToolPart } from "../lib/tools";
import { navigateToWiki, selectActiveAgentId, useStore } from "../store";

/** `wiki_write` / `wiki_edit` render as a small pill; expanding shows what changed. */
export function WikiPill({ part, live }: { part: ToolPart; live: boolean }) {
  const [open, setOpen] = useState(false);
  const status = toolDisplayStatus(part, live);
  const preview = wikiPreviewOf(part);
  const agentId = useStore(selectActiveAgentId);
  const label = toolTitle(part);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={!preview}
        aria-expanded={preview ? open : undefined}
        className={clsx(
          "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors disabled:cursor-default",
          status === "error"
            ? "border-red-400/20 bg-red-400/[0.08] text-red-300"
            : "border-[var(--agent-accent-border)] bg-[var(--agent-accent-08)] text-[var(--agent-accent-text)] hover:bg-[var(--agent-accent-16)]",
        )}
      >
        {status === "running" ? <LoaderCircle className="size-3.5 animate-spin" /> : <BookOpen className="size-3.5" />}
        {label}
        {preview && <ChevronDown className={clsx("size-3.5 opacity-70 transition-transform", open && "rotate-180")} />}
      </button>

      {open && preview && (
        <div className="mt-2 max-w-xl rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5">
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-zinc-300 [overflow-wrap:anywhere]">{preview}</p>
          {agentId && (
            <button
              type="button"
              onClick={() => navigateToWiki(agentId)}
              className="mt-2 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
            >
              Open wiki →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
