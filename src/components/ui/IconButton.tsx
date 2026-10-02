import type { ComponentProps } from "react";
import clsx from "clsx";

type IconButtonProps = ComponentProps<"button"> & {
  /** Accessible name (icon-only buttons have no visible text). Pair with <Tip> for a visible hint. */
  label: string;
  /** sm = 28px with a 14px icon (inline/hover actions in rows), md = 36px with an 18px icon (bars, toolbars). */
  size?: "sm" | "md";
};

/**
 * Icon-only ghost button. Shows a selected background while pressed (`aria-pressed`) or while a
 * Radix menu it triggers is open (`data-state="open"`).
 */
export function IconButton({ label, size = "md", className, ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center text-fg-muted transition-colors [&_svg]:shrink-0",
        "hover:bg-hover hover:text-fg active:bg-selected",
        "aria-pressed:bg-selected aria-pressed:text-fg data-[state=open]:bg-selected data-[state=open]:text-fg",
        "disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "size-7 rounded-md [&_svg]:size-3.5" : "size-9 rounded-lg [&_svg]:size-4.5",
        className,
      )}
      {...props}
    />
  );
}
