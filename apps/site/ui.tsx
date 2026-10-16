import { useEffect, useState } from "react";
import clsx from "clsx";
import { Moon, Sun } from "lucide-react";
import { setThemePreference, useResolvedTheme } from "../web/src/lib/theme";

export function ThemeToggle({ className }: { className?: string }) {
  const theme = useResolvedTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setThemePreference(next)}
      aria-label={`Switch to ${next} mode`}
      className={clsx(
        "grid place-items-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg",
        className ?? "size-7",
      )}
    >
      {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

/** True when the visitor asked for less motion (loops then hold their final frame). */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

/** The current time, refreshed every 20 seconds (menu bar and status bar clocks). */
export function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 20_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Pill buttons used inside the apps. */
export function pillClass(variant: "primary" | "secondary" = "secondary") {
  return clsx(
    "inline-flex h-9 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium whitespace-nowrap transition-colors [&_svg]:size-4",
    variant === "primary"
      ? "bg-fg text-canvas hover:bg-fg/90"
      : "border border-edge bg-fill-subtle text-fg hover:border-edge-strong hover:bg-hover",
  );
}
