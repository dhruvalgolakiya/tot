import { useId, type MouseEventHandler, type ReactNode } from "react";
import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import { StatusDot } from "./StatusDot";

/**
 * The ledger, as on the landing page and Home: dense rows (icon · title · sub-line · right meta) grouped into labelled
 * sections with counts. Two ways to show it:
 *
 * - bare (`Ledger`): a column of sections, each label in a narrow margin on the left (Home, the site's demo);
 * - framed (`LedgerPanel`): one bordered, rounded panel with an optional `LedgerHeader` row, its sections stacked
 *   (`layout="stacked"`), or a list of `LedgerField`s (settings: label and help on the left, control on the right).
 *
 * No colored bar down any side: status lives in a dot, an icon or a chip.
 */

export function Ledger({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("flex flex-col", className)}>{children}</div>;
}

type LedgerPanelProps = {
  /** A `LedgerHeader`, shown as the panel's top row. */
  header?: ReactNode;
  children: ReactNode;
  /**
   * rows (default): a little padding around the body, so rows' hover fills sit inside the border (sections, rows);
   * fields: no padding, each child is a full-width `LedgerField` separated by hairlines.
   */
  body?: "rows" | "fields";
  className?: string;
  /** Labels the panel as a region (when it has no header to name it). */
  "aria-label"?: string;
};

/** One bordered, rounded panel: an optional header row, then sections, rows or fields. */
export function LedgerPanel({ header, children, body = "rows", className, ...props }: LedgerPanelProps) {
  return (
    <div className={clsx("min-w-0 overflow-hidden rounded-2xl border border-hairline", className)} {...props}>
      {header}
      <div className={clsx("flex min-w-0 flex-col", body === "rows" ? "p-1.5 sm:p-2" : "[&>*+*]:border-t [&>*+*]:border-hairline")}>{children}</div>
    </div>
  );
}

/** The panel's header row: a title, one muted line beside it, and up to two controls on the right. */
export function LedgerHeader({ title, meta, action, className }: { title: ReactNode; meta?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex min-h-12 min-w-0 items-center gap-3 border-b border-hairline px-4 py-2", className)}>
      <span className="shrink-0 text-sm font-medium text-fg">{title}</span>
      {meta && <span className="min-w-0 truncate text-xs text-fg-subtle tabular-nums">{meta}</span>}
      {action && <span className="ml-auto flex shrink-0 items-center gap-2">{action}</span>}
    </div>
  );
}

type LedgerSectionProps = {
  label: ReactNode;
  count?: number;
  /** "warning" (Needs you) gets an amber dot and label. */
  tone?: "neutral" | "warning";
  /** margin (default): the label in a narrow left margin on wide screens (bare ledgers); stacked: the label above the rows (panels). */
  layout?: "margin" | "stacked";
  /** Stacked only: one muted line under the label. */
  description?: ReactNode;
  /** Stacked only: a small control at the label's right (an IconButton, a quiet link). */
  action?: ReactNode;
  /** Stacked only: with `onToggle`, the label is a button that folds the section; `collapsed` hides its rows. */
  collapsed?: boolean;
  onToggle?: () => void;
  /** The label's heading level: h2 (default) on a page, h3 inside a tab or a panel under another heading. */
  as?: "h2" | "h3";
  children?: ReactNode;
  className?: string;
};

/** A labelled group of rows, with its count. */
export function LedgerSection({
  label,
  count,
  tone = "neutral",
  layout = "margin",
  description,
  action,
  collapsed = false,
  onToggle,
  as: Heading = "h2",
  children,
  className,
}: LedgerSectionProps) {
  const id = useId();
  const labelClass = clsx("flex items-center gap-2 text-xs font-medium", tone === "warning" ? "text-warning" : "text-fg-subtle");
  const labelBody = (
    <>
      {tone === "warning" && <StatusDot tone="amber" />}
      {label}
      {count !== undefined && <span className={clsx("text-fg-faint tabular-nums", layout === "stacked" && "font-normal")}>{count}</span>}
    </>
  );

  if (layout === "margin") {
    return (
      <section aria-labelledby={id} className={clsx("grid gap-x-4 border-t border-hairline py-2 first:border-t-0 sm:grid-cols-[7.5rem_minmax(0,1fr)]", className)}>
        <Heading id={id} className={clsx(labelClass, "h-9 px-2 sm:px-0")}>
          {labelBody}
        </Heading>
        <div className="flex min-w-0 flex-col">{children}</div>
      </section>
    );
  }

  return (
    <section aria-labelledby={id} className={clsx("border-t border-hairline py-1.5 first:border-t-0 first:pt-0 last:pb-0", className)}>
      <div className="flex min-h-8 items-center gap-2 px-2">
        <Heading id={id} className={labelClass}>
          {onToggle ? (
            <button
              type="button"
              aria-expanded={!collapsed}
              onClick={onToggle}
              className="-ml-1 flex h-7 items-center gap-1.5 rounded-md px-1 transition-colors hover:bg-hover hover:text-fg-muted"
            >
              <ChevronRight className={clsx("size-3.5 transition-transform", !collapsed && "rotate-90")} />
              {labelBody}
            </button>
          ) : (
            labelBody
          )}
        </Heading>
        {action && <span className="ml-auto flex shrink-0 items-center gap-1">{action}</span>}
      </div>
      {description && <p className="-mt-1 mb-1 px-2 text-xs leading-relaxed text-fg-subtle">{description}</p>}
      {!collapsed && children !== undefined && <div className="flex min-w-0 flex-col">{children}</div>}
    </section>
  );
}

