import type { ReactNode } from "react";

type FieldProps = {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
};

/** Label + control + optional hint, stacked. */
export function Field({ label, htmlFor, hint, children }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-zinc-200">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-zinc-500">{hint}</p>}
    </div>
  );
}
