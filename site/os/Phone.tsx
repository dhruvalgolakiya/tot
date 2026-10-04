import { useCallback, useEffect, useMemo, useState } from "react";
import { BatteryFull, ChevronDown, Signal, Wifi } from "lucide-react";
import { Readme } from "../apps/Readme";
import { StickyNote } from "../apps/Rules";
import { TotApp } from "../apps/TotApp";
import { ThemeToggle, useClock } from "../ui";
import { OsContext } from "./context";
import type { AppId } from "./ids";
import { Notifications } from "./Notifications";
import { APPS, AppIcon } from "./registry";

const GRID: AppId[] = ["features", "maker", "calendar", "brains", "help", "rules", "trash", "readme"];
const DOCK: AppId[] = ["tot", "features", "terminal", "roadmap"];

/** Tot's phone: the landing page on narrow screens. Apps open as full-screen sheets. */
export function Phone() {
  const [sheet, setSheet] = useState<AppId | null>(null);
  const open = useCallback((id: AppId) => setSheet(id), []);
  const os = useMemo(() => ({ open, layout: "phone" as const }), [open]);

  useEffect(() => {
    document.body.style.overflow = sheet ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [sheet]);

  return (
    <OsContext.Provider value={os}>
      <div className="wallpaper min-h-dvh pb-32">
        <StatusBar />
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
          <Notifications className="w-full max-w-sm" />
        </div>

        {sheet && <Sheet id={sheet} onClose={() => setSheet(null)} />}
      </div>
    </OsContext.Provider>
  );
}

function StatusBar() {
  const now = useClock();
  return (
    <div className="sticky top-0 z-[90] flex h-11 items-center gap-1.5 px-6 text-sm font-semibold text-fg">
      <span className="tabular-nums">
        {now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/, "")}
      </span>
      <span className="ml-auto text-xs font-medium text-fg-muted">TOT</span>
      <Signal className="size-4" />
      <Wifi className="size-4" />
      <BatteryFull className="size-5" />
      <ThemeToggle className="ml-1 size-7" />
    </div>
  );
}

/** An app, full screen, sliding up from the bottom. */
function Sheet({ id, onClose }: { id: AppId; onClose: () => void }) {
  const app = APPS[id];
  const { Body } = app;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={app.title}
      className={`sheet-in fixed inset-0 z-[200] flex flex-col bg-canvas ${app.dark ? "dark" : ""}`}
    >
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-hairline px-3">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid size-9 place-items-center rounded-full text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <ChevronDown className="size-5" />
        </button>
        <AppIcon id={id} size={24} />
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{app.title}</p>
        <button type="button" onClick={onClose} className="rounded-full px-3 py-1.5 text-sm font-medium text-accent-text">
          Done
        </button>
      </div>
      <div className={`@container min-h-0 flex-1 overflow-y-auto ${id === "tot" ? "flex flex-col" : ""}`}>
        {id === "tot" ? (
          <div className="min-h-0 flex-1">
            <Body />
          </div>
        ) : (
          <Body />
        )}
      </div>
    </div>
  );
}
