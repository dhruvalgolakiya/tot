import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import clsx from "clsx";
import { Folder } from "lucide-react";
import { StickyNote } from "../apps/Rules";
import { ThemeToggle, useClock } from "../ui";
import { OsContext, useOs } from "./context";
import type { AppId } from "./ids";
import { Notifications } from "./Notifications";
import { ClaudeMark, OpenAIMark } from "./BrandMarks";
import { APPS, AppIcon } from "./registry";
import { useDrag, Window, type Area, type Win } from "./Window";

const MENU_H = 32;
/** Room kept free for the dock at the bottom when windows open. */
const DOCK_SPACE = 96;

const DOCK: AppId[] = ["tot", "features", "maker", "calendar", "brains", "terminal", "roadmap", "help"];

function measure(): Area {
  const h = window.innerHeight - MENU_H;
  return { w: window.innerWidth, h, usable: h - DOCK_SPACE };
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** The README and the live TOT chat, side by side when there's room, overlapping when there isn't. */
function firstWindows(area: Area): Win[] {
  const readme: Win = {
    id: "readme",
    x: Math.max(24, Math.round(area.w * 0.045)),
    y: 24,
    w: Math.min(APPS.readme.size.w, area.w - 48),
    h: Math.min(APPS.readme.size.h, area.usable - 32),
    z: 12,
    max: false,
  };
  const right = readme.x + readme.w + 32;
  const w = clamp(area.w - right - 112, 620, APPS.tot.size.w);
  const tot: Win = {
    id: "tot",
    x: Math.max(24, Math.min(right, area.w - w - 112)),
    y: 56,
    w: Math.min(w, area.w - 48),
    h: Math.min(APPS.tot.size.h, area.usable - 72),
    z: 11,
    max: false,
  };
  return [tot, readme];
}

/** Where a newly opened window goes: near the middle, stepping down-right so windows don't stack exactly. */
function placeNew(id: AppId, count: number, area: Area): Omit<Win, "z"> {
  const w = Math.min(APPS[id].size.w, area.w - 48);
  const h = Math.min(APPS[id].size.h, area.usable - 32);
  const step = (count % 5) * 28;
  return {
    id,
    w,
    h,
    x: clamp(Math.round((area.w - w) / 2) - 56 + step, 8, area.w - w - 8),
    y: clamp(28 + step, 8, Math.max(8, area.usable - h)),
    max: false,
  };
}

/** Tot's computer: the landing page on screens wide enough for windows. */
export function Desktop() {
  const [area, setArea] = useState(measure);
  const areaRef = useRef(area);
  areaRef.current = area;
  const [wins, setWins] = useState<Win[]>(() => firstWindows(measure()));
  const top = useRef(20);

  useEffect(() => {
    const update = () => setArea(measure());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const open = useCallback((id: AppId) => {
    const z = ++top.current;
    setWins((current) => {
      if (current.some((win) => win.id === id)) return current.map((win) => (win.id === id ? { ...win, z } : win));
      return [...current, { ...placeNew(id, current.length, areaRef.current), z }];
    });
  }, []);
  const focus = useCallback((id: AppId) => {
    setWins((current) => {
      const highest = Math.max(...current.map((win) => win.z));
      if (current.find((win) => win.id === id)?.z === highest) return current;
      const z = ++top.current;
      return current.map((win) => (win.id === id ? { ...win, z } : win));
    });
  }, []);
  const close = (id: AppId) => setWins((current) => current.filter((win) => win.id !== id));
  const update = (id: AppId, patch: Partial<Win>) =>
    setWins((current) => current.map((win) => (win.id === id ? { ...win, ...patch } : win)));

  const activeId = wins.length ? wins.reduce((a, b) => (a.z > b.z ? a : b)).id : null;
  const os = useMemo(() => ({ open, layout: "desktop" as const }), [open]);

  return (
    <OsContext.Provider value={os}>
      <div className="wallpaper fixed inset-0 overflow-hidden">
        <MenuBar />
        <main className="absolute inset-x-0 bottom-0" style={{ top: MENU_H }}>
          <p
            aria-hidden="true"
            className="watermark pointer-events-none absolute -bottom-[4vw] right-[2vw] font-display leading-none font-bold select-none"
          >
            tot
          </p>
          <DesktopIcons />
          {wins.map((win) => (
            <Window
              key={win.id}
              win={win}
              area={area}
              active={win.id === activeId}
              onFocus={() => focus(win.id)}
              onClose={() => close(win.id)}
              onMove={(x, y) => update(win.id, { x, y })}
              onToggleMax={() => update(win.id, { max: !win.max })}
            />
          ))}
          <DraggableNote area={area} />
        </main>
        <Dock open={(id) => open(id)} openIds={wins.map((win) => win.id)} />
        <div className="fixed right-3 z-[10001]" style={{ top: MENU_H + 10 }}>
          <Notifications />
        </div>
      </div>
    </OsContext.Provider>
  );
}

function MenuBar() {
  const now = useClock();
  const { open } = useOs();
  return (
    <header
      className="glass fixed inset-x-0 top-0 z-[10000] flex items-center gap-1 border-b border-hairline px-3 text-ui"
      style={{ height: MENU_H }}
    >
      <img src="/tot.svg" alt="" className="size-4.5 rounded" />
      <span className="ml-1.5 mr-3 font-semibold text-fg">TOT</span>
      <span className="hidden px-2 text-fg-muted lg:inline">File</span>
      <span className="hidden px-2 text-fg-muted lg:inline">Edit</span>
      <button
        type="button"
        onClick={() => open("maker")}
        className="rounded-md px-2 py-0.5 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
      >
        Agents
      </button>
      <button
        type="button"
        onClick={() => open("roadmap")}
        className="rounded-md px-2 py-0.5 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
      >
        Roadmap
      </button>
      <button
        type="button"
        onClick={() => open("help")}
        className="rounded-md px-2 py-0.5 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
      >
        Help
      </button>
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => open("brains")}
          aria-label="Open Brains: Claude and ChatGPT usage"
          className="hidden items-center gap-2 rounded-md px-2 py-0.5 text-fg-muted transition-colors hover:bg-hover hover:text-fg md:flex"
        >
          <Meter mark={<ClaudeMark className="size-3.5" />} used={92} />
          <Meter mark={<OpenAIMark className="size-3.5 text-fg" />} used={34} />
        </button>
        <ThemeToggle className="size-6" />
        <span className="px-1 text-fg tabular-nums">
          {now.toLocaleString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
        <button
          type="button"
          onClick={() => open("terminal")}
          className="h-6 rounded-full bg-fg px-3 text-xs font-medium text-canvas transition-colors hover:bg-fg/90"
        >
          Get TOT
        </button>
      </div>
    </header>
  );
}

/** A provider's mark and how much of this week's usage is gone. */
function Meter({ mark, used }: { mark: ReactNode; used: number }) {
  return (
    <span className="flex items-center gap-1.5">
      {mark}
      <span className="h-1.5 w-7 overflow-hidden rounded-full bg-fill-strong">
        <span className={clsx("block h-full rounded-full", used > 80 ? "bg-amber-400" : "bg-emerald-400")} style={{ width: `${used}%` }} />
      </span>
    </span>
  );
}

function DesktopIcons() {
  const { open } = useOs();
  return (
    <div className="absolute top-36 right-3 z-[2] flex flex-col gap-3">
      <DesktopIcon label="README.md" onOpen={() => open("readme")}>
        <AppIcon id="readme" size={46} />
      </DesktopIcon>
      <DesktopIcon label="Roadmap.md" onOpen={() => open("roadmap")}>
        <AppIcon id="readme" size={46} />
      </DesktopIcon>
      <DesktopIcon label="Tot's stuff" onOpen={() => open("features")}>
        <Folder className="size-12 fill-[#7dd3fc] text-[#38bdf8]" strokeWidth={1.25} />
      </DesktopIcon>
    </div>
  );
}

function DesktopIcon({ label, onOpen, children }: { label: string; onOpen: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onOpen} className="group flex w-20 flex-col items-center gap-1 rounded-lg p-1.5">
      <span className="grid h-12 place-items-center">{children}</span>
      <span className="desktop-label rounded px-1.5 text-xs font-medium text-fg group-hover:bg-accent group-hover:text-fixed-white">
        {label}
      </span>
    </button>
  );
}

/**
 * The house rules, stuck on the screen like a sticky note on a monitor. It sits below the README; where the
 * screen is too short for both, it peeks up from the bottom edge and slides into view on hover. It can be dragged.
 */
function DraggableNote({ area }: { area: Area }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(320);
  const [spot, setSpot] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const note = ref.current;
    if (!note) return;
    const observer = new ResizeObserver(() => setHeight(note.offsetHeight));
    observer.observe(note);
    return () => observer.disconnect();
  }, []);

  const readme = firstWindows(area).find((win) => win.id === "readme")!;
  const home = { x: readme.x + 8, y: Math.max(readme.y + readme.h + 20, area.h - height - 16) };
  const position = spot ?? home;
  // How far the note hangs off the bottom of the screen (and so how far it rises on hover).
  const lift = spot ? 0 : Math.max(0, position.y + height + 16 - area.h);
  const drag = useDrag({ ...position, w: 240 }, area, (x, y) => setSpot({ x, y }));
  return (
    <div
      {...drag}
      ref={ref}
      aria-label="House rules (sticky note)"
      style={{ left: position.x, top: position.y, "--lift": `${lift}px` } as CSSProperties}
      className="absolute z-[9000] -rotate-3 cursor-grab touch-none transition-[translate] duration-300 ease-emphasized select-none hover:translate-y-[calc(var(--lift)*-1)] active:cursor-grabbing"
    >
      <StickyNote />
    </div>
  );
}

