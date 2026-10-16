import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import clsx from "clsx";
import { Folder } from "lucide-react";
import { StickyNote } from "../apps/Rules";
import { OsContext, useOs } from "./context";
import type { AppId } from "./ids";
import { Launcher, useLauncherActions } from "./Launcher";
import { MenuBar } from "./MenuBar";
import { Notifications } from "./Notifications";
import { APPS, AppIcon } from "./registry";
import { displayRect, useDrag, Window, type Area, type Win } from "./Window";

const MENU_H = 32;
/** Room kept free for the dock at the bottom when windows open. */
const DOCK_SPACE = 96;
/** The desktop icons' column on the right, which windows leave alone. */
const ICONS_W = 120;

const DOCK: AppId[] = ["tot", "features", "maker", "calendar", "brains", "terminal", "roadmap", "help"];

function measure(): Area {
  const h = window.innerHeight - MENU_H;
  return { w: window.innerWidth, h, usable: h - DOCK_SPACE };
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * The first impression: the README and the live TOT chat. Side by side (and centred) when they fit, with the
 * chat giving up width first, then the README; overlapping, README in front, on narrow screens.
 */
function firstWindows(area: Area): Win[] {
  const left = Math.max(24, Math.round(area.w * 0.045));
  const gap = 28;
  const room = area.w - left - ICONS_W - gap;
  let readmeX: number, readmeW: number, totX: number, totW: number;
  if (room >= 440 + 620) {
    totW = clamp(room - APPS.readme.size.w, 620, APPS.tot.size.w);
    readmeW = clamp(room - totW, 440, APPS.readme.size.w);
    readmeX = left + Math.round((room - totW - readmeW) / 2);
    totX = readmeX + readmeW + gap;
  } else {
    readmeW = 440;
    readmeX = left;
    totW = clamp(area.w - left - ICONS_W - 200, 520, 700);
    totX = area.w - ICONS_W - totW;
  }
  const readme: Win = {
    id: "readme",
    x: readmeX,
    y: 24,
    w: readmeW,
    // A narrower README wraps onto more lines.
    h: Math.min(readmeW < 500 ? 588 : APPS.readme.size.h, area.usable - 24),
    z: 12,
    max: false,
  };
  const tot: Win = { id: "tot", x: totX, y: 56, w: totW, h: Math.min(APPS.tot.size.h, area.usable - 72), z: 11, max: false, delay: 110 };
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
    x: clamp(Math.round((area.w - ICONS_W - w) / 2) + step, 8, area.w - w - 8),
    y: clamp(28 + step, 8, Math.max(8, area.usable - h)),
    max: false,
  };
}

/** Tidies the open windows: a grid when each gets a sensible cell, a neat cascade when not. Front window first. */
function arrange(wins: Win[], area: Area): Win[] {
  const visible = wins.filter((win) => !win.min && !win.closing).sort((a, b) => b.z - a.z);
  const n = visible.length;
  if (!n) return wins;
  const pad = 24;
  const gap = 20;
  const region = { x: pad, y: 16, w: area.w - pad - ICONS_W, h: area.usable - 24 };
  const cols = n <= 3 ? n : Math.ceil(n / 2);
  const rows = Math.ceil(n / cols);
  const cellW = (region.w - gap * (cols - 1)) / cols;
  const cellH = (region.h - gap * (rows - 1)) / rows;
  const tiled = cellW >= 400 && cellH >= 320;
  const placed = new Map<AppId, Partial<Win>>();
  visible.forEach((win, index) => {
    const size = APPS[win.id].size;
    if (tiled) {
      const col = index % cols;
      const row = Math.floor(index / cols);
      // A short last row sits centred under the full rows above it.
      const inRow = row === rows - 1 ? n - cols * (rows - 1) : cols;
      const shift = ((cols - inRow) * (cellW + gap)) / 2;
      const w = Math.round(Math.min(cellW, size.w + 120));
      const h = Math.round(Math.min(cellH, size.h + 80));
      placed.set(win.id, {
        x: Math.round(region.x + shift + col * (cellW + gap) + (cellW - w) / 2),
        y: Math.round(region.y + row * (cellH + gap) + (cellH - h) / 2),
        w,
        h,
        max: false,
      });
    } else {
      // Back to front, each one step down-right of the last.
      const step = (n - 1 - index) * 32;
      const w = Math.min(size.w, area.w - ICONS_W - 48 - (n - 1) * 32);
      const h = Math.min(size.h, area.usable - 24 - (n - 1) * 32);
      placed.set(win.id, { x: pad + step, y: 16 + step, w, h, max: false });
    }
  });
  return wins.map((win) => (placed.has(win.id) ? { ...win, ...placed.get(win.id) } : win));
}

