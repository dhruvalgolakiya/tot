import { useEffect, useRef } from "react";
import { useAppEvents } from "../../hooks/useAppEvents";
import { workspaceApi } from "../../lib/workspace";

const SETTLE_MS = 150;

/**
 * Calls `refresh` when what's in the chat's folder may have changed: files in it changed (the server watches
 * it), a turn of the chat started or ended (the agent edits files), or the window came back into focus. Close
 * calls come out as one.
 */
export function useWorkspaceRefresh(chatId: string, refresh: () => void): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const soonRef = useRef<() => void>(() => {});

  useEffect(() => {
    let timer = 0;
    const soon = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => refreshRef.current(), SETTLE_MS);
    };
    soonRef.current = soon;
    const source = new EventSource(workspaceApi.eventsUrl(chatId));
    let dropped = false;
    source.onmessage = (message) => {
      if (message.data) soon();
    };
    source.onerror = () => {
      dropped = true;
    };
    // Back after a dropped connection: anything may have changed meanwhile.
    source.onopen = () => {
      if (dropped) soon();
      dropped = false;
    };
    window.addEventListener("focus", soon);
    return () => {
      window.clearTimeout(timer);
      source.close();
      window.removeEventListener("focus", soon);
      soonRef.current = () => {};
    };
  }, [chatId]);

  useAppEvents((event) => {
    if (event.type === "run" && event.conversationId === chatId) soonRef.current();
  });
}
