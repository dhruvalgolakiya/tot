import { useState } from "react";
import clsx from "clsx";
import { BookOpen, ChevronDown, LoaderCircle } from "lucide-react";
import { toolDisplayStatus, toolTitle, wikiPreviewOf, type ToolPart } from "../lib/tools";
import { navigateToWiki, selectActiveAgentId, useStore } from "../store";
import { cardClass } from "./ui/Card";

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
          "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-ui font-medium transition-colors disabled:cursor-default",
          status === "error"
            ? "border-danger-edge bg-danger-soft text-danger"
            : "border-accent-edge bg-accent-soft text-accent-text hover:bg-accent-soft-hover",
        )}
      >
        {status === "running" ? <LoaderCircle className="size-3.5 animate-spin" /> : <BookOpen className="size-3.5" />}
        {label}
        {preview && <ChevronDown className={clsx("size-3.5 opacity-70 transition-transform", open && "rotate-180")} />}
      </button>

      {open && preview && (
        <div className={clsx(cardClass({ padding: "none" }), "mt-2 max-w-xl px-3.5 py-2.5")}>
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-fg-muted [overflow-wrap:anywhere]">{preview}</p>
          {agentId && (
            <button type="button" onClick={() => navigateToWiki(agentId)} className="link-muted mt-2 inline-block text-xs">
              Open wiki →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