/** The classes of a ledger row, for rows with their own children (several links, a menu): 36px+, 8px radius, hover fill when interactive. */
export function ledgerRowClass({ interactive = false, className }: { interactive?: boolean; className?: string } = {}) {
  return clsx(
    "flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left",
    interactive && "transition-colors hover:bg-hover focus-visible:-outline-offset-2",
    className,
  );
}

type LedgerRowProps = {
  leading?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  /** The detail is a command or a log line. */
  mono?: boolean;
  /** inline (default): the detail beside the title (under it on phones); stacked: always under it, the landing's two-line row. */
  layout?: "inline" | "stacked";
  trailing?: ReactNode;
  href?: string;
  /** With `href`, a link's click (call preventDefault to route in-app); without it, the row is a button. */
  onClick?: MouseEventHandler<HTMLElement>;
  className?: string;
};

/** One row: an icon or avatar, a title with its detail, and something on the right. */
export function LedgerRow({ leading, title, detail, mono = false, layout = "inline", trailing, href, onClick, className }: LedgerRowProps) {
  const stacked = layout === "stacked";
  const body = (
    <>
      {leading !== undefined && <span className="grid size-5 shrink-0 place-items-center self-center">{leading}</span>}
      <span className={clsx("flex min-w-0 flex-1 flex-col", !stacked && "sm:flex-row sm:items-baseline sm:gap-2.5")}>
        <span className={clsx("truncate text-ui text-fg", !stacked && "sm:max-w-[60%] sm:shrink-0")}>{title}</span>
        {detail && <span className={clsx("min-w-0 truncate text-fg-subtle", mono ? "font-mono text-2xs" : "text-xs")}>{detail}</span>}
      </span>
      {trailing && <span className="flex shrink-0 items-center gap-2 text-xs text-fg-subtle tabular-nums">{trailing}</span>}
    </>
  );
  if (href)
    return (
      <a href={href} onClick={onClick} className={ledgerRowClass({ interactive: true, className })}>
        {body}
      </a>
    );
  if (onClick)
    return (
      <button type="button" onClick={onClick} className={ledgerRowClass({ interactive: true, className })}>
        {body}
      </button>
    );
  return <div className={ledgerRowClass({ className })}>{body}</div>;
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

type LedgerFieldProps = {
  title: ReactNode;
  description?: ReactNode;
  /** The control on the right (a Switch, a Select, a button); with `stacked`, under the text at full width. */
  control?: ReactNode;
  /** For a text field or a textarea: the control under the label, full width. */
  stacked?: boolean;
  htmlFor?: string;
  /** Anything under the row (an expanded form, a hint); spans the full width. */
  children?: ReactNode;
  className?: string;
};

/** A settings row in a `LedgerPanel body="fields"`: label and help text on the left, the control on the right. */
export function LedgerField({ title, description, control, stacked = false, htmlFor, children, className }: LedgerFieldProps) {
  return (
    <div className={clsx("px-4 py-3.5", className)}>
      <div className={clsx(stacked ? "space-y-2.5" : "flex flex-wrap items-start justify-between gap-x-6 gap-y-2.5")}>
        <div className={clsx("min-w-0", !stacked && "flex-1 basis-56")}>
          <label htmlFor={htmlFor} className="block text-sm font-medium text-fg">
            {title}
          </label>
          {description && <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">{description}</p>}
        </div>
        {control && <div className={clsx(stacked ? "min-w-0" : "flex max-w-full shrink-0 items-center gap-2 pt-0.5")}>{control}</div>}
      </div>
      {children}
    </div>
  );
}

type LedgerGroupProps = {
  /** A short label above the panel ("Appearance", "This computer"). */
  title?: ReactNode;
  /** For a list: how many rows it has, after the label. */
  count?: number;
  /** One muted line under the label. */
  description?: ReactNode;
  /** One small control at the label's right (an "Add" button, a menu). */
  action?: ReactNode;
  /** A `LedgerHeader` inside the panel, instead of (or as well as) the label above it. */
  header?: ReactNode;
  /** fields (default): `LedgerField`s separated by hairlines; rows: ledger rows and sections. */
  body?: "fields" | "rows";
  children: ReactNode;
  className?: string;
};

/** A titled settings group: a small label (and its action) above one `LedgerPanel`. Stack groups with `space-y-8`. */
export function LedgerGroup({ title, count, description, action, header, body = "fields", children, className }: LedgerGroupProps) {
  const id = useId();
  return (
    <section aria-labelledby={title ? id : undefined} className={clsx("min-w-0", className)}>
      {(title || action) && (
        <div className="mb-2 flex min-h-7 items-center justify-between gap-4 px-1">
          <div className="min-w-0">
            {title && (
              <h2 id={id} className="flex items-baseline gap-2 text-ui font-medium text-fg">
                {title}
                {count !== undefined && <span className="text-xs font-normal text-fg-subtle tabular-nums">{count}</span>}
              </h2>
            )}
            {description && <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">{description}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </div>
      )}
      <LedgerPanel header={header} body={body}>
        {children}
      </LedgerPanel>
    </section>
  );
}
