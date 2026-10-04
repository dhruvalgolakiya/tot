import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import clsx from "clsx";
import { BatteryFull, Search, Signal, Wifi } from "lucide-react";
import { Readme } from "../apps/Readme";
import { StickyNote } from "../apps/Rules";
import { TotApp } from "../apps/TotApp";
import { ThemeToggle, useClock } from "../ui";
import { OsContext } from "./context";
import type { AppId } from "./ids";
import { Launcher, useLauncherActions } from "./Launcher";
import { Notifications } from "./Notifications";
import { APPS, AppIcon } from "./registry";

const GRID: AppId[] = ["features", "maker", "calendar", "brains", "help", "rules", "trash", "readme"];
const DOCK: AppId[] = ["tot", "features", "terminal", "roadmap"];

const isAppId = (value: string): value is AppId => Object.hasOwn(APPS, value);

/** Tot's phone: the landing page on narrow screens. Apps open as sheets. */
export function Phone() {
  const [sheet, setSheet] = useState<AppId | null>(null);
  const [searching, setSearching] = useState(false);
  const open = useCallback((id: AppId) => {
    setSheet(id);
    history.replaceState(null, "", `#${id}`);
  }, []);
  const closeSheet = useCallback(() => {
    setSheet(null);
    history.replaceState(null, "", location.pathname + location.search);
  }, []);
  const search = useCallback(() => setSearching(true), []);
  const os = useMemo(() => ({ open, search, layout: "phone" as const }), [open, search]);
  const actions = useLauncherActions({});

  useEffect(() => {
    document.body.style.overflow = sheet ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [sheet]);

  // Deep links: tot.dev/#roadmap opens the Roadmap sheet.
  useEffect(() => {
    const fromHash = () => {
      const id = decodeURIComponent(location.hash.slice(1));
      if (isAppId(id)) setSheet(id);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  return (
    <OsContext.Provider value={os}>
      <div className="wallpaper min-h-dvh pb-32">
        <StatusBar onSearch={search} />
        <div className="space-y-4 px-3 pt-1">
          <section className="glass overflow-hidden rounded-[28px] border border-edge shadow-popover">
            <Readme />
          </section>
          <section className="glass overflow-hidden rounded-[28px] border border-edge shadow-popover">
            <div className="flex items-center gap-2 px-4 pt-3 pb-2 text-xs text-fg-subtle">
              <AppIcon id="tot" size={16} /> TOT · live
            </div>
            <div className="h-110 border-t border-hairline">
              <TotApp />
            </div>
          </section>
          <section aria-label="Apps" className="grid grid-cols-4 gap-x-2 gap-y-5 px-2 pt-3">
            {GRID.map((id) => (
              <button key={id} type="button" onClick={() => open(id)} className="flex flex-col items-center gap-1.5 rounded-2xl">
                <AppIcon id={id} size={58} />
                <span className="desktop-label max-w-full truncate text-xs font-medium text-fg">{APPS[id].name}</span>
              </button>
            ))}
          </section>
          <div className="flex justify-center pt-4 pb-2">
            <StickyNote className="-rotate-2" />
          </div>
          <p className="pb-4 text-center text-xs text-fg-subtle">Made with an unreasonable number of mascots.</p>
        </div>

        <nav aria-label="Dock" className="fixed inset-x-3 bottom-3 z-[100]">
          <div className="glass grid grid-cols-4 rounded-[30px] border border-edge px-3 py-3 shadow-dialog">
            {DOCK.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => open(id)}
                aria-label={APPS[id].name}
                className="flex justify-center rounded-2xl"
              >
                <AppIcon id={id} size={56} />
              </button>
            ))}
          </div>
        </nav>

        <div className="fixed inset-x-3 top-12 z-[150] flex justify-center">
          <Notifications className="w-full max-w-sm" firstDelay={9000} />
        </div>

        {sheet && <Sheet key={sheet} id={sheet} onClose={closeSheet} />}
        <Launcher open={searching} onOpenChange={setSearching} openApp={open} actions={actions} phone />
      </div>
    </OsContext.Provider>
  );
}

/** The phone's status bar: clear at the top of the page, frosted once content scrolls under it. */
function StatusBar({ onSearch }: { onSearch: () => void }) {
  const now = useClock();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 4);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  return (
    <div
      className={clsx(
        "sticky top-0 z-[90] flex h-11 items-center gap-1.5 border-b pr-2.5 pl-6 text-sm font-semibold text-fg transition-colors",
        scrolled ? "glass border-hairline" : "border-transparent",
      )}
    >
      <span className="tabular-nums">
        {now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/, "")}
      </span>
      <span className="ml-auto text-xs font-medium text-fg-muted">TOT</span>
      <Signal className="size-4" />
      <Wifi className="size-4" />
      <BatteryFull className="size-5" />
      <button
        type="button"
        onClick={onSearch}
        aria-label="Search Tot's phone"
        className="ml-1 grid size-8 place-items-center rounded-full text-fg-muted transition-colors hover:bg-hover hover:text-fg"
      >
        <Search className="size-4" />
      </button>
      <ThemeToggle className="size-8" />
    </div>
  );
}

