import type { ReactNode } from "react";
import clsx from "clsx";

type EmptyStateProps = {
  /** A lucide icon, shown in a 40px tile. */
  icon?: ReactNode;
  /** Anything else to show above the text instead of an icon, e.g. a <Mascot>. */
  media?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  /** One button (usually primary or secondary, size sm). */
  action?: ReactNode;
  /** dashed = a bordered box (empty list inside a page); plain = just centered content. */
  variant?: "plain" | "dashed";
  /** sm = compact (sidebar, panels), md = default (pages, dialogs). */
  size?: "sm" | "md";
  className?: string;
};

/** Nothing to show yet (or nothing matched): what this area is for, and the one action that fills it. */
export function EmptyState({
  icon,
  media,
  title,
  description,
  action,
  variant = "plain",
  size = "md",
  className,
}: EmptyStateProps) {
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
      {icon && (
        <div className="mb-1 grid size-10 place-items-center rounded-xl bg-fill text-fg-muted [&_svg]:size-5">{icon}</div>
      )}
      {title && <p className={clsx("font-medium text-fg", size === "sm" ? "text-ui" : "text-sm")}>{title}</p>}
      {description && (
        <p className={clsx("max-w-sm text-fg-subtle", size === "sm" ? "text-xs leading-relaxed" : "text-sm leading-relaxed")}>
          {description}
        </p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
