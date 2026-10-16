import type { ReactNode } from "react";
import clsx from "clsx";

type FieldProps = {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  /** Validation message; replaces the hint while set. Also set `aria-invalid` on the control. */
  error?: ReactNode;
  className?: string;
  children: ReactNode;
};

/** Label + control + optional hint (or error), stacked. */
export function Field({ label, htmlFor, hint, error, className, children }: FieldProps) {
  return (
    <div className={clsx("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-fg">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs leading-relaxed text-danger">{error}</p>
      ) : (
        hint && <p className="text-xs leading-relaxed text-fg-subtle">{hint}</p>
      )}
    </div>
  );
}
