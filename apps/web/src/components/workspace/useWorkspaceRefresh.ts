import { useEffect, useRef } from "react";
import { useAppEvents } from "../../hooks/useAppEvents";
import { workspaceApi } from "../../lib/workspace";

const SETTLE_MS = 150;

/**
 * One stream per chat saying its folder's files changed, shared by every tab and button that listens: a browser
 * keeps only a few connections open to one server, and the app's own streams need theirs.
 */
const channels = new Map<string, { source: EventSource; listeners: Set<() => void> }>();

function listen(chatId: string, listener: () => void): () => void {
  let channel = channels.get(chatId);
  if (!channel) {
    const source = new EventSource(workspaceApi.eventsUrl(chatId));
    const created = { source, listeners: new Set<() => void>() };
    const tell = () => {
      for (const each of [...created.listeners]) each();
    };
    let dropped = false;
    source.onmessage = (message) => {
      if (message.data) tell();
    };
    source.onerror = () => {
      dropped = true;
    };
    // Back after a dropped connection: anything may have changed meanwhile.
    source.onopen = () => {
      if (dropped) tell();
      dropped = false;
    };
    channel = created;
    channels.set(chatId, channel);
  }
  const open = channel;
  open.listeners.add(listener);
  return () => {
    open.listeners.delete(listener);
    if (open.listeners.size || channels.get(chatId) !== open) return;
    open.source.close();
    channels.delete(chatId);
  };
}

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
    const stop = listen(chatId, soon);
    window.addEventListener("focus", soon);
    return () => {
      window.clearTimeout(timer);
      stop();
      window.removeEventListener("focus", soon);
      soonRef.current = () => {};
    };
  }, [chatId]);

  useAppEvents((event) => {
    if (event.type === "run" && event.conversationId === chatId) soonRef.current();
  });
}
