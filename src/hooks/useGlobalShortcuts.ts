import { useEffect } from "react";
import { focusSearch, goToSettings, navigateToAgentHome, navigateToMission, selectActiveAgentId, useStore } from "../store";

/** ⌘⇧O / Ctrl+Shift+O: new chat. ⌘⇧M / Ctrl+Shift+M: mission control. ⌘K / Ctrl+K: search chats. ⌘, / Ctrl+,: settings. */
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
