import { useRef } from "react";
import { messageText } from "../../lib/tools";
import { useStore } from "../../store";

/** The chat's own prompts, oldest first (repeats in a row once), read when asked rather than on every streamed change. */
function promptsOf(conversationId: string): string[] {
  const prompts: string[] = [];
  for (const message of useStore.getState().messages[conversationId] ?? []) {
    if (message.role !== "user" || message.auto) continue;
    const text = messageText(message).trim();
    if (text && text !== prompts.at(-1)) prompts.push(text);
  }
  return prompts;
}

/**
 * ↑ and ↓ through the prompts sent in this chat, like a shell: ↑ in an empty composer brings back the last one, again
 * for the one before; ↓ goes forward, and past the newest back to empty. Editing a recalled prompt leaves the history.
 */
export function usePromptHistory(conversationId: string | null) {
  const at = useRef<{ index: number; text: string } | null>(null);

  return {
    /** The prompt before the one shown, or null when ↑ should just move the caret. */
    back(current: string): string | null {
      if (!conversationId) return null;
      const prompts = promptsOf(conversationId);
      const shown = at.current?.text === current ? at.current : null;
      if (!shown && current.trim()) return null;
      const index = shown ? shown.index - 1 : prompts.length - 1;
      if (index < 0) return null;
      at.current = { index, text: prompts[index]! };
      return prompts[index]!;
    },

    /** The prompt after the one shown (empty past the newest), or null when the composer isn't showing one. */
    forward(current: string): string | null {
      if (!conversationId || at.current?.text !== current) return null;
      const prompts = promptsOf(conversationId);
      const index = at.current.index + 1;
      if (index >= prompts.length) {
        at.current = null;
        return "";
      }
      at.current = { index, text: prompts[index]! };
      return prompts[index]!;
    },
  };
}
