import clsx from "clsx";
import { DropdownMenu } from "radix-ui";
import { Check, Copy, Ellipsis, GitFork } from "lucide-react";
import type { Message } from "@shared/types";
import { useCopy } from "../hooks/useCopy";
import { formatDuration } from "../lib/format";
import { answeredByLabel, PROVIDER_LABELS } from "../lib/models";
import { messageText } from "../lib/tools";
import { forkChat, useStore } from "../store";
import { Callout } from "./ui/Callout";
import { IconButton } from "./ui/IconButton";
import { Tip } from "./ui/Tip";

/** Under a finished assistant message: error, copy, more (fork from here), model (why it was picked), stop state. */
export function MessageMeta({ message, isLatest = false }: { message: Message; isLatest?: boolean }) {
  const models = useStore((s) => s.models);
  // Replies in chats fork (not TOT's own notices; tasks don't fork yet).
  const inChat = useStore((s) => s.conversations.find((c) => c.id === message.conversationId)?.kind === "chat");
  const forkable = inChat && Boolean(message.provider);
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
        {forkable && (
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <IconButton label="More message actions" size="sm">
                <Ellipsis />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="start" sideOffset={4} className="menu w-48">
                <DropdownMenu.Item className="menu-item" onSelect={() => void forkChat(message.conversationId, message.id)}>
                  <GitFork className="size-4 text-fg-muted" />
                  <span className="flex-1">Fork from here</span>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
        {label && (
          <Tip content={tooltip} align="start">
            <span tabIndex={0} className="cursor-default rounded-md px-1.5 py-0.5 hover:text-fg-muted">
              {label}
            </span>
          </Tip>
        )}
        {message.status === "stopped" && <span className="px-1 text-fg-muted">· {message.error ? message.error.replace(/\.$/, "") : "Stopped"}</span>}
        {message.status === "streaming" && <span className="px-1">· Interrupted</span>}
      </div>
    </div>
  );
}
