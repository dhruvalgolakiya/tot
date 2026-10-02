import { useEffect, useRef, type ReactNode } from "react";
import clsx from "clsx";
import { X } from "lucide-react";
import { useMediaQuery, WIDE_QUERY } from "../../hooks/useMediaQuery";
import { IconButton } from "./IconButton";

interface SidePanelProps {
  label: string;
  icon: ReactNode;
  title: ReactNode;
  onClose: () => void;
  /** Tailwind width class, e.g. `w-[380px]`. */
  width?: string;
  children: ReactNode;
}

/**
 * Right-hand panel (computer, agent settings). Docked as a card next to the
 * chat on wide screens, a sliding overlay otherwise. Escape closes it while
 * focus is inside it (or nowhere in particular).
 */
export function SidePanel({ label, icon, title, onClose, width = "w-[380px]", children }: SidePanelProps) {
  const wide = useMediaQuery(WIDE_QUERY);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const focused = document.activeElement;
      if (focused === document.body || panelRef.current?.contains(focused)) closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      {!wide && (
        <div aria-hidden="true" onClick={onClose} className="fixed inset-0 z-30 animate-fade-in bg-scrim/60 backdrop-blur-[2px]" />
      )}
      <aside
        ref={panelRef}
        aria-label={label}
        className={clsx(
          "flex max-w-full shrink-0 animate-slide-in-right flex-col",
          width,
          wide
            ? "my-2 mr-2 overflow-hidden rounded-lg border border-white/[0.06] bg-canvas"
            : "fixed inset-y-0 right-0 z-40 h-full border-l border-white/[0.06] bg-panel shadow-2xl shadow-shade/80",
        )}
      >
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-white/[0.06] pr-2 pl-4">
          <span className="grid shrink-0 place-items-center text-zinc-400 [&_svg]:size-4">{icon}</span>
          <h2 className="min-w-0 truncate text-sm font-semibold text-zinc-100">{title}</h2>
          <IconButton label={`Close ${label.toLowerCase()} panel`} className="ml-auto" onClick={onClose}>
            <X />
          </IconButton>
        </header>
        {children}
      </aside>
    </>
  );
}
