import type { ReactNode } from "react";
import clsx from "clsx";
import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";

export type CalloutTone = "info" | "success" | "warning" | "danger";

const TONES: Record<CalloutTone, string> = {
  info: "border-hairline bg-fill-subtle text-fg-muted",
  success: "border-success-edge bg-success-soft text-success",
  warning: "border-warning-edge bg-warning-soft text-warning",
  danger: "border-danger-edge bg-danger-soft text-danger",
};

const ICONS: Record<CalloutTone, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
};

type CalloutProps = {
  tone?: CalloutTone;
  /** A trailing inline action, e.g. <button className="link-muted">Retry</button>. */
  action?: ReactNode;
  className?: string;
  children: ReactNode;
};

/**
 * An inline message box: errors next to the thing that failed, warnings about a setting, a short note.
 * Danger callouts are announced to screen readers when they appear.
 */
export function Callout({ tone = "info", action, className, children }: CalloutProps) {
  const Icon = ICONS[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      className={clsx("flex items-start gap-2 rounded-lg border px-3 py-2 text-ui", TONES[tone], className)}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
