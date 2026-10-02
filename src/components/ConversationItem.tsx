import { useRef, useState, type MouseEvent } from "react";
import clsx from "clsx";
import { DropdownMenu } from "radix-ui";
import { Clock, Ellipsis, Pencil, Pin, PinOff, Trash } from "lucide-react";
import type { Conversation } from "@shared/types";
import { conversationTitle } from "../lib/conversations";
import { conversationPath } from "../lib/router";
import { deleteConversation, navigateToConversation, renameConversation, togglePinned, useStore } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconButton } from "./ui/IconButton";
import { listRowClass } from "./ui/ListRow";
import { SlackMark } from "./ui/SlackMark";
import { StatusDot } from "./ui/StatusDot";
import { Tip } from "./ui/Tip";

type ConversationItemProps = {
  conversation: Conversation;
  active: boolean;
  /** A run is streaming in this chat. */
  streaming: boolean;
};

export function ConversationItem({ conversation, active, streaming }: ConversationItemProps) {
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Rename/Delete run after the menu has fully closed; a closing Radix menu
  // re-focuses itself on pointerleave and would steal focus from the dialog.
  const pendingAction = useRef<"rename" | "delete" | null>(null);
  const title = conversationTitle(conversation);
  const pendingApproval = useStore((s) => s.pendingApprovals.has(conversation.id));

  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; // New tab/window.
    event.preventDefault();
    navigateToConversation(conversation.id);
  };

  if (renaming) {
    const finish = (value: string | null) => {
      setRenaming(false);
      if (value !== null) renameConversation(conversation.id, value);
    };
    return (
      <input
        autoFocus
        defaultValue={title}
        aria-label="Chat title"
        onFocus={(event) => event.currentTarget.select()}
        onBlur={(event) => finish(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") finish(event.currentTarget.value);
          if (event.key === "Escape") finish(null);
        }}
        className="h-9 w-full rounded-lg border bg-fill px-2.5 text-sm text-fg focus-visible:-outline-offset-2"
        style={{ borderColor: "var(--agent-accent-border)" }}
      />
    );
  }

  return (
    <div className="group relative">
      <a
        href={conversationPath(conversation.id)}
        onClick={open}
        aria-current={active ? "page" : undefined}
        title={title}
        className={listRowClass({ selected: active, className: "pr-8" })}
      >
        {streaming && (
          <span
            className="size-1.5 shrink-0 animate-pulse rounded-full"
            style={{ background: "var(--agent-accent)" }}
          />
        )}
        {conversation.routineId && (
          <Clock className="size-3.5 shrink-0 text-fg-subtle" aria-label="Scheduled routine" />
        )}
        {conversation.origin?.kind === "slack" && (
          <Tip content={conversation.origin.label}>
            <span className="shrink-0 text-fg-subtle" title={conversation.origin.label}>
              <SlackMark className="size-3" />
            </span>
          </Tip>
        )}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {pendingApproval && (
          <span title="Needs your approval">
            <StatusDot tone="amber" />
          </span>
        )}
      </a>

      <DropdownMenu.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenu.Trigger asChild>
          <IconButton
            label={`Options for ${title}`}
            size="sm"
            className={clsx(
              "absolute top-1/2 right-1 -translate-y-1/2",
              menuOpen || active
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
            )}
          >
            <Ellipsis />
          </IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={4}
            className="menu w-44"
            onCloseAutoFocus={(event) => {
              const action = pendingAction.current;
              pendingAction.current = null;
              if (!action) return;
              event.preventDefault();
              if (action === "rename") setRenaming(true);
              else setConfirming(true);
            }}
          >
            <DropdownMenu.Item className="menu-item" onSelect={() => {
                pendingAction.current = "rename";
              }}>
              <Pencil className="size-4 text-fg-muted" /> Rename
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={() => togglePinned(conversation.id)}>
              {conversation.pinned ? (
                <>
                  <PinOff className="size-4 text-fg-muted" /> Unpin
                </>
              ) : (
                <>
                  <Pin className="size-4 text-fg-muted" /> Pin
                </>
              )}
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="menu-separator" />
            <DropdownMenu.Item
              className="menu-item menu-item-danger"
              onSelect={() => {
                pendingAction.current = "delete";
              }}
            >
              <Trash className="size-4" /> Delete
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete chat?"
        description={
          <>
            This deletes <span className="font-medium text-fg">{title}</span>. This can't be undone.
          </>
        }
        confirmLabel="Delete"
        onConfirm={() => void deleteConversation(conversation.id)}
      />
    </div>
  );
}
