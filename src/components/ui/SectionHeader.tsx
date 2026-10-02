import type { ReactNode } from "react";
import clsx from "clsx";

type HeaderProps = {
  title?: ReactNode;
  description?: ReactNode;
  /** Right-aligned controls: one button, or an IconButton menu. Keep it to one visible action. */
  action?: ReactNode;
  className?: string;
};

/** Top of a page's content column: 20px title, one-line muted description, optional action. */
export function PageHeader({ title, description, action, className }: HeaderProps) {
  return (
    <div className={clsx("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        {title && <h1 className="text-title text-fg-strong">{title}</h1>}
        {description && <p className={clsx("text-sm text-fg-muted", title && "mt-1")}>{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

type SectionHeaderProps = HeaderProps & {
  /** Heading level; h2 under a page title, h3 inside a card or panel. */
  as?: "h2" | "h3";
};

/** A titled group inside a page, panel or dialog: 14px semibold title, 12px description, optional action. */
export function SectionHeader({ title, description, action, as: Heading = "h2", className }: SectionHeaderProps) {
  return (
    <div className={clsx("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        {title && <Heading className="text-sm font-semibold text-fg">{title}</Heading>}
        {description && <p className={clsx("text-xs leading-relaxed text-fg-subtle", title && "mt-0.5")}>{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}
