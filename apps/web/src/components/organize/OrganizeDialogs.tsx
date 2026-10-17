import { useMemo, useState, type ReactNode } from "react";
import { AlarmClockOff, ArchiveRestore, Trash } from "lucide-react";
import type { Conversation } from "@tot/shared/types";
import { conversationTitle } from "../../lib/conversations";
import { relativeTime } from "../../lib/format";
import { closeSnoozePicker, setArchivedOpen, snoozeChat, snoozeTime, useOrganize } from "../../lib/organize";
import {
  archiveConversation,
  deleteConversation,
  navigateToConversation,
  selectActiveAgentId,
  snoozeConversation,
  useStore,
} from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { listRowClass } from "../ui/ListRow";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";
import { Tip } from "../ui/Tip";

/** A datetime-local input's value for a time (local, to the minute). */
function localValue(at: number): string {
  const date = new Date(at);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

/** "Pick a date and time…" from a chat's Snooze menu. */
export function SnoozeDialog() {
  const id = useOrganize((s) => s.snoozeId);
  const title = useStore((s) => {
    const chat = id ? s.conversations.find((c) => c.id === id) : undefined;
    return chat ? conversationTitle(chat) : "";
  });
  return (
    <Modal
      open={id !== null}
      onOpenChange={(open) => !open && closeSnoozePicker()}
      title="Snooze until…"
      description={title ? <>“{title}” leaves the list until then, or until it needs you.</> : undefined}
      className="max-w-sm"
    >
      {id && <SnoozeForm key={id} id={id} />}
    </Modal>
  );
}

function SnoozeForm({ id }: { id: string }) {
  const [value, setValue] = useState(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    return localValue(tomorrow.getTime());
  });
  const at = new Date(value).getTime();
  const valid = Number.isFinite(at) && at > Date.now();
  const submit = () => {
    if (!valid) return;
    closeSnoozePicker();
    void snoozeChat(id, at);
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <ModalBody className="pb-4">
        <input
          type="datetime-local"
          aria-label="Date and time"
          autoFocus
          value={value}
          min={localValue(Date.now())}
          onChange={(event) => setValue(event.target.value)}
          aria-invalid={value && !valid ? "true" : undefined}
          className="input"
        />
        {value && !valid && <p className="mt-1.5 text-xs text-danger">Pick a time that hasn't passed yet.</p>}
      </ModalBody>
      <ModalFooter divider={false}>
        <Button variant="ghost" onClick={closeSnoozePicker}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!valid}>
          Snooze
        </Button>
      </ModalFooter>
    </form>
  );
}

/** The active agent's archived and snoozed chats, from the foot of the chat list: open, bring back, or delete. */
export function ArchivedDialog() {
  const open = useOrganize((s) => s.archivedOpen);
  const conversations = useStore((s) => s.conversations);
  const agentId = useStore(selectActiveAgentId);
  const agentName = useStore((s) => s.agents.find((a) => a.id === agentId)?.name);
  const [deleting, setDeleting] = useState<Conversation | null>(null);

  const { snoozed, archived } = useMemo(() => {
    const now = Date.now();
    const mine = conversations.filter((c) => c.agentId === agentId && c.kind === "chat" && !c.lead);
    return {
      snoozed: mine.filter((c) => !c.archivedAt && (c.snoozedUntil ?? 0) > now).sort((a, b) => a.snoozedUntil! - b.snoozedUntil!),
      archived: mine.filter((c) => c.archivedAt).sort((a, b) => b.archivedAt! - a.archivedAt!),
    };
  }, [conversations, agentId]);

  const openChat = (id: string) => {
    setArchivedOpen(false);
    navigateToConversation(id);
  };

  return (
    <>
      <Modal
        open={open}
        onOpenChange={setArchivedOpen}
        title="Archived chats"
        description={`${agentName ? `${agentName}'s chats` : "Chats"} out of the list. Snoozed ones come back on their own, and any of them comes back when there's something new in it.`}
        className="max-w-md"
      >
        <ModalBody className="space-y-5">
          {snoozed.length === 0 && archived.length === 0 && (
            <EmptyState size="sm" variant="quiet" description="Nothing archived or snoozed." />
          )}
          {snoozed.length > 0 && (
            <section>
              <h3 className="group-label px-2.5 pb-1">Snoozed</h3>
              <ul className="space-y-px">
                {snoozed.map((chat) => (
                  <HiddenRow
                    key={chat.id}
                    chat={chat}
                    meta={`until ${snoozeTime(chat.snoozedUntil!)}`}
                    restoreLabel="Unsnooze"
                    restoreIcon={<AlarmClockOff />}
                    onOpen={() => openChat(chat.id)}
                    onRestore={() => void snoozeConversation(chat.id, null)}
                    onDelete={() => setDeleting(chat)}
                  />
                ))}
              </ul>
            </section>
          )}
          {archived.length > 0 && (
            <section>
              <h3 className="group-label px-2.5 pb-1">Archived</h3>
              <ul className="space-y-px">
                {archived.map((chat) => (
                  <HiddenRow
                    key={chat.id}
                    chat={chat}
                    meta={relativeTime(chat.archivedAt!)}
                    restoreLabel="Unarchive"
                    restoreIcon={<ArchiveRestore />}
                    onOpen={() => openChat(chat.id)}
                    onRestore={() => void archiveConversation(chat.id, false)}
                    onDelete={() => setDeleting(chat)}
                  />
                ))}
              </ul>
            </section>
          )}
        </ModalBody>
      </Modal>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => !next && setDeleting(null)}
        title="Delete chat?"
        description={
          <>
            This deletes <span className="font-medium text-fg">{deleting ? conversationTitle(deleting) : ""}</span>. This can't be undone.
          </>
        }
        confirmLabel="Delete"
        onConfirm={() => deleting && void deleteConversation(deleting.id)}
      />
    </>
  );
}

interface HiddenRowProps {
  chat: Conversation;
  meta: string;
  restoreLabel: string;
  restoreIcon: ReactNode;
  onOpen: () => void;
  onRestore: () => void;
  onDelete: () => void;
}

function HiddenRow({ chat, meta, restoreLabel, restoreIcon, onOpen, onRestore, onDelete }: HiddenRowProps) {
  const title = conversationTitle(chat);
  return (
    <li className="group relative">
      <button type="button" onClick={onOpen} title={title} className={listRowClass()}>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="min-w-16 shrink-0 text-right text-xs text-fg-subtle transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:opacity-0 tabular-nums">
          {meta}
        </span>
      </button>
      <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100">
        <Tip content={restoreLabel}>
          <IconButton label={`${restoreLabel} ${title}`} size="sm" onClick={onRestore}>
            {restoreIcon}
          </IconButton>
        </Tip>
        <Tip content="Delete">
          <IconButton label={`Delete ${title}`} size="sm" onClick={onDelete}>
            <Trash />
          </IconButton>
        </Tip>
      </div>
    </li>
  );
}
