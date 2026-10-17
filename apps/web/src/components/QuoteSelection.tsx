import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { TextQuote } from "lucide-react";
import { putInComposer } from "../lib/composerInbox";

/** Where the button goes: centered over the selection, just above it (below, when that's off the top of the list). */
type Spot = { x: number; y: number; below: boolean };

/** The selection's text and spot when it lies within one reply in `root` (the list); null otherwise. */
function quotable(root: HTMLElement): { text: string; spot: Spot } | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const reply = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest("[data-reply]");
  const from = reply(selection.anchorNode);
  if (!from || from !== reply(selection.focusNode) || !root.contains(from)) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  const top = root.getBoundingClientRect().top;
  const below = rect.top - 44 < top;
  return { text, spot: { x: rect.left + rect.width / 2, y: below ? rect.bottom + 8 : rect.top - 8, below } };
}

/**
 * Selecting text in a reply shows a small "Quote" button over it; clicking it puts the selection into the message box
 * as a markdown quote, with the cursor under it. One listener for the whole list (`root`).
 */
export function QuoteSelection({ root, scroller }: { root: RefObject<HTMLElement | null>; scroller: RefObject<HTMLElement | null> }) {
  const [found, setFound] = useState<{ text: string; spot: Spot } | null>(null);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let selecting = false;
    const check = () => setFound(selecting ? null : quotable(element));
    const onDown = () => {
      selecting = true;
      setFound(null);
    };
    const onUp = () => {
      selecting = false;
      // After the click that ends the selection has settled it.
      requestAnimationFrame(check);
    };
    // A selection made with the keyboard, or one that went away (a click elsewhere, Esc).
    const onChange = () => {
      if (!selecting) requestAnimationFrame(check);
    };
    element.addEventListener("pointerdown", onDown);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("selectionchange", onChange);
    const scroll = scroller.current;
    scroll?.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    return () => {
      element.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("selectionchange", onChange);
      scroll?.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, [root, scroller]);

  if (!found) return null;
  return createPortal(
    <button
      type="button"
      // Keeps the selection while the button is pressed.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        putInComposer({ kind: "quote", text: found.text });
        window.getSelection()?.removeAllRanges();
        setFound(null);
      }}
      style={{ left: found.spot.x, top: found.spot.y }}
      className={clsx(
        "fixed z-40 inline-flex h-7 -translate-x-1/2 animate-fade-in items-center gap-1.5 rounded-full border border-edge bg-elevated px-2.5 text-xs font-medium text-fg shadow-popover transition-colors hover:bg-hover",
        !found.spot.below && "-translate-y-full",
      )}
    >
      <TextQuote className="size-3.5 text-fg-muted" />
      Quote
    </button>,
    document.body,
  );
}
