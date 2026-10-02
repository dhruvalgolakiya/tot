import { Check, CircleAlert, Copy } from "lucide-react";
import type { Message } from "@shared/types";
import { useCopy } from "../hooks/useCopy";
import { formatDuration } from "../lib/format";
import { answeredByLabel, PROVIDER_LABELS } from "../lib/models";
import { messageText } from "../lib/tools";
import { useStore } from "../store";
import { IconButton } from "./ui/IconButton";
import { Tip } from "./ui/Tip";

/** Under a finished assistant message: error, copy, model (why it was picked), stop state. */
export function MessageMeta({ message }: { message: Message }) {
  const models = useStore((s) => s.models);
  const { copied, copy } = useCopy();
  const text = messageText(message);
  const label = answeredByLabel(models, message);
  const why = message.routeReason ?? (message.provider ? `${PROVIDER_LABELS[message.provider]} · ${message.model}` : "");
  const tooltip = [why, message.usage?.durationMs ? `took ${formatDuration(message.usage.durationMs)}` : ""]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mt-2">
      {message.status === "error" && (
        <div className="mb-2 flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/[0.07] px-3 py-2.5 text-sm text-red-300">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{message.error || "Something went wrong while answering."}</span>
        </div>
      )}
      <div className="flex h-7 items-center gap-0.5 text-xs text-zinc-500 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
        {text && (
          <Tip content={copied ? "Copied" : "Copy"}>
            <IconButton label="Copy message" size="sm" onClick={() => void copy(text)}>
              {copied ? <Check /> : <Copy />}
            </IconButton>
          </Tip>
        )}
        {label && (
          <Tip content={tooltip} align="start">
            <span tabIndex={0} className="cursor-default rounded-md px-1.5 py-0.5 outline-none hover:text-zinc-300">
              {label}
            </span>
          </Tip>
        )}
        {message.status === "stopped" && <span className="px-1 text-zinc-400">· Stopped</span>}
        {message.status === "streaming" && <span className="px-1">· Interrupted</span>}
      </div>
    </div>
  );
}
