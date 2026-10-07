import { useId, type MouseEventHandler, type ReactNode } from "react";
import clsx from "clsx";
import { StatusDot } from "../ui/StatusDot";

/**
 * Home's ledger (the app's live one and the public site's demo): one column of sections, each with its label in
 * a narrow margin on the left and its rows on the right, separated by hairlines. Shared so the site shows exactly
 * what the app looks like.
 */
export function Ledger({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("flex flex-col", className)}>{children}</div>;
}

/** A labelled group of rows; "warning" (Needs you) gets an amber dot and label. */
export function LedgerSection({
  label,
  count,
  tone = "neutral",
  children,
}: {
  label: string;
  count?: number;
  tone?: "neutral" | "warning";
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="grid gap-x-4 border-t border-hairline py-2 first:border-t-0 sm:grid-cols-[7.5rem_minmax(0,1fr)]"
    >
      <h2 id={id} className={clsx("flex h-9 items-center gap-2 px-2 text-xs font-medium sm:px-0", tone === "warning" ? "text-warning" : "text-fg-subtle")}>
        {tone === "warning" && <StatusDot tone="amber" />}
        {label}
        {count !== undefined && <span className="text-fg-faint tabular-nums">{count}</span>}
      </h2>
      <div className="flex min-w-0 flex-col">{children}</div>
    </section>
  );
}

/** One row: an icon or avatar, a title with its detail beside it (under it on phones), and something on the right. */
export function LedgerRow({
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
      <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-2.5">
        <span className="truncate text-ui text-fg sm:max-w-[60%] sm:shrink-0">{title}</span>
        {detail && <span className={clsx("min-w-0 truncate text-fg-subtle", mono ? "font-mono text-2xs" : "text-xs")}>{detail}</span>}
      </span>
      {trailing && <span className="flex shrink-0 items-center gap-2 text-xs text-fg-subtle tabular-nums">{trailing}</span>}
    </>
  );
  const className = "flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left";
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

/** "+3 more" (or another label) under a section that shows only its first few rows: a link, or a button. */
export function LedgerMore({ label, href, onClick }: { label: string; href?: string; onClick?: MouseEventHandler<HTMLElement> }) {
  const className = "flex h-7 w-fit items-center rounded-lg px-2 text-xs text-fg-subtle transition-colors hover:bg-hover hover:text-fg-muted";
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