function Dock({ open, openIds }: { open: (id: AppId) => void; openIds: AppId[] }) {
  return (
    <nav aria-label="Dock" className="fixed inset-x-0 bottom-3 z-[10000] flex justify-center">
      <div className="glass flex items-center gap-2 rounded-[24px] border border-edge p-2 shadow-dialog">
        {DOCK.map((id) => (
          <DockItem key={id} id={id} open={open} running={openIds.includes(id)} />
        ))}
        <span aria-hidden="true" className="mx-0.5 h-8 w-px bg-hairline" />
        <DockItem id="trash" open={open} running={openIds.includes("trash")} />
      </div>
    </nav>
  );
}

/** A dock icon: its name floats above on hover, and a small dot below marks an open window. */
function DockItem({ id, open, running }: { id: AppId; open: (id: AppId) => void; running: boolean }) {
  return (
    <button type="button" onClick={() => open(id)} aria-label={APPS[id].name} className="group relative rounded-[12px]">
      <span className="pointer-events-none absolute -top-11 left-1/2 -translate-x-1/2 rounded-lg border border-edge bg-elevated px-2.5 py-1 text-xs font-medium whitespace-nowrap text-fg opacity-0 shadow-popover transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        {APPS[id].name}
      </span>
      <span className="block transition-transform duration-200 ease-emphasized group-hover:-translate-y-1 group-active:scale-95">
        <AppIcon id={id} size={46} />
      </span>
      <span
        aria-hidden="true"
        className={clsx(
          "absolute -bottom-1.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-fg-subtle transition-opacity",
          running ? "opacity-100" : "opacity-0",
        )}
      />
    </button>
  );
}
