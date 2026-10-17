import { create } from "zustand";
import type { Attachment } from "@tot/shared/types";

/**
 * Stashed drafts: ⌘S in the composer puts what's being written (text, attachments, attached chats, named files) aside
 * on this device, to pick up later in any chat. Kept in localStorage, newest first.
 */

export interface StashedDraft {
  id: string;
  text: string;
  attachments: Attachment[];
  /** The device the attachments were uploaded to (module 07): they only come back in a chat on that device. */
  deviceId: string | null;
  contextChats: string[];
  files: string[];
  savedAt: number;
}

const KEY = "tot:stash";
const MAX_STASHED = 30;

function read(): StashedDraft[] {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(saved) ? saved.filter((entry): entry is StashedDraft => Boolean(entry) && typeof entry.id === "string" && typeof entry.text === "string") : [];
  } catch {
    return [];
  }
}

function write(drafts: StashedDraft[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(drafts));
  } catch {
    // Storage can be unavailable (private mode): the stash lasts until the tab closes.
  }
}

export const useStash = create<{ drafts: StashedDraft[] }>()(() => ({ drafts: read() }));

// Another tab stashed or restored: show the same list.
window.addEventListener("storage", (event) => {
  if (event.key === KEY) useStash.setState({ drafts: read() });
});

function update(next: (drafts: StashedDraft[]) => StashedDraft[]) {
  const drafts = next(useStash.getState().drafts);
  useStash.setState({ drafts });
  write(drafts);
}

export function stashDraft(draft: Omit<StashedDraft, "id" | "savedAt">) {
  const entry: StashedDraft = { ...draft, id: `stash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, savedAt: Date.now() };
  update((drafts) => [entry, ...drafts].slice(0, MAX_STASHED));
}

export function dropStashed(id: string) {
  update((drafts) => drafts.filter((draft) => draft.id !== id));
}

/** A stashed draft's one-line preview. */
export function stashPreview(draft: StashedDraft): string {
  const text = draft.text.replace(/\s+/g, " ").trim();
  if (text) return text;
  const count = draft.attachments.length;
  return count === 1 ? draft.attachments[0]!.name : count ? `${count} attachments` : "Empty draft";
}