/** How far down a sheet has to be dragged before letting go closes it. */
const DISMISS_PX = 110;

/** An app as a page sheet: slides up, closes with Done, Esc, or a drag down on its header. */
function Sheet({ id, onClose }: { id: AppId; onClose: () => void }) {
  const app = APPS[id];
  const { Body } = app;
  const [leaving, setLeaving] = useState(false);
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);

  const dismiss = useCallback(() => {
    setLeaving(true);
    setTimeout(onClose, 200);
  }, [onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && !event.defaultPrevented && dismiss();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

  const handle = {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if ((event.target as HTMLElement).closest("button")) return;
      start.current = event.clientY;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      if (start.current !== null) setDrag(Math.max(0, event.clientY - start.current));
    },
    onPointerUp() {
      if (start.current === null) return;
      start.current = null;
      if (drag > DISMISS_PX) dismiss();
      else setDrag(0);
    },
    onPointerCancel() {
      start.current = null;
      setDrag(0);
    },
  };

  return (
    <div className="fixed inset-0 z-[200]">
      <div
        aria-hidden="true"
        onClick={dismiss}
        className={clsx("absolute inset-0 bg-scrim/40", leaving ? "animate-fade-out [animation-fill-mode:forwards]" : "animate-fade-in")}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={app.title}
        style={{
          transform: drag && !leaving ? `translateY(${drag}px)` : undefined,
          transition: start.current === null ? "transform 200ms var(--ease-emphasized)" : "none",
        }}
        className={clsx(
          "absolute inset-x-0 top-3 bottom-0 flex flex-col overflow-hidden rounded-t-[22px] bg-canvas shadow-dialog",
          leaving ? "sheet-out" : "sheet-in",
          app.dark && "dark",
        )}
      >
        <div {...handle} className="shrink-0 touch-none border-b border-hairline select-none">
          <div className="flex justify-center pt-2">
            <span className="h-1 w-9 rounded-full bg-fill-strong" />
          </div>
          <div className="flex h-12 items-center gap-3 pr-3 pl-4">
            <AppIcon id={id} size={26} />
            <p className="min-w-0 flex-1 truncate text-heading text-fg-strong">{app.title}</p>
            <button
              type="button"
              onClick={dismiss}
              className="h-8 rounded-full bg-fill px-3.5 text-sm font-medium text-fg transition-colors hover:bg-fill-strong"
            >
              Done
            </button>
          </div>
        </div>
        <div className={clsx("@container min-h-0 flex-1 overflow-y-auto", id === "tot" && "flex flex-col")}>
          {id === "tot" ? (
            <div className="min-h-0 flex-1">
              <Body />
            </div>
          ) : (
            <Body />
          )}
        </div>
      </div>
    </div>
  );
}
