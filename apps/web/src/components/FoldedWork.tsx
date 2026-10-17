import { useState } from "react";
import clsx from "clsx";
import { ChevronRight, ListTree } from "lucide-react";
import type { MessagePart } from "@tot/shared/types";
import { formatDuration } from "../lib/format";
import { partRows, partSpacing, toolsSummary } from "../lib/toolGroups";
import { MessagePartView } from "./MessagePartView";
import { ToolGroup } from "./ToolGroup";

/** What a fold says: how long the turn worked (when it's the turn's only fold), or what it did. */
function label(parts: MessagePart[], durationMs: number | undefined): string {
  if (durationMs) return `Worked for ${formatDuration(durationMs)}`;
  const tools = toolsSummary(parts);
  if (tools) return tools;
  const thought = parts.reduce((sum, part) => sum + (part.type === "reasoning" ? (part.durationMs ?? 0) : 0), 0);
  return thought ? `Thought for ${formatDuration(thought)}` : "Thought";
}

/**
 * An older turn's work before its answer (thinking, tool calls, the text between them), folded into one line that
 * opens to it. Nothing inside renders until it's opened.
 */
export function FoldedWork({ parts, durationMs, conversationId }: { parts: MessagePart[]; durationMs?: number; conversationId: string }) {
  const [open, setOpen] = useState(false);
  let rows = open ? partRows(parts, { live: false, noteAfter: () => false }) : [];
  // Work that's one group of calls opens straight to the calls, not to a second line saying the same.
  if (rows.length === 1 && rows[0]!.kind === "tools") rows = rows[0]!.indexes.map((index) => ({ kind: "part" as const, index }));

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex h-7 w-full min-w-0 items-center gap-1.5 text-left text-sm text-fg-muted transition-colors hover:text-fg"
      >
        <ListTree className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{label(parts, durationMs)}</span>
        <ChevronRight className={clsx("size-3.5 shrink-0 text-fg-subtle transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="pb-1 pl-6">
          {rows.map((row) => {
            const first = row.kind === "part" ? row.index : row.indexes[0]!;
            const part = parts[first]!;
            return (
              <div key={part.id} className={partSpacing(parts[first - 1], part) ?? "mt-1.5"}>
                {row.kind === "part" ? (
                  <MessagePartView part={part} active={false} live={false} conversationId={conversationId} />
                ) : (
                  <ToolGroup parts={row.indexes.map((index) => parts[index]!)} live={false} conversationId={conversationId} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
