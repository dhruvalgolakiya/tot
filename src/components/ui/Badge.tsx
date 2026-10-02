import type { ComponentProps } from "react";
import clsx from "clsx";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-fill text-fg-muted",
  accent: "bg-accent-soft text-accent-text",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

type BadgeProps = ComponentProps<"span"> & {
  tone?: BadgeTone;
  /** A leading status dot in the badge's color. */
  dot?: boolean;
};

/** A small, non-interactive label: status ("Connected"), type ("stdio"), state ("Paused", "default"). */
export function Badge({ tone = "neutral", dot = false, className, children, ...props }: BadgeProps) {
  return (
    <span
      className={clsx(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-2xs font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
      {...props}
    >
      {dot && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />}
      {children}
    </span>
  );
}
