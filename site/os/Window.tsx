import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import clsx from "clsx";
import { Minus, Plus, X, type LucideIcon } from "lucide-react";
import type { AppId } from "./ids";
import { APPS, AppIcon } from "./registry";

/** An open window, in desktop coordinates (below the menu bar). */
export interface Win {
  id: AppId;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  max: boolean;
  /** Minimized to the dock: hidden, but still mounted, so the app keeps its state. */
  min?: boolean;
  /** Playing its closing animation; removed right after. */
  closing?: boolean;
  /** Where the window shrinks to when minimized: its dock icon, relative to the window's centre. */
  minTo?: { x: number; y: number };
  /** Entrance delay in ms (the first windows arrive one after the other). */
  delay?: number;
}

export type Area = { w: number; h: number; usable: number };

const MIN_W = 360;
const MIN_H = 260;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** Where a window is drawn: its own rect, or the whole desktop when zoomed. */
export function displayRect(win: Win, area: Area) {
  return win.max ? { x: 8, y: 8, w: area.w - 16, h: area.usable - 16 } : { x: win.x, y: win.y, w: win.w, h: win.h };
}

/**
 * Lets a pointer drag an element by a handle, reporting new positions kept inside the desktop
 * (at least part of the element always stays reachable).
 */
export function useDrag(
  position: { x: number; y: number; w: number },
  area: Area,
  onMove: (x: number, y: number) => void,
  onStart?: () => void,
) {
  const offset = useRef<{ dx: number; dy: number } | null>(null);
  return {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
      onStart?.();
      offset.current = { dx: event.clientX - position.x, dy: event.clientY - position.y };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      if (!offset.current) return;
      onMove(
        clamp(event.clientX - offset.current.dx, 96 - position.w, area.w - 96),
        clamp(event.clientY - offset.current.dy, 0, area.h - 48),
      );
    },
    onPointerUp() {
      offset.current = null;
    },
    onPointerCancel() {
      offset.current = null;
    },
  };
}

/** Resizing from the right edge, the bottom edge or the corner. */
function useResize(win: Win, area: Area, onResize: (w: number, h: number) => void) {
  const start = useRef<{ x: number; y: number; w: number; h: number; dx: boolean; dy: boolean } | null>(null);
  return (dx: boolean, dy: boolean) => ({
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.button !== 0) return;
      start.current = { x: event.clientX, y: event.clientY, w: win.w, h: win.h, dx, dy };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      const from = start.current;
      if (!from) return;
      onResize(
        from.dx ? clamp(from.w + event.clientX - from.x, MIN_W, area.w - win.x - 8) : from.w,
        from.dy ? clamp(from.h + event.clientY - from.y, MIN_H, area.h - win.y - 8) : from.h,
      );
    },
    onPointerUp() {
      start.current = null;
    },
    onPointerCancel() {
      start.current = null;
    },
  });
}

export function Window({
  win,
  active,
  area,
  onFocus,
  onClose,
  onMinimize,
  onMove,
  onResize,
  onToggleMax,
}: {
  win: Win;
  active: boolean;
  area: Area;
  onFocus: () => void;
  onClose: () => void;
  onMinimize: () => void;
  onMove: (x: number, y: number) => void;
  onResize: (w: number, h: number) => void;
  onToggleMax: () => void;
}) {
  const app = APPS[win.id];
  const rect = displayRect(win, area);
  const drag = useDrag(rect, area, onMove, onFocus);
  const resize = useResize(win, area, onResize);
  const hidden = win.min || win.closing;
  const { Body } = app;

  return (
    <section
      role="dialog"
      aria-label={app.title}
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
      data-min={win.min || undefined}
      data-closing={win.closing || undefined}
      onPointerDown={onFocus}
      style={
        {
          left: rect.x,
          top: rect.y,
          width: rect.w,
          height: rect.h,
          zIndex: win.z,
          animationDelay: win.delay ? `${win.delay}ms` : undefined,
          animationFillMode: win.closing ? "forwards" : "backwards",
          "--min-x": `${win.minTo?.x ?? 0}px`,
          "--min-y": `${win.minTo?.y ?? area.h}px`,
        } as CSSProperties
      }
      className={clsx(
        "window absolute flex flex-col overflow-hidden rounded-xl border",
        win.closing ? "animate-pop-out" : "animate-pop-in",
        app.dark && "dark",
        active ? "border-edge shadow-dialog" : "border-hairline shadow-popover",
      )}
    >
      <div
        {...(win.max ? {} : drag)}
        onDoubleClick={onToggleMax}
        className={clsx(
          "relative flex h-10 shrink-0 touch-none items-center border-b border-hairline px-3.5 select-none",
          !win.max && "cursor-grab active:cursor-grabbing",
        )}
      >
        <div className="group/lights relative z-[1] flex gap-2">
          <Light color="#ff5f57" active={active} label={`Close ${app.name}`} icon={X} onClick={onClose} />
          <Light color="#febc2e" active={active} label={`Minimize ${app.name}`} icon={Minus} onClick={onMinimize} />
          <Light color="#28c840" active={active} label={win.max ? `Restore ${app.name}` : `Zoom ${app.name}`} icon={Plus} onClick={onToggleMax} />
        </div>
        <p
          className={clsx(
            "pointer-events-none absolute inset-x-24 flex items-center justify-center gap-2 text-ui font-medium transition-colors",
            active ? "text-fg" : "text-fg-subtle",
          )}
        >
          <span className={clsx("shrink-0 transition-opacity", !active && "opacity-60")}>
            <AppIcon id={win.id} size={16} />
          </span>
          <span className="truncate">{app.title}</span>
        </p>
      </div>
      <div data-window-body className="@container min-h-0 flex-1 overflow-auto">
        <Body />
      </div>
      {!win.max && (
        <>
          <span aria-hidden="true" {...resize(true, false)} className="absolute top-10 right-0 bottom-3 w-1.5 cursor-ew-resize touch-none" />
          <span aria-hidden="true" {...resize(false, true)} className="absolute right-3 bottom-0 left-0 h-1.5 cursor-ns-resize touch-none" />
          <span aria-hidden="true" {...resize(true, true)} className="absolute right-0 bottom-0 size-3.5 cursor-nwse-resize touch-none" />
        </>
      )}
    </section>
  );
}

/** One of the three title-bar lights: grey on an inactive window, coloured on hover; its glyph shows on hover. */
function Light({
  color,
  active,
  label,
  icon: Icon,
  onClick,
}: {
  color: string;
  active: boolean;
  label: string;
  icon: LucideIcon;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{ "--light": color } as CSSProperties}
      className={clsx(
        "grid size-3 place-items-center rounded-full text-black/60 focus-visible:outline-offset-1",
        active ? "bg-(--light)" : "light-off group-hover/lights:bg-(--light)",
      )}
    >
      <Icon className="size-2 opacity-0 group-hover/lights:opacity-100" strokeWidth={3} />
    </button>
  );
}
