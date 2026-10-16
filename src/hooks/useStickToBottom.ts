import { useCallback, useLayoutEffect, useRef, useState } from "react";

const THRESHOLD_PX = 64;

/**
 * Keep a scroll container pinned to the bottom while its content grows
 * (streaming), unless the user has scrolled up. `atBottom` drives the
 * jump-to-bottom button; `stuck` is the same, read without a render.
 *
 * Inside a hidden <Activity> the list keeps its state but not its scroll
 * position (display: none forgets it), so showing it again puts it back:
 * at the bottom, or where the user had scrolled to.
 */
export function useStickToBottom() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  // A layout effect, so a list that's shown again is back in place before it paints.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;

    if (stick.current) scroller.scrollTop = scroller.scrollHeight;
    else if (lastTop.current !== null) scroller.scrollTop = lastTop.current;

    let frame = 0;
    const onScroll = () => {
      lastTop.current = scroller.scrollTop;
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      stick.current = distance < THRESHOLD_PX;
      // Scroll events come many per frame; the button only needs the last word.
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          setAtBottom(stick.current);
        });
      }
    };
    // ResizeObserver reports at most once a frame, after layout and before paint, so the
    // list scrolls in the same frame it grew (no frame drawn with the new text off-screen).
    const observer = new ResizeObserver(() => {
      if (stick.current) scroller.scrollTop = scroller.scrollHeight;
    });

    scroller.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(content);
    return () => {
      cancelAnimationFrame(frame);
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

  return { scrollRef, contentRef, atBottom, stuck: stick, scrollToBottom };
}
