import type { AppEvent, UpdateConversationRequest } from "@tot/shared/types";
import { HttpError } from "../agent/orchestrator.ts";
import { appEvents } from "../app-events.ts";
import { db, type Row } from "../db.ts";
import { conversations, toPublicConversation, type ConversationRecord } from "../data/conversations.ts";

/**
 * Keeping the chat list tidy: archived chats and snoozed ones stay out of it, and unread ones carry a dot.
 *
 * - A reply that finishes (or fails) makes its chat unread; the app marks it read when the user opens it.
 * - A new turn brings an archived or snoozed chat back: there's something new in it.
 * - A chat that needs the user (an approval or a question, a failed reply, a task that needs input or failed) is
 *   woken: back in the list, unread, whatever its snooze said.
 * - A snooze that runs out wakes its chat the same way.
 */

/** setTimeout's longest delay is ~24.8 days; a later snooze is looked at again after a day. */
const MAX_WAIT_MS = 86_400_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;

type OrganizePatch = { archivedAt?: number | null; snoozedUntil?: number | null; unread?: boolean };

function publish(record: ConversationRecord | null): void {
  if (record) appEvents.publish({ type: "conversation", conversation: toPublicConversation(record) });
}

/** Changes a chat's organizing state, telling every tab, unless it's already that way. */
function apply(id: string, patch: OrganizePatch): void {
  const record = conversations.get(id);
  if (!record) return;
  const changed =
    (patch.archivedAt !== undefined && (record.archivedAt ?? null) !== patch.archivedAt) ||
    (patch.snoozedUntil !== undefined && (record.snoozedUntil ?? null) !== patch.snoozedUntil) ||
    (patch.unread !== undefined && Boolean(record.unread) !== patch.unread);
  if (!changed) return;
  publish(conversations.update(id, patch));
  if (patch.snoozedUntil !== undefined) chatOrganizer.arm();
}

/** Back in the list, unread. */
function wake(id: string | null | undefined): void {
  if (id) apply(id, { archivedAt: null, snoozedUntil: null, unread: true });
}

function onEvent(event: AppEvent): void {
  if (event.type === "approval" && event.pending) wake(event.conversationId);
  else if (event.type === "task" && (event.conversation.task?.status === "needs-input" || event.conversation.task?.status === "failed")) {
    wake(event.conversation.id);
    wake(event.conversation.parentId);
  } else if (event.type === "run") {
    if (event.status === "running") apply(event.conversationId, { archivedAt: null, snoozedUntil: null });
    else if (event.status === "error") wake(event.conversationId);
    // A reply the user stopped isn't news to them.
    else if (event.status === "complete") apply(event.conversationId, { unread: true });
  }
}

export const chatOrganizer = {
  start(): void {
    unsubscribe ??= appEvents.subscribe(onEvent);
    chatOrganizer.arm();
  },

  stop(): void {
    unsubscribe?.();
    unsubscribe = null;
    if (timer) clearTimeout(timer);
    timer = null;
  },

  /** Sets the timer for the next snooze to run out (none when nothing is snoozed). */
  arm(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!unsubscribe) return;
    const row = db.prepare(`SELECT min(snoozed_until) AS next FROM conversations WHERE snoozed_until IS NOT NULL`).get() as Row;
    if (row.next === null) return;
    timer = setTimeout(() => chatOrganizer.wakeDue(), Math.min(Math.max(0, Number(row.next) - Date.now()), MAX_WAIT_MS));
    timer.unref?.();
  },

  /** Wakes every chat whose snooze has run out by `now`; returns their ids. */
  wakeDue(now = Date.now()): string[] {
    const due = db.prepare(`SELECT id FROM conversations WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?`).all(now) as Row[];
    const ids = due.map((row) => String(row.id));
    for (const id of ids) publish(conversations.update(id, { snoozedUntil: null, unread: true }));
    chatOrganizer.arm();
    return ids;
  },

  /**
   * The organizing part of a PATCH, checked, as columns: archiving ends a snooze and snoozing ends an archive (a chat
   * is one or the other). Undefined when the request has none of it.
   */
  patchFrom(request: UpdateConversationRequest, now = Date.now()): OrganizePatch | undefined {
    const patch: OrganizePatch = {};
    if (typeof request.archived === "boolean") {
      patch.archivedAt = request.archived ? now : null;
      if (request.archived) patch.snoozedUntil = null;
    }
    if (request.snoozedUntil !== undefined) {
      if (request.snoozedUntil !== null && (typeof request.snoozedUntil !== "number" || !Number.isFinite(request.snoozedUntil))) {
        throw new HttpError(400, "snoozedUntil must be a time (milliseconds) or null.");
      }
      if (request.snoozedUntil !== null && request.snoozedUntil <= now) throw new HttpError(400, "Snooze until a time that hasn't passed yet.");
      if (request.snoozedUntil !== null && typeof request.archived === "boolean") throw new HttpError(400, "Archive or snooze a chat, not both at once.");
      patch.snoozedUntil = request.snoozedUntil;
      if (request.snoozedUntil !== null) patch.archivedAt = null;
    }
    if (typeof request.unread === "boolean") patch.unread = request.unread;
    return Object.keys(patch).length ? patch : undefined;
  },
};
