import type { ReactNode } from "react";

type SettingRowProps = {
  title: ReactNode;
  description?: ReactNode;
  /** The control on the right (usually a Switch). */
  control: ReactNode;
  htmlFor?: string;
};

export function SettingRow({ title, description, control, htmlFor }: SettingRowProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-sm font-medium text-zinc-200">
          {title}
        </label>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{description}</p>}
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
}
