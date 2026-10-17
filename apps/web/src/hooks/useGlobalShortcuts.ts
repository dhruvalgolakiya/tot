import { useEffect } from "react";
import { openNthChat, stepChat } from "../lib/chat-nav";
import { togglePalette } from "../lib/palette";
import { goToSettings, navigateToAgentHome, navigateToMission, selectActiveAgentId, useStore } from "../store";

/** Where the keys belong to what's focused: a rich text editor, a terminal. */
function ownsKeys(event: KeyboardEvent): boolean {
  const target = event.target instanceof HTMLElement ? event.target : null;
  return event.defaultPrevented || Boolean(target?.isContentEditable || target?.closest(".xterm, [data-own-shortcuts]"));
}

/**
 * ⌘⇧O / Ctrl+Shift+O: new chat. ⌘⇧M / Ctrl+Shift+M: mission control. ⌘K / Ctrl+K: the command palette (find a chat,
 * a message, anything). ⌘, / Ctrl+,: settings. ⌘⇧[ / ⌘⇧]: the previous / next chat in the list. ⌘1–⌘9: the list's
 * first to ninth chat.
 */
export function useGlobalShortcuts() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing) return;
      const key = event.key.toLowerCase();
      if (event.shiftKey && (event.code === "KeyO" || key === "o")) {
        event.preventDefault();
        const agentId = selectActiveAgentId(useStore.getState());
        if (agentId) navigateToAgentHome(agentId);
        requestAnimationFrame(() => document.getElementById("composer-input")?.focus());
      } else if (event.shiftKey && (event.code === "KeyM" || key === "m")) {
        event.preventDefault();
        // On a project's page, its own board.
        const s = useStore.getState();
        navigateToMission(s.page === "project" ? s.projectId : s.page === "mission" ? s.missionProjectId : null);
      } else if (!event.shiftKey && (event.code === "KeyK" || key === "k")) {
        event.preventDefault();
        togglePalette();
      } else if (!event.shiftKey && (event.code === "Comma" || key === ",")) {
        event.preventDefault();
        goToSettings();
      } else if (useStore.getState().page === "settings" || ownsKeys(event)) {
        // Settings may have unsaved changes, and leaves through its own guard.
      } else if (event.shiftKey && (event.code === "BracketLeft" || event.code === "BracketRight")) {
        event.preventDefault();
        stepChat(event.code === "BracketRight" ? 1 : -1);
      } else if (!event.shiftKey && /^Digit[1-9]$/.test(event.code)) {
        event.preventDefault();
        openNthChat(Number(event.code.slice(5)));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
