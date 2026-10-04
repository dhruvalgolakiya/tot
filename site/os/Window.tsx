import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import clsx from "clsx";
import { Minus, Plus, X, type LucideIcon } from "lucide-react";
import type { AppId } from "./ids";
import { APPS } from "./registry";

/** An open window, in desktop coordinates (below the menu bar). */
export interface Win {
  id: AppId;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  max: boolean;
}

export type Area = { w: number; h: number; usable: number };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

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

export function Window({
  win,
  active,
  area,
  onFocus,
  onClose,
  onMove,
  onToggleMax,
}: {
  win: Win;
  active: boolean;
  area: Area;
  onFocus: () => void;
  onClose: () => void;
  onMove: (x: number, y: number) => void;
  onToggleMax: () => void;
}) {
  const app = APPS[win.id];
  const rect = win.max ? { x: 8, y: 8, w: area.w - 16, h: area.usable - 16 } : win;
  const drag = useDrag(rect, area, onMove, onFocus);
  const { Body } = app;

  return (
    <section
      role="dialog"
      aria-label={app.title}
      onPointerDown={onFocus}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: win.z }}
      className={clsx(
        "window absolute flex animate-pop-in flex-col overflow-hidden rounded-xl border",
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
        <div className="group/lights flex gap-2">
          <Light color="#ff5f57" label={`Close ${app.name}`} icon={X} onClick={onClose} />
          <Light color="#febc2e" label={`Minimize ${app.name}`} icon={Minus} onClick={onClose} />
          <Light color="#28c840" label={win.max ? `Restore ${app.name}` : `Zoom ${app.name}`} icon={Plus} onClick={onToggleMax} />
        </div>
        <p
          className={clsx(
            "pointer-events-none absolute inset-x-24 truncate text-center text-ui font-medium",
            active ? "text-fg" : "text-fg-subtle",
          )}
        >
          {app.title}
        </p>
      </div>
      <div className="@container min-h-0 flex-1 overflow-auto">
        <Body />
      </div>
    </section>
  );
}

/** One of the three title-bar lights; its glyph shows while the pointer is over the group. */
function Light({ color, label, icon: Icon, onClick }: { color: string; label: string; icon: LucideIcon; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{ backgroundColor: color }}
      className="grid size-3 place-items-center rounded-full text-black/60 focus-visible:outline-offset-1"
    >
      <Icon className="size-2 opacity-0 group-hover/lights:opacity-100" strokeWidth={3} />
    </button>
  );
}