/** The front window: the highest one that isn't minimized or closing. */
function frontOf(wins: Win[]): AppId | null {
  let best: Win | null = null;
  for (const win of wins) if (!win.min && !win.closing && (!best || win.z > best.z)) best = win;
  return best?.id ?? null;
}

const isAppId = (value: string): value is AppId => Object.hasOwn(APPS, value);

/** Tot's computer: the landing page on screens wide enough for windows. */
export function Desktop() {
  const [area, setArea] = useState(measure);
  const areaRef = useRef(area);
  areaRef.current = area;
  const [wins, setWins] = useState<Win[]>(() => firstWindows(measure()));
  const winsRef = useRef(wins);
  winsRef.current = wins;
  const top = useRef(20);
  const [searching, setSearching] = useState(false);
  // The sticky note shares the window stack: just under the first windows, on top once it's grabbed.
  const [noteZ, setNoteZ] = useState(10);
  // Only write the URL once the visitor has done something (the landing URL stays clean).
  const touched = useRef(false);

  useEffect(() => {
    const update = () => setArea(measure());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const update = useCallback(
    (id: AppId, patch: Partial<Win>) => setWins((current) => current.map((win) => (win.id === id ? { ...win, ...patch } : win))),
    [],
  );

  const open = useCallback((id: AppId) => {
    touched.current = true;
    const z = ++top.current;
    setWins((current) => {
      const existing = current.find((win) => win.id === id);
      if (existing && !existing.closing) return current.map((win) => (win.id === id ? { ...win, z, min: false, delay: 0 } : win));
      const rest = current.filter((win) => win.id !== id);
      const shown = rest.filter((win) => !win.min && !win.closing).length;
      return [...rest, { ...placeNew(id, shown, areaRef.current), z }];
    });
  }, []);

  const focus = useCallback((id: AppId) => {
    setWins((current) => {
      const highest = Math.max(...current.map((win) => win.z));
      if (current.find((win) => win.id === id)?.z === highest) return current;
      touched.current = true;
      const z = ++top.current;
      return current.map((win) => (win.id === id ? { ...win, z } : win));
    });
  }, []);

  const close = useCallback((id: AppId) => {
    touched.current = true;
    setWins((current) => current.map((win) => (win.id === id ? { ...win, closing: true } : win)));
    setTimeout(() => setWins((current) => current.filter((win) => !(win.id === id && win.closing))), 140);
  }, []);

  /** Shrinks a window into its dock icon (or the middle of the dock, for apps that aren't in it). */
  const minimize = useCallback(
    (id: AppId) => {
      const win = winsRef.current.find((item) => item.id === id);
      if (!win) return;
      touched.current = true;
      const rect = displayRect(win, areaRef.current);
      const icon = document.querySelector(`[data-dock-item="${id}"]`) ?? document.querySelector("[data-dock]");
      const box = icon?.getBoundingClientRect();
      const target = box
        ? { x: box.left + box.width / 2, y: box.top + box.height / 2 - MENU_H }
        : { x: areaRef.current.w / 2, y: areaRef.current.h };
      update(id, { min: true, minTo: { x: target.x - (rect.x + rect.w / 2), y: target.y - (rect.y + rect.h / 2) } });
    },
    [update],
  );

  const closeAll = useCallback(() => {
    for (const win of winsRef.current) if (!win.closing) close(win.id);
  }, [close]);
  const closeFront = useCallback(() => {
    const id = frontOf(winsRef.current);
    if (id) close(id);
  }, [close]);
  const tidy = useCallback(() => {
    touched.current = true;
    setWins((current) => arrange(current, areaRef.current));
  }, []);
  const search = useCallback(() => setSearching(true), []);

  // ⌘K / Ctrl+K opens the launcher; Esc closes the front window (menus and dialogs handle their own Esc first).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearching((current) => !current);
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if ((event.target as HTMLElement).closest?.("input, textarea, [contenteditable='true']")) return;
      closeFront();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeFront]);

  // Deep links: tot.dev/#roadmap opens the Roadmap on top of the first windows.
  useEffect(() => {
    const fromHash = () => {
      const id = decodeURIComponent(location.hash.slice(1));
      if (isAppId(id)) open(id);
    };
    const timer = setTimeout(fromHash, 320);
    window.addEventListener("hashchange", fromHash);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("hashchange", fromHash);
    };
  }, [open]);

  const activeId = frontOf(wins);
  useEffect(() => {
    if (!touched.current) return;
    const hash = activeId ? `#${activeId}` : "";
    if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname + location.search);
  }, [activeId]);

  const actions = useLauncherActions({ arrange: tidy, closeAll, hasWindows: activeId !== null });
  const os = useMemo(() => ({ open, search, layout: "desktop" as const }), [open, search]);

  return (
    <OsContext.Provider value={os}>
      <div className="wallpaper fixed inset-0 overflow-hidden">
        <MenuBar height={MENU_H} hasWindows={activeId !== null} onArrange={tidy} onCloseWindow={closeFront} onCloseAll={closeAll} />
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
              onMinimize={() => minimize(win.id)}
              onMove={(x, y) => update(win.id, { x, y })}
              onResize={(w, h) => update(win.id, { w, h })}
              onToggleMax={() => update(win.id, { max: !win.max })}
            />
          ))}
          <DraggableNote area={area} z={noteZ} onFocus={() => setNoteZ(++top.current)} />
        </main>
        <Dock open={open} openIds={wins.filter((win) => !win.closing).map((win) => win.id)} />
        <div className="fixed right-3 z-[10001]" style={{ top: MENU_H + 10 }}>
          <Notifications firstDelay={6000} />
        </div>
        <Launcher open={searching} onOpenChange={setSearching} openApp={open} actions={actions} />
      </div>
    </OsContext.Provider>
  );
}

