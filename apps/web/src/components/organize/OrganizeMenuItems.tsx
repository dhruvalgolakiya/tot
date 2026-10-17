import { DropdownMenu } from "radix-ui";
import { AlarmClock, AlarmClockOff, Archive, ArchiveRestore, CalendarClock, ChevronRight, Mail, MailOpen } from "lucide-react";
import type { Conversation } from "@tot/shared/types";
import { archiveChat, openSnoozePicker, snoozeChat, snoozePresets, snoozeTime } from "../../lib/organize";
import { archiveConversation, setConversationUnread, snoozeConversation } from "../../store";

/** A chat's "…" menu items for keeping the list tidy: unread, snooze, archive. Not for a project's Lead (it stays put). */
export function OrganizeMenuItems({ chat }: { chat: Conversation }) {
  if (chat.lead) return null;
  const snoozedUntil = (chat.snoozedUntil ?? 0) > Date.now() ? chat.snoozedUntil! : null;

  return (
    <>
      <DropdownMenu.Item className="menu-item" onSelect={() => void setConversationUnread(chat.id, !chat.unread)}>
        {chat.unread ? <MailOpen className="size-4 text-fg-muted" /> : <Mail className="size-4 text-fg-muted" />}
        {chat.unread ? "Mark as read" : "Mark as unread"}
      </DropdownMenu.Item>
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger className="menu-item data-[state=open]:bg-hover">
          <AlarmClock className="size-4 text-fg-muted" />
          <span className="flex-1">Snooze</span>
          <ChevronRight className="size-4 text-fg-subtle" />
        </DropdownMenu.SubTrigger>
        <DropdownMenu.Portal>
          <DropdownMenu.SubContent sideOffset={6} alignOffset={-4} collisionPadding={8} className="menu w-64">
            {snoozedUntil && (
              <>
                <DropdownMenu.Item className="menu-item" onSelect={() => void snoozeConversation(chat.id, null)}>
                  <AlarmClockOff className="size-4 text-fg-muted" />
                  <span className="flex-1">Unsnooze</span>
                  <span className="text-xs text-fg-subtle">{snoozeTime(snoozedUntil)}</span>
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="menu-separator" />
              </>
            )}
            {snoozePresets().map((preset) => (
              <DropdownMenu.Item key={preset.id} className="menu-item" onSelect={() => void snoozeChat(chat.id, preset.at)}>
                <span className="flex-1">{preset.label}</span>
                <span className="text-xs text-fg-subtle">{snoozeTime(preset.at)}</span>
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator className="menu-separator" />
            <DropdownMenu.Item className="menu-item" onSelect={() => openSnoozePicker(chat.id)}>
              <CalendarClock className="size-4 text-fg-muted" />
              Pick a date and time…
            </DropdownMenu.Item>
          </DropdownMenu.SubContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Sub>
      {chat.archivedAt ? (
        <DropdownMenu.Item className="menu-item" onSelect={() => void archiveConversation(chat.id, false)}>
          <ArchiveRestore className="size-4 text-fg-muted" /> Unarchive
        </DropdownMenu.Item>
      ) : (
        <DropdownMenu.Item className="menu-item" onSelect={() => void archiveChat(chat.id)}>
          <Archive className="size-4 text-fg-muted" /> Archive
        </DropdownMenu.Item>
      )}
    </>
  );
}
