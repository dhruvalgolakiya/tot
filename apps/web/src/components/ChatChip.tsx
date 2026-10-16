import type { MouseEvent } from "react";
import clsx from "clsx";
import { MessageSquare, X } from "lucide-react";
import { conversationPath } from "../lib/router";
import { navigateToConversation, useStore } from "../store";

/**
 * A chat attached to a message as reference: removable in the composer, a link to the chat on a
 * sent message.
 */
export function ChatChip({ conversationId, onRemove, className }: { conversationId: string; onRemove?: () => void; className?: string }) {
  const title = useStore((s) => s.conversations.find((c) => c.id === conversationId)?.title) ?? "A chat";
  const chip = clsx("inline-flex h-7 max-w-56 min-w-0 items-center gap-1.5 rounded-full border border-hairline bg-fill-subtle text-xs text-fg-muted", className);

  if (onRemove) {
    return (
      <span className={clsx(chip, "pr-1 pl-2.5")}>
        <MessageSquare className="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
        <span className="min-w-0 truncate text-fg">{title}</span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${title}`}
          className="grid size-5 shrink-0 place-items-center rounded-full text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
        >
          <X className="size-3" />
        </button>
      </span>
    );
  }

  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigateToConversation(conversationId);
  };
  return (
    <a href={conversationPath(conversationId)} onClick={open} title={`Attached: ${title}`} className={clsx(chip, "px-2.5 transition-colors hover:bg-hover hover:text-fg")}>
      <MessageSquare className="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
      <span className="min-w-0 truncate">{title}</span>
    </a>
  );
}
