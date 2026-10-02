import type { ComponentProps, ReactNode } from "react";
import clsx from "clsx";

type ListRowStyle = {
  /** The current item (open chat, active settings section, open wiki page). */
  selected?: boolean;
  /** md = 36px (primary nav: chats, settings sections), sm = 32px (trees, pickers, compact lists). */
  size?: "sm" | "md";
  className?: string;
};

/**
 * A navigation/list row: 13px text, muted until hovered or selected. Use `listRowClass()` on your own
 * <a>/<button>/<div> when the row needs custom children (e.g. a hover menu button positioned inside it).
 */
export function listRowClass({ selected = false, size = "md", className }: ListRowStyle = {}) {
  return clsx(
    "group/row relative flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-ui transition-colors",
    "focus-visible:-outline-offset-2",
    size === "sm" ? "h-8" : "h-9",
    selected ? "bg-selected text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
    className,
  );
}

type ListRowProps = ComponentProps<"button"> &
  Omit<ListRowStyle, "className"> & {
    /** Leading 16px icon. */
    icon?: ReactNode;
    /** Trailing meta (count, kbd, status dot). */
    trailing?: ReactNode;
  };

/** A clickable row: icon, truncated label, trailing meta. Set `aria-current="page"` yourself for nav. */
export function ListRow({ selected, size, icon, trailing, className, children, ...props }: ListRowProps) {
  return (
    <button type="button" className={listRowClass({ selected, size, className })} {...props}>
      {icon && (
        <span
          className={clsx(
            "grid shrink-0 place-items-center transition-colors [&_svg]:size-4",
            selected ? "text-fg" : "text-fg-subtle group-hover/row:text-fg-muted",
          )}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing && <span className="flex shrink-0 items-center gap-1.5 text-xs text-fg-subtle">{trailing}</span>}
    </button>
  );
}
