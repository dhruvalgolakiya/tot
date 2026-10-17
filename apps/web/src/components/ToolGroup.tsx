import { memo, useState } from "react";
import clsx from "clsx";
import { ChevronRight, Layers } from "lucide-react";
import type { MessagePart } from "@tot/shared/types";
import { toolsSummary } from "../lib/toolGroups";
import { MessagePartView } from "./MessagePartView";
import { ToolStatusIcon } from "./ToolStatusIcon";

type ToolGroupProps = { parts: MessagePart[]; live: boolean; conversationId: string };

/** The same parts as before (a reply streaming on past a group hands it a new array of them). */
const sameGroup = (a: ToolGroupProps, b: ToolGroupProps) =>
  a.live === b.live && a.conversationId === b.conversationId && a.parts.length === b.parts.length && a.parts.every((part, i) => part === b.parts[i]);

/** Finished tool calls in a row, as one quiet line ("Read 4 files, ran 2 commands") that opens to each of them. */
export const ToolGroup = memo(function ToolGroup({ parts, live, conversationId }: ToolGroupProps) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex h-7 w-full min-w-0 items-center gap-1.5 text-left text-sm text-fg-muted transition-colors hover:text-fg"
      >
        <Layers className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{toolsSummary(parts)}</span>
        <ToolStatusIcon status="done" />
        <ChevronRight className={clsx("size-3.5 shrink-0 text-fg-subtle transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="pl-6">
          {parts.map((part, index) => (
            <div key={part.id} className={index > 0 ? (part.type === "tool" && parts[index - 1]!.type === "tool" ? "mt-1.5" : "mt-3") : "mt-1.5"}>
              <MessagePartView part={part} active={false} live={live} conversationId={conversationId} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}, sameGroup);
