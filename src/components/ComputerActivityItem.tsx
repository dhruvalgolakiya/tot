import { previewOutput, toolDisplayStatus, toolIcon, toolTitle, type ToolPart } from "../lib/tools";
import { cardClass } from "./ui/Card";
import { TickText } from "./ui/TickText";
import { ToolStatusIcon } from "./ToolStatusIcon";

/** One computer tool call in the activity log: what ran, and the start of its output. */
export function ComputerActivityItem({ part, live }: { part: ToolPart; live: boolean }) {
  const Icon = toolIcon(part.name);
  const output = part.output ? previewOutput(part.output) : "";

  return (
    <li className={cardClass({ padding: "sm" })}>
      <div className="flex items-center gap-2 text-ui text-fg-muted">
        <Icon className="size-3.5 shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1 truncate">
          <TickText text={toolTitle(part)} />
        </span>
        <ToolStatusIcon status={toolDisplayStatus(part, live)} />
      </div>
      {output && (
        <pre className="mt-1.5 max-h-24 overflow-hidden font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg-subtle [overflow-wrap:anywhere]">
          {output}
        </pre>
      )}
    </li>
  );
}
