import { useState } from "react";
import clsx from "clsx";
import { ChevronRight, ExternalLink } from "lucide-react";
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

/** Muted, expandable line for one tool call — ChatGPT style, not a boxed card. */
export function ToolPart({ part, live }: ToolPartProps) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(part.name);
  const status = toolDisplayStatus(part, live);
  const input = toolInputText(part);
  const hasDetails = Boolean(input || part.output);
  const exposedUrl = part.name === "computer_expose_port" ? firstUrl(part.output) : null;
  const screenshotUrl = part.name === "computer_screenshot" ? firstUrl(part.output) : null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={!hasDetails}
        aria-expanded={hasDetails ? open : undefined}
        className="flex h-7 w-full min-w-0 items-center gap-1.5 text-left text-sm text-fg-muted transition-colors hover:text-fg disabled:cursor-default disabled:hover:text-fg-muted"
      >
        <Icon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          <TickText text={toolTitle(part)} />
        </span>
        <ToolStatusIcon status={status} />
        {hasDetails && (
          <ChevronRight className={clsx("size-3.5 shrink-0 text-fg-subtle transition-transform", open && "rotate-90")} />
        )}
      </button>

      {screenshotUrl && (
        <div className="mt-1.5 rounded-xl bg-fill-subtle p-2">
          <img
            src={screenshotUrl}
            alt="Screenshot of the computer's screen"
            className="max-h-72 w-full rounded-lg object-contain"
          />
        </div>
      )}

      {exposedUrl && (
        <a
          href={exposedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 flex items-center gap-2 text-sm text-accent-text transition-colors hover:text-accent"
        >
          <ExternalLink className="size-3.5 shrink-0" />
          <span className="truncate">{exposedUrl}</span>
        </a>
      )}

      {open && hasDetails && (
        <div className="mt-1.5 space-y-3 rounded-xl bg-fill-subtle px-3 py-3">
          {input && <ToolOutput label={part.name === "computer_exec" ? "Command" : "Input"} text={clipOutput(input)} />}
          {part.output && (
            <ToolOutput label={part.isError ? "Error" : "Output"} text={clipOutput(part.output)} error={part.isError} />
          )}
        </div>
      )}
    </div>
  );
}
