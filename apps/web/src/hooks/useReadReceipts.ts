import { useEffect, useRef, useSyncExternalStore } from "react";
import { selectCurrentConversation, setConversationUnread, useStore } from "../store";

const subscribeVisibility = (listener: () => void) => {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};

/**
 * An unread chat becomes read while it's open and on screen (opened, or a reply arriving while it's open); so does a
 * project's Lead while its page is.
 */
export function useReadReceipts() {
  const unreadId = useStore((s) => {
    // A project's page shows its Lead chat.
    const current =
      s.page === "chat"
        ? selectCurrentConversation(s)
        : s.page === "project"
          ? s.conversations.find((c) => c.lead && c.projectId === s.projectId)
          : undefined;
    return current?.unread ? current.id : null;
  });
  const visible = useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible");
  // A chat whose read receipt failed (its device offline) isn't asked again on every render.
  const failed = useRef(new Set<string>());
  useEffect(() => {
    if (!unreadId || !visible || failed.current.has(unreadId)) return;
    void setConversationUnread(unreadId, false).then((ok) => ok || failed.current.add(unreadId));
  }, [unreadId, visible]);
}
