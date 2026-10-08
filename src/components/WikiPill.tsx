import { useState } from "react";
import clsx from "clsx";
import { BookOpen, ChevronRight, LoaderCircle } from "lucide-react";
import { toolDisplayStatus, toolTitle, wikiPreviewOf, type ToolPart } from "../lib/tools";
import { navigateToWiki, selectActiveAgentId, useStore } from "../store";

/** `wiki_write` / `wiki_edit` render as a muted line, matching ToolPart; expanding shows what changed. */
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
          "flex h-7 items-center gap-1.5 text-sm transition-colors disabled:cursor-default",
          status === "error" ? "text-danger" : "text-fg-muted hover:text-fg",
        )}
      >
        {status === "running" ? <LoaderCircle className="size-4 animate-spin" /> : <BookOpen className="size-4" />}
        {label}
        {preview && <ChevronRight className={clsx("size-3.5 text-fg-subtle transition-transform", open && "rotate-90")} />}
      </button>

      {open && preview && (
        <div className="mt-1.5 max-w-xl rounded-xl bg-fill-subtle px-3.5 py-2.5">
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-fg-muted [overflow-wrap:anywhere]">{preview}</p>
          {agentId && (
            <button type="button" onClick={() => navigateToWiki(agentId)} className="link-muted mt-2 inline-block text-xs">
              Open knowledge →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
