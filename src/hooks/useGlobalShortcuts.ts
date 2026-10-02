import { useEffect } from "react";
import { focusSearch, goToSettings, navigateToAgentHome, selectActiveAgentId, useStore } from "../store";

/** ⌘⇧O / Ctrl+Shift+O: new chat. ⌘K / Ctrl+K: search chats. ⌘, / Ctrl+,: settings. */
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
      } else if (!event.shiftKey && (event.code === "KeyK" || key === "k")) {
        event.preventDefault();
        focusSearch();
      } else if (!event.shiftKey && (event.code === "Comma" || key === ",")) {
        event.preventDefault();
        goToSettings();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
