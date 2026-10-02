import { previewOutput, toolDisplayStatus, toolIcon, toolTitle, type ToolPart } from "../lib/tools";
import { TickText } from "./ui/TickText";
import { ToolStatusIcon } from "./ToolStatusIcon";

/** One computer tool call in the activity log: what ran, and the start of its output. */
export function ComputerActivityItem({ part, live }: { part: ToolPart; live: boolean }) {
  const Icon = toolIcon(part.name);
  const output = part.output ? previewOutput(part.output) : "";

  return (
    <li className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
      <div className="flex items-center gap-2 text-[13px] text-zinc-300">
        <Icon className="size-3.5 shrink-0 text-zinc-500" />
        <span className="min-w-0 flex-1 truncate">
          <TickText text={toolTitle(part)} />
        </span>
        <ToolStatusIcon status={toolDisplayStatus(part, live)} />
      </div>
      {output && (
        <pre className="mt-1.5 max-h-24 overflow-hidden font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-500 [overflow-wrap:anywhere]">
          {output}
        </pre>
      )}
    </li>
  );
}
