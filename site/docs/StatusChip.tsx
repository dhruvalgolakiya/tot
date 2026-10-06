import clsx from "clsx";
import { STATUS_LABEL, type Status } from "./manifest";

const TONE: Record<Status, string> = {
  available: "bg-success-soft text-success",
  partly: "bg-warning-soft text-warning",
  "not-yet": "bg-fill text-fg-muted",
};

/** Available · Partly · Not yet: a small pill with a dot, the only place status colors show up. */
export function StatusChip({ status, label, className, size = "md" }: { status: Status; label?: string; className?: string; size?: "sm" | "md" }) {
  return (
    <span
      className={clsx(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full font-medium whitespace-nowrap",
        size === "sm" ? "h-5 px-2 text-2xs" : "h-6 px-2.5 text-xs",
        TONE[status],
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {label ?? STATUS_LABEL[status]}
    </span>
  );
}
