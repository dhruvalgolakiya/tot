import { useCallback, useEffect, useRef, useState } from "react";

const THRESHOLD_PX = 64;

/**
 * Keep a scroll container pinned to the bottom while its content grows
 * (streaming), unless the user has scrolled up. `atBottom` drives the
 * jump-to-bottom button.
 */
export function useStickToBottom() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;

    const onScroll = () => {
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      stick.current = distance < THRESHOLD_PX;
      setAtBottom(stick.current);
    };
    const observer = new ResizeObserver(() => {
      if (stick.current) scroller.scrollTop = scroller.scrollHeight;
    });

    scroller.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(content);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    stick.current = true;
    setAtBottom(true);
    scroller.scrollTo({ top: scroller.scrollHeight, behavior });
  }, []);

  return { scrollRef, contentRef, atBottom, scrollToBottom };
}
