import { useState } from "react";
import clsx from "clsx";
import { ChevronDown, ExternalLink } from "lucide-react";
import {
  clipOutput,
  firstUrl,
  toolDisplayStatus,
  toolIcon,
  toolInputText,
  toolTitle,
  type ToolPart as ToolPartType,
} from "../lib/tools";
import { TickText } from "./ui/TickText";
import { ToolOutput } from "./ToolOutput";
import { ToolStatusIcon } from "./ToolStatusIcon";

type ToolPartProps = {
  part: ToolPartType;
  /** The message is still streaming (running tools show a spinner). */
  live: boolean;
};

/** Compact, expandable card for one tool call. */
export function ToolPart({ part, live }: ToolPartProps) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(part.name);
  const status = toolDisplayStatus(part, live);
  const input = toolInputText(part);
  const hasDetails = Boolean(input || part.output);
  const exposedUrl = part.name === "computer_expose_port" ? firstUrl(part.output) : null;
  const screenshotUrl = part.name === "computer_screenshot" ? firstUrl(part.output) : null;

  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={!hasDetails}
        aria-expanded={hasDetails ? open : undefined}
        className="flex min-h-9 w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-zinc-300 transition-colors hover:bg-white/[0.03] disabled:cursor-default disabled:hover:bg-transparent"
      >
        <Icon className="size-4 shrink-0 text-zinc-500" />
        <span className="min-w-0 flex-1 truncate">
          <TickText text={toolTitle(part)} />
        </span>
        <ToolStatusIcon status={status} />
        {hasDetails && (
          <ChevronDown className={clsx("size-4 shrink-0 text-zinc-600 transition-transform", open && "rotate-180")} />
        )}
      </button>

      {screenshotUrl && (
        <div className="border-t border-white/[0.05] p-2">
          <img
            src={screenshotUrl}
            alt="Screenshot of the computer's screen"
            className="max-h-72 w-full rounded-lg border border-white/[0.06] object-contain"
          />
        </div>
      )}

      {exposedUrl && (
        <a
          href={exposedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 border-t border-white/[0.05] px-3 py-2 text-[13px] text-[var(--agent-accent-text)] transition-colors hover:bg-white/[0.03] hover:text-[var(--agent-accent)]"
        >
          <ExternalLink className="size-3.5 shrink-0" />
          <span className="truncate">{exposedUrl}</span>
        </a>
      )}

      {open && hasDetails && (
        <div className="space-y-3 border-t border-white/[0.05] px-3 py-3">
          {input && <ToolOutput label={part.name === "computer_exec" ? "Command" : "Input"} text={clipOutput(input)} />}
          {part.output && (
            <ToolOutput label={part.isError ? "Error" : "Output"} text={clipOutput(part.output)} error={part.isError} />
          )}
        </div>
      )}
    </div>
  );
}
