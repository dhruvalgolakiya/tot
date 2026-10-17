import { memo, useRef, useState, type MouseEvent } from "react";
import clsx from "clsx";
import { DropdownMenu } from "radix-ui";
import { Clock, Ellipsis, Mail, Pencil, Pin, PinOff, Ticket, Trash } from "lucide-react";
import type { Conversation } from "@tot/shared/types";
import { conversationTitle } from "../lib/conversations";
import { conversationPath } from "../lib/router";
import { deleteConversation, navigateToConversation, renameConversation, togglePinned, useStore } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";
import { OrganizeMenuItems } from "./organize/OrganizeMenuItems";
import { MoveToProjectSub } from "./projects/MoveToProjectMenu";
import { IconButton } from "./ui/IconButton";
import { listRowClass } from "./ui/ListRow";
import { GitHubMark } from "./ui/GitHubMark";
import { SlackMark } from "./ui/SlackMark";
import { NeedsYou, Working } from "./ui/Working";
import { CHAT_DRAG_TYPE } from "../lib/attached-chats";
import { Tip } from "./ui/Tip";

type ConversationItemProps = {
  conversation: Conversation;
  active: boolean;
  /** A run is streaming in this chat. */
  streaming: boolean;
  /** Tasks started from this chat that are still working. */
  workingTasks?: number;
  /** Where the row goes instead of the chat itself (a project's Lead opens the project's page). */
  href?: string;
  onOpen?: () => void;
};
/** How long the pointer rests on a row before its chat is fetched ahead of the click. */
const PREFETCH_HOVER_MS = 100;

/** Fetch a chat before it's opened (the store's prefetch, where there is one). */
function prefetch(id: string) {
  (useStore.getState() as { prefetchConversation?: (id: string) => unknown }).prefetchConversation?.(id);
}

/** Memoized: switching chats re-renders the two rows whose `active` changed, not the whole list. */
export const ConversationItem = memo(function ConversationItem({
  conversation,
  active,
  streaming,
  workingTasks = 0,
  href,
  onOpen,
}: ConversationItemProps) {
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The delete confirmation mounts the first time it's needed (and stays, for its closing animation).
  const [confirmMounted, setConfirmMounted] = useState(false);
  const hover = useRef(0);
  const [menuOpen, setMenuOpen] = useState(false);
  // Rename/Delete run after the menu has fully closed; a closing Radix menu
  // re-focuses itself on pointerleave and would steal focus from the dialog.
  const pendingAction = useRef<"rename" | "delete" | null>(null);
  const title = conversationTitle(conversation);
  const pendingApproval = useStore((s) => s.pendingApprovals.has(conversation.id));
  // The open chat is being read: no dot on it, even before the server hears so.
  const unread = Boolean(conversation.unread) && !active;

  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; // New tab/window.
    event.preventDefault();
    if (onOpen) onOpen();
    else navigateToConversation(conversation.id);
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
        href={href ?? conversationPath(conversation.id)}
        onClick={open}
        onPointerEnter={() => {
          window.clearTimeout(hover.current);
          hover.current = window.setTimeout(() => prefetch(conversation.id), PREFETCH_HOVER_MS);
        }}
        onPointerLeave={() => window.clearTimeout(hover.current)}
        onFocus={() => prefetch(conversation.id)}
        aria-current={active ? "page" : undefined}
        title={title}
        // Dropped on the composer, it's attached to the next message as reference.
        onDragStart={(event) => {
          event.dataTransfer.setData(CHAT_DRAG_TYPE, conversation.id);
          event.dataTransfer.effectAllowed = "copyLink";
        }}
        className={listRowClass({ selected: active, className: "pr-8" })}
      >
        {streaming && <Working label="Replying" />}
        {conversation.routineId && (
          <Clock className="size-3.5 shrink-0 text-fg-muted" aria-label="Scheduled routine" />
        )}
        {conversation.origin && (
          <Tip content={conversation.origin.label}>
            <span className="shrink-0 text-fg-muted" title={conversation.origin.label}>
              {conversation.origin.kind === "slack" ? (
                <SlackMark className="size-3" />
              ) : conversation.origin.kind === "github" ? (
                <GitHubMark className="size-3" />
              ) : conversation.origin.kind === "linear" ? (
                <Ticket className="size-3" />
              ) : (
                <Mail className="size-3" />
              )}
            </span>
          </Tip>
        )}
        <span className={clsx("min-w-0 flex-1 truncate", unread && "font-medium")}>{title}</span>
        {unread && <span className="sr-only">, unread</span>}
        {workingTasks > 0 && (
          <span
            title={`${workingTasks} task${workingTasks === 1 ? "" : "s"} working`}
            className="grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-fill px-1 text-2xs font-medium text-fg-muted tabular-nums"
          >
            {workingTasks}
          </span>
        )}
        {pendingApproval && <NeedsYou label="Needs your approval" />}
      </a>
      {/* Where the "…" button shows on hover, so it makes way for it. */}
      {unread && !menuOpen && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-3 size-2 -translate-y-1/2 rounded-full bg-accent transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:opacity-0"
        />
      )}

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
            className="menu w-48"
            onCloseAutoFocus={(event) => {
              const action = pendingAction.current;
              pendingAction.current = null;
              if (!action) return;
              event.preventDefault();
              if (action === "rename") setRenaming(true);
              else {
                setConfirmMounted(true);
                setConfirming(true);
              }
            }}
          >
            <DropdownMenu.Item className="menu-item" onSelect={() => {
                pendingAction.current = "rename";
              }}>
              <Pencil className="size-4 text-fg-muted" /> Rename
            </DropdownMenu.Item>
            {/* A project's Lead is pinned under its project already, and stays in it. */}
            {!conversation.lead && (
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
            )}
            {!conversation.lead && <MoveToProjectSub chat={conversation} />}
            <OrganizeMenuItems chat={conversation} />
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

      {confirmMounted && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Delete chat?"
          description={
            <>
              This deletes <span className="font-medium text-fg">{title}</span>. This can't be undone.
              {conversation.lead && " The project gets a fresh Lead the next time you open it."}
            </>
          }
          confirmLabel="Delete"
          onConfirm={() => void deleteConversation(conversation.id)}
        />
      )}
    </div>
  );
});
