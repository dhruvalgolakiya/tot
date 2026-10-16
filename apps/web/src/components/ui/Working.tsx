import { CircleAlert, LoaderCircle } from "lucide-react";
import clsx from "clsx";

/**
 * Sidebar and list status, instead of colored dots: a small grey spinner while something works (a chat replying, a
 * project's tasks running), and an amber alert when it needs the user. The label is its tooltip and accessible name.
 */
export function Working({ label, className }: { label: string; className?: string }) {
  return (
    <span role="img" aria-label={label} title={label} className={clsx("grid size-4 shrink-0 place-items-center", className)}>
      <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin text-fg-subtle" />
    </span>
  );
}

export function NeedsYou({ label, className }: { label: string; className?: string }) {
  return (
    <span role="img" aria-label={label} title={label} className={clsx("grid size-4 shrink-0 place-items-center", className)}>
      <CircleAlert aria-hidden="true" className="size-3.5 text-warning" />
    </span>
  );
}
