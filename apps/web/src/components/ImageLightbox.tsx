import { useEffect, useRef, useState, type PointerEvent } from "react";
import clsx from "clsx";
import { Dialog } from "radix-ui";
import { ExternalLink, Minus, Plus, X } from "lucide-react";
import { IconButton } from "./ui/IconButton";
import { Tip } from "./ui/Tip";

const MAX_SCALE = 8;
const STEP = 1.5;

type View = { scale: number; x: number; y: number };
const FIT: View = { scale: 1, x: 0, y: 0 };

/**
 * An image from a chat, full screen: it opens fitted, zooms with the wheel or a pinch (around the pointer), the
 * buttons or +, − and 0, and on a double click; drag to look around once it's zoomed in. Esc or a click beside it closes.
 */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [view, setView] = useState<View>(FIT);
  const [dragging, setDragging] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; y: number } | null>(null);

  /** Zoom to `scale`, keeping the point under (clientX, clientY) where it is (the middle when none). */
  function zoomTo(scale: number, clientX?: number, clientY?: number) {
    const rect = stage.current?.getBoundingClientRect();
    setView((current) => {
      const next = Math.min(MAX_SCALE, Math.max(1, scale));
      if (next === 1 || !rect) return FIT;
      const px = (clientX ?? rect.left + rect.width / 2) - (rect.left + rect.width / 2);
      const py = (clientY ?? rect.top + rect.height / 2) - (rect.top + rect.height / 2);
      const k = next / current.scale;
      return { scale: next, x: px - (px - current.x) * k, y: py - (py - current.y) * k };
    });
  }
  const zoomBy = (factor: number, clientX?: number, clientY?: number) => zoomTo(view.scale * factor, clientX, clientY);

  // The wheel zooms (a trackpad pinch arrives as a wheel with ctrlKey); it must be able to stop the page scrolling.
  const scaleRef = useRef(view.scale);
  scaleRef.current = view.scale;
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0025));
      zoomTo(scaleRef.current * factor, event.clientX, event.clientY);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  function onPointerDown(event: PointerEvent) {
    if (view.scale === 1 || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, x: event.clientX - view.x, y: event.clientY - view.y };
    setDragging(true);
  }
  function onPointerMove(event: PointerEvent) {
    const from = drag.current;
    if (!from || from.pointer !== event.pointerId) return;
    setView((current) => ({ ...current, x: event.clientX - from.x, y: event.clientY - from.y }));
  }
  function onPointerUp() {
    drag.current = null;
    setDragging(false);
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-fixed-black/90 backdrop-blur-sm data-[state=open]:animate-fade-in" />
        <Dialog.Content
          ref={content}
          aria-describedby={undefined}
          // The image has the focus, not the first button (whose tooltip would then take the first Esc).
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            content.current?.focus();
          }}
          onKeyDown={(event) => {
            if (event.key === "+" || event.key === "=") zoomBy(STEP);
            else if (event.key === "-") zoomBy(1 / STEP);
            else if (event.key === "0") setView(FIT);
          }}
          className="dark fixed inset-0 z-50 flex flex-col outline-none data-[state=open]:animate-fade-in"
        >
          <Dialog.Title className="sr-only">{alt || "Image"}</Dialog.Title>
          <div className="flex h-14 shrink-0 items-center gap-1 px-4">
            <p className="min-w-0 flex-1 truncate text-sm text-fg-muted">{alt}</p>
            <Tip content="Zoom out">
              <IconButton label="Zoom out" onClick={() => zoomBy(1 / STEP)} disabled={view.scale === 1}>
                <Minus />
              </IconButton>
            </Tip>
            <Tip content="Fit to screen">
              <button
                type="button"
                onClick={() => setView(FIT)}
                className="h-9 min-w-14 rounded-full px-2 text-xs text-fg-muted tabular-nums transition-colors hover:bg-hover hover:text-fg"
              >
                {Math.round(view.scale * 100)}%
              </button>
            </Tip>
            <Tip content="Zoom in">
              <IconButton label="Zoom in" onClick={() => zoomBy(STEP)} disabled={view.scale === MAX_SCALE}>
                <Plus />
              </IconButton>
            </Tip>
            <Tip content="Open the original">
              <a
                href={src}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open the original"
                className="grid size-9 place-items-center rounded-full text-fg-muted transition-colors hover:bg-hover hover:text-fg"
              >
                <ExternalLink className="size-4.5" />
              </a>
            </Tip>
            <Dialog.Close asChild>
              <IconButton label="Close">
                <X />
              </IconButton>
            </Dialog.Close>
          </div>
          <div
            ref={stage}
            onClick={(event) => event.target === event.currentTarget && onClose()}
            className="relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden px-8 pb-8"
          >
            <img
              src={src}
              alt={alt}
              draggable={false}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onDoubleClick={(event) => (view.scale > 1 ? setView(FIT) : zoomTo(2.5, event.clientX, event.clientY))}
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
              className={clsx(
                "max-h-full max-w-full select-none rounded-lg object-contain",
                !dragging && "transition-transform duration-150 ease-out",
                view.scale === 1 ? "cursor-zoom-in" : dragging ? "cursor-grabbing" : "cursor-grab",
              )}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
