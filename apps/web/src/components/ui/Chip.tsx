import type { ComponentProps, ReactNode } from "react";
import clsx from "clsx";

export type ChipTone = "neutral" | "success" | "warning" | "danger";

const TONES: Record<ChipTone, string> = {
  neutral: "text-fg-muted",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

type ChipProps = ComponentProps<"span"> & {
  /** A leading 10px icon (lucide), e.g. a lock on a read-only brain. */
  icon?: ReactNode;
  /** Text color only; the outline stays neutral. Status colors carry status, never decoration. */
  tone?: ChipTone;
};

/**
 * A small outlined pill for tags, as on the landing page: a brain, a repo, a type, a schedule. Quieter than a
 * `Badge` (no fill); use a Badge for a status that must stand out.
 */
export function Chip({ icon, tone = "neutral", className, children, ...props }: ChipProps) {
  return (
    <span
      className={clsx(
        "inline-flex h-5 max-w-full shrink-0 items-center gap-1 rounded-full border border-edge px-2 text-2xs whitespace-nowrap [&_svg]:size-2.5 [&_svg]:shrink-0",
        TONES[tone],
        className,
      )}
      {...props}
    >
      {icon}
      {typeof children === "string" ? <span className="truncate">{children}</span> : children}
    </span>
  );
}
