import type { ReactNode } from "react";
import clsx from "clsx";

type EmptyStateProps = {
  /** A lucide icon: shown in a 40px tile (plain, dashed), or small and muted at the row's start (quiet). */
  icon?: ReactNode;
  /** Anything else to show above the text instead of an icon, e.g. a <Mascot> (plain, dashed). */
  media?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  /** One button (usually secondary or ghost, size sm); at the right end of a quiet row. */
  action?: ReactNode;
  /**
   * quiet = one muted row or short line, left-aligned, no box: an empty list inside a ledger or a page section (the
   * default for lists); plain = centered content (a whole page or panel with nothing in it); dashed = legacy bordered
   * box, kept for compatibility (prefer quiet).
   */
  variant?: "quiet" | "plain" | "dashed";
  /** sm = compact (sidebar, panels), md = default (pages, dialogs). Quiet rows are one size. */
  size?: "sm" | "md";
  className?: string;
};

/** Nothing to show yet (or nothing matched): what this area is for, and the one action that fills it. */
export function EmptyState({ icon, media, title, description, action, variant = "plain", size = "md", className }: EmptyStateProps) {
  if (variant === "quiet") {
    return (
      <div className={clsx("flex min-h-9 min-w-0 items-center gap-2.5 px-2 py-1.5 text-left", className)}>
        {(icon || media) && <span className="grid size-5 shrink-0 place-items-center text-fg-subtle [&_svg]:size-4">{icon ?? media}</span>}
        <div className="min-w-0 flex-1">
          {title && <p className="text-ui text-fg-muted">{title}</p>}
          {description && <p className={clsx("text-xs leading-relaxed text-pretty text-fg-subtle", title && "mt-0.5")}>{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    );
  }
  return (
    <div
      className={clsx(
        "flex flex-col items-center text-center",
        size === "sm" ? "gap-1.5 px-4 py-6" : "gap-2 px-6 py-10",
        variant === "dashed" && "rounded-xl border border-dashed border-edge",
        className,
      )}
    >
      {media}
      {icon && <div className="mb-1 grid size-10 place-items-center rounded-xl bg-fill text-fg-muted [&_svg]:size-5">{icon}</div>}
      {title && <p className={clsx("font-medium text-fg", size === "sm" ? "text-ui" : "text-sm")}>{title}</p>}
      {description && <p className={clsx("max-w-sm text-fg-subtle", size === "sm" ? "text-xs leading-relaxed" : "text-sm leading-relaxed")}>{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
