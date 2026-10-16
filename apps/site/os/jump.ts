import { useEffect, useRef } from "react";

type Listener = (key: string) => void;

/**
 * A one-shot "jump to this item" request from the launcher to an app: a feature in What's inside, a question in
 * Help. If the app isn't open yet, the request waits for it to mount.
 */
export function createJump() {
  const listeners = new Set<Listener>();
  let pending: string | null = null;
  return {
    request(key: string) {
      pending = key;
      for (const listener of listeners) listener(key);
    },
    useJump(onJump: Listener) {
      const latest = useRef(onJump);
      latest.current = onJump;
      useEffect(() => {
        const listener = (key: string) => {
          pending = null;
          // Let a freshly opened window lay out first.
          requestAnimationFrame(() => latest.current(key));
        };
        listeners.add(listener);
        if (pending) listener(pending);
        return () => void listeners.delete(listener);
      }, []);
    },
  };
}

/** Scrolls an element's own scroll container (a window body or a sheet) so the element sits near the top. */
export function scrollToChild(element: HTMLElement) {
  let container = element.parentElement;
  while (container && !/(auto|scroll)/.test(getComputedStyle(container).overflowY)) container = container.parentElement;
  if (!container) return;
  const top = element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 16;
  container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}
