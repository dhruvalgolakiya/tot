import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { Moon, Sun } from "lucide-react";
import { setThemePreference, useResolvedTheme } from "../src/lib/theme";

/** Fades its children up once, the first time they scroll into view. */
export function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setShown(true);
        observer.disconnect();
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} data-shown={shown ? "" : undefined} className={clsx("reveal", className)} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

/** A page section: an anchor, the shared gutters and width. */
export function Section({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  return (
    <section id={id} className={clsx("px-4 py-20 sm:px-6 sm:py-28", className)}>
      <div className="mx-auto max-w-6xl">{children}</div>
    </section>
  );
}

/** A section's eyebrow, title and intro line. */
export function Heading({ eyebrow, title, intro, center = false }: { eyebrow: string; title: ReactNode; intro?: ReactNode; center?: boolean }) {
  return (
    <Reveal className={clsx("mb-12 max-w-2xl sm:mb-16", center && "mx-auto text-center")}>
      <p className="mb-3 text-ui font-medium text-fg-subtle">{eyebrow}</p>
      <h2 className="font-display text-4xl font-semibold tracking-tight text-balance text-fg-strong sm:text-5xl">{title}</h2>
      {intro && <p className="mt-4 text-lg leading-relaxed text-pretty text-fg-muted">{intro}</p>}
    </Reveal>
  );
}

export function ThemeToggle() {
  const theme = useResolvedTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setThemePreference(next)}
      aria-label={`Switch to ${next} mode`}
      className="grid size-9 place-items-center rounded-full text-fg-muted transition-colors hover:bg-hover hover:text-fg"
    >
      {theme === "dark" ? <Sun className="size-4.5" /> : <Moon className="size-4.5" />}
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

/** The big pill buttons of the hero and the closing call to action. */
export function ctaClass(variant: "primary" | "secondary") {
  return clsx(
    "inline-flex h-11 items-center justify-center gap-2 rounded-full px-6 text-base font-medium whitespace-nowrap transition-colors [&_svg]:size-4",
    variant === "primary" ? "bg-fg text-canvas hover:bg-fg/90" : "border border-edge bg-fill-subtle text-fg hover:border-edge-strong hover:bg-hover",
  );
}
