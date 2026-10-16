import type { ReactNode } from "react";
import clsx from "clsx";

type SettingRowProps = {
  title: ReactNode;
  description?: ReactNode;
  /** The control on the right (usually a Switch). */
  control: ReactNode;
  htmlFor?: string;
  className?: string;
};

/** The setting-row pattern (DESIGN.md): title + description on the left, one control on the right. */
export function SettingRow({ title, description, control, htmlFor, className }: SettingRowProps) {
  return (
    <div className={clsx("flex items-start justify-between gap-4 py-3", className)}>
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-sm font-medium text-fg">
          {title}
        </label>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">{description}</p>}
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
}
