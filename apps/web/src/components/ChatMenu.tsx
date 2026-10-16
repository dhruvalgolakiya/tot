import { DropdownMenu } from "radix-ui";
import { ArrowUpRight, Ellipsis, GitFork, GitMerge } from "lucide-react";
import type { Conversation } from "@tot/shared/types";
import { forkChat, mergeBack, useStore } from "../store";
import { chatTicket } from "./projects/ChatProjectCrumb";
import { MoveToProjectSub } from "./projects/MoveToProjectMenu";
import { IconButton } from "./ui/IconButton";

/** The open chat's "…" menu in the header. */
export function ChatMenu({ chat }: { chat: Conversation }) {
  const busy = useStore((s) => Boolean(s.activeRuns[chat.id]));
  const source = useStore((s) => (chat.forkedFrom ? s.conversations.find((c) => c.id === chat.forkedFrom!.conversationId) : undefined));
  const ticket = chatTicket(chat);

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <IconButton label="More chat actions">
          <Ellipsis />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className="menu w-56">
          <DropdownMenu.Item className="menu-item" disabled={busy} onSelect={() => void forkChat(chat.id)}>
            <GitFork className="size-4 text-fg-muted" />
            <span className="flex-1">Fork chat</span>
          </DropdownMenu.Item>
          {source && (
            <DropdownMenu.Item className="menu-item" onSelect={() => void mergeBack(chat.id)}>
              <GitMerge className="size-4 text-fg-muted" />
              <span className="min-w-0 flex-1 truncate">Bring back to {source.title}</span>
            </DropdownMenu.Item>
          )}
          <MoveToProjectSub chat={chat} />
          {/* Phones: the header has no room for the ticket chip. */}
          {ticket?.url && (
            <DropdownMenu.Item asChild className="menu-item sm:hidden">
              <a href={ticket.url} target="_blank" rel="noopener noreferrer">
                <ArrowUpRight className="size-4 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate">Open {ticket.key}</span>
              </a>
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
