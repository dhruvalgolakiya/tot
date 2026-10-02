import { useRef, useState, type MouseEvent } from "react";
import clsx from "clsx";
import { DropdownMenu } from "radix-ui";
import { Clock, Ellipsis, Pencil, Pin, PinOff, Trash } from "lucide-react";
import type { Conversation } from "@shared/types";
import { conversationTitle } from "../lib/conversations";
import { conversationPath } from "../lib/router";
import { deleteConversation, navigateToConversation, renameConversation, togglePinned, useStore } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";
import { StatusDot } from "./ui/StatusDot";

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
        className="h-9 w-full rounded-lg border bg-white/[0.06] px-2.5 text-sm text-zinc-100 outline-none"
        style={{ borderColor: "var(--agent-accent-border)" }}
      />
    );
  }

  return (
    <div
      className={clsx(
        "group relative flex h-9 items-center rounded-lg transition-colors",
        active ? "bg-white/[0.08] text-zinc-50" : "text-white/70 hover:bg-white/[0.04] hover:text-zinc-100",
      )}
    >
      <a
        href={conversationPath(conversation.id)}
        onClick={open}
        aria-current={active ? "page" : undefined}
        title={title}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pr-8 pl-2.5 text-[13px] outline-none"
      >
        {streaming && (
          <span
            className="size-1.5 shrink-0 animate-pulse rounded-full"
            style={{ background: "var(--agent-accent)" }}
          />
        )}
        {conversation.routineId && (
          <Clock className="size-3.5 shrink-0 text-zinc-500" aria-label="Scheduled routine" />
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
          <button
            type="button"
            aria-label={`Options for ${title}`}
            className={clsx(
              "absolute right-1 grid size-7 place-items-center rounded-md text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100 focus-visible:opacity-100",
              menuOpen || active ? "opacity-100" : "opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100",
            )}
          >
            <Ellipsis className="size-4" />
          </button>
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
              <Pencil className="size-4 text-zinc-400" /> Rename
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={() => togglePinned(conversation.id)}>
              {conversation.pinned ? (
                <>
                  <PinOff className="size-4 text-zinc-400" /> Unpin
                </>
              ) : (
                <>
                  <Pin className="size-4 text-zinc-400" /> Pin
                </>
              )}
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="menu-separator" />
            <DropdownMenu.Item
              className="menu-item text-red-400 data-[highlighted]:bg-red-500/10"
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
            This deletes <span className="font-medium text-zinc-200">{title}</span>. This can't be undone.
          </>
        }
        confirmLabel="Delete"
        onConfirm={() => void deleteConversation(conversation.id)}
      />
    </div>
  );
}
