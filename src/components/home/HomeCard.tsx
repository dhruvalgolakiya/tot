import { useId, type ComponentType, type MouseEventHandler, type ReactNode } from "react";
import clsx from "clsx";

/**
 * Home's cards (the app's live ones and the public site's demo): a quiet title row with a count, then rows.
 * Shared so the site shows exactly what the app looks like.
 */
export function HomeCard({
  icon: Icon,
  title,
  count,
  action,
  children,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={clsx("flex min-w-0 flex-col rounded-xl border border-hairline bg-fill-subtle", className)}>
      <header className="flex h-10 shrink-0 items-center gap-2 px-3.5">
        <Icon className="size-3.5 shrink-0 text-fg-subtle" />
        <h2 id={id} className="text-xs font-medium text-fg-muted">
          {title}
        </h2>
        {count !== undefined && <span className="text-2xs text-fg-subtle tabular-nums">{count}</span>}
        {action && <div className="ml-auto flex items-center">{action}</div>}
      </header>
      <div className="flex min-h-0 flex-1 flex-col px-1.5 pb-2">{children}</div>
    </section>
  );
}

/** A small label over a group of rows ("Needs you · 2"), amber when it's waiting on the user. */
export function HomeCardGroup({ label, count, tone = "neutral" }: { label: string; count?: number; tone?: "neutral" | "warning" }) {
  return (
    <p className={clsx("px-2 pt-1.5 pb-0.5 text-2xs font-medium", tone === "warning" ? "text-warning" : "text-fg-subtle")}>
      {label}
      {count !== undefined && <span className="tabular-nums"> · {count}</span>}
    </p>
  );
}

/** One row: an icon or avatar, a title with an optional detail line under it, and something on the right. */
export function HomeItem({
  leading,
  title,
  detail,
  mono = false,
  trailing,
  href,
  onClick,
}: {
  leading: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  /** The detail is a command or a log line. */
  mono?: boolean;
  trailing?: ReactNode;
  href?: string;
  /** With `href`, a link's click (call preventDefault to route in-app); without it, the row is a button. */
  onClick?: MouseEventHandler<HTMLElement>;
}) {
  const body = (
    <>
      <span className="grid size-5 shrink-0 place-items-center">{leading}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui text-fg">{title}</span>
        {detail && <span className={clsx("truncate text-fg-subtle", mono ? "font-mono text-2xs" : "text-xs")}>{detail}</span>}
      </span>
      {trailing && <span className="flex shrink-0 items-center gap-2 text-xs text-fg-subtle tabular-nums">{trailing}</span>}
    </>
  );
  const className = "flex min-h-10 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left";
  const interactive = clsx(className, "transition-colors hover:bg-hover focus-visible:-outline-offset-2");
  if (href)
    return (
      <a href={href} onClick={onClick} className={interactive}>
        {body}
      </a>
    );
  if (onClick)
    return (
      <button type="button" onClick={onClick} className={interactive}>
        {body}
      </button>
    );
  return <div className={className}>{body}</div>;
}

/** "+3 more" (or another label) at the bottom of a card that shows only its first few rows: a link, or a button. */
export function HomeMore({ label, href, onClick }: { label: string; href?: string; onClick?: MouseEventHandler<HTMLElement> }) {
  const className = "mt-0.5 flex h-7 w-fit items-center rounded-lg px-2 text-xs text-fg-subtle transition-colors hover:bg-hover hover:text-fg-muted";
  return href ? (
    <a href={href} onClick={onClick} className={className}>
      {label}
    </a>
  ) : (
    <button type="button" onClick={onClick} className={className}>
      {label}
    </button>
  );
}
