import { toast } from "sonner";
import { create } from "zustand";
import { archiveConversation, snoozeConversation } from "../store";

/** The dialogs for organizing chats: picking a snooze time, and the archived and snoozed chats. */
export const useOrganize = create<{ snoozeId: string | null; archivedOpen: boolean }>()(() => ({ snoozeId: null, archivedOpen: false }));

export const openSnoozePicker = (id: string) => useOrganize.setState({ snoozeId: id });
export const closeSnoozePicker = () => useOrganize.setState({ snoozeId: null });
export const setArchivedOpen = (open: boolean) => useOrganize.setState({ archivedOpen: open });

export interface SnoozePreset {
  id: "later" | "tomorrow" | "next-week";
  label: string;
  at: number;
}

const MORNING_HOUR = 9;

/** Later today (three hours on, to the hour, while that's still today), tomorrow morning, and next Monday morning. */
export function snoozePresets(now = new Date()): SnoozePreset[] {
  const presets: SnoozePreset[] = [];
  const later = new Date(now);
  later.setHours(now.getHours() + 3, 0, 0, 0);
  if (later.getDate() === now.getDate() && later.getHours() < 22) presets.push({ id: "later", label: "Later today", at: later.getTime() });
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, MORNING_HOUR);
  presets.push({ id: "tomorrow", label: "Tomorrow", at: tomorrow.getTime() });
  const daysToMonday = ((8 - now.getDay()) % 7) || 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysToMonday, MORNING_HOUR);
  // On a Sunday, "tomorrow" is Monday already: next week is the Monday after.
  if (daysToMonday === 1) monday.setDate(monday.getDate() + 7);
  presets.push({ id: "next-week", label: "Next week", at: monday.getTime() });
  return presets;
}

/** "6:00 PM" today, "Sat 9:00 AM" this week, "Mon, Oct 27, 9:00 AM" later. */
export function snoozeTime(at: number, now = new Date()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return time;
  if (at - now.getTime() < 6 * 86_400_000) return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return date.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Archive a chat, with an Undo in the toast. */
export async function archiveChat(id: string): Promise<void> {
  if (!(await archiveConversation(id))) return;
  toast("Chat archived", { id: `organize-${id}`, action: { label: "Undo", onClick: () => void archiveConversation(id, false) } });
}

/** Snooze a chat until `at`, with an Undo in the toast. */
export async function snoozeChat(id: string, at: number): Promise<void> {
  if (!(await snoozeConversation(id, at))) return;
  toast(`Snoozed until ${snoozeTime(at)}`, {
    id: `organize-${id}`,
    description: "It comes back sooner if it needs you.",
    action: { label: "Undo", onClick: () => void snoozeConversation(id, null) },
  });
}
