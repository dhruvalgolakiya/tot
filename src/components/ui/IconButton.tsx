import type { ComponentProps } from "react";
import clsx from "clsx";

type IconButtonProps = ComponentProps<"button"> & {
  /** Accessible name (icon-only buttons have no visible text). */
  label: string;
  size?: "sm" | "md";
};

export function IconButton({ label, size = "md", className, ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/[0.07] hover:text-zinc-100 disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "size-7 [&_svg]:size-3.5" : "size-9 [&_svg]:size-[18px]",
        className,
      )}
      {...props}
    />
  );
}