function DesktopIcons() {
  const { open } = useOs();
  return (
    <div className="absolute top-36 right-3 z-[2] flex flex-col gap-3">
      <DesktopIcon label="README.md" delay={220} onOpen={() => open("readme")}>
        <AppIcon id="readme" size={46} />
      </DesktopIcon>
      <DesktopIcon label="Roadmap.md" delay={260} onOpen={() => open("roadmap")}>
        <AppIcon id="readme" size={46} />
      </DesktopIcon>
      <DesktopIcon label="Tot's stuff" delay={300} onOpen={() => open("features")}>
        <Folder className="size-12 fill-[#7dd3fc] text-[#38bdf8]" strokeWidth={1.25} />
      </DesktopIcon>
    </div>
  );
}

function DesktopIcon({ label, delay, onOpen, children }: { label: string; delay: number; onOpen: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{ animationDelay: `${delay}ms`, animationFillMode: "backwards" }}
      className="group flex w-20 animate-fade-in flex-col items-center gap-1 rounded-lg p-1.5"
    >
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
function DraggableNote({ area, z, onFocus }: { area: Area; z: number; onFocus: () => void }) {
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
  const drag = useDrag({ ...position, w: 240 }, area, (x, y) => setSpot({ x, y }), onFocus);
  return (
    <div
      {...drag}
      ref={ref}
      aria-label="House rules (sticky note)"
      style={{ left: position.x, top: position.y, zIndex: z, "--lift": `${lift}px` } as CSSProperties}
      className="absolute -rotate-3 cursor-grab touch-none transition-[translate] duration-300 ease-emphasized select-none hover:translate-y-[calc(var(--lift)*-1)] active:cursor-grabbing"
    >
      <StickyNote />
    </div>
  );
}

function Dock({ open, openIds }: { open: (id: AppId) => void; openIds: AppId[] }) {
  return (
    <nav aria-label="Dock" className="dock-in fixed inset-x-0 bottom-3 z-[10000] flex justify-center">
      <div data-dock className="glass flex items-center gap-2 rounded-[24px] border border-edge p-2 shadow-dialog">
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
    <button type="button" data-dock-item={id} onClick={() => open(id)} aria-label={APPS[id].name} className="group relative rounded-[12px]">
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
