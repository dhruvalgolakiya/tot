import type { ReactNode } from "react";
import clsx from "clsx";

type PageHeaderProps = {
  title?: ReactNode;
  /** One plain lede line under the title (it may wrap); counts, a shortcut. */
  description?: ReactNode;
  /** Right-aligned controls: one button, a select, or an IconButton menu. Keep it to one visible action. */
  action?: ReactNode;
  className?: string;
};

/**
 * Top of a page's content column, the landing page's way: a big, tight title and one plain muted lede line under it,
 * with at most one control on the right (it wraps under the text on phones).
 */
export function PageHeader({ title, description, action, className }: PageHeaderProps) {
  return (
    <div className={clsx("flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="min-w-0 flex-1 basis-72">
        {title && <h1 className="font-display text-2xl font-semibold tracking-tight text-balance text-fg-strong">{title}</h1>}
        {description && <div className={clsx("max-w-2xl text-sm text-pretty text-fg-muted", title && "mt-1.5")}>{description}</div>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2 max-sm:w-full">{action}</div>}
    </div>
  );
}
