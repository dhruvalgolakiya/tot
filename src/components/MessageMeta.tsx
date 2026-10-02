import clsx from "clsx";
import { Check, Copy } from "lucide-react";
import type { Message } from "@shared/types";
import { useCopy } from "../hooks/useCopy";
import { formatDuration } from "../lib/format";
import { answeredByLabel, PROVIDER_LABELS } from "../lib/models";
import { messageText } from "../lib/tools";
import { useStore } from "../store";
import { Callout } from "./ui/Callout";
import { IconButton } from "./ui/IconButton";
import { Tip } from "./ui/Tip";

/** Under a finished assistant message: error, copy, model (why it was picked), stop state. */
export function MessageMeta({ message, isLatest = false }: { message: Message; isLatest?: boolean }) {
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
        <div className="mb-2">
          <Callout tone="danger">{message.error || "Something went wrong while answering."}</Callout>
        </div>
      )}
      <div
        className={clsx(
          "flex h-7 items-center gap-0.5 text-xs text-fg-subtle transition-opacity",
          !isLatest && "opacity-0 group-hover/message:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100",
        )}
      >
        {text && (
          <Tip content={copied ? "Copied" : "Copy"}>
            <IconButton label="Copy message" size="sm" onClick={() => void copy(text)}>
              {copied ? <Check /> : <Copy />}
            </IconButton>
          </Tip>
        )}
        {label && (
          <Tip content={tooltip} align="start">
            <span tabIndex={0} className="cursor-default rounded-md px-1.5 py-0.5 hover:text-fg-muted">
              {label}
            </span>
          </Tip>
        )}
        {message.status === "stopped" && <span className="px-1 text-fg-muted">· Stopped</span>}
        {message.status === "streaming" && <span className="px-1">· Interrupted</span>}
      </div>
    </div>
  );
}
