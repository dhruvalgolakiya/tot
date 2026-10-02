import type { ComponentProps, ReactNode } from "react";
import clsx from "clsx";
import { Search } from "lucide-react";

type SearchInputProps = Omit<ComponentProps<"input">, "type"> & {
  /** 32px tall with a 13px font (sidebars, trees, dialogs) instead of 36px. */
  compact?: boolean;
  /** Right-aligned hint inside the field, e.g. <Kbd keys={["mod", "K"]} />. */
  trailing?: ReactNode;
  /** Classes for the wrapper (width, margins). `className` styles the <input>. */
  containerClassName?: string;
};

/** `.input` with a leading search icon. A plain text input: Esc and clearing behave as the caller decides. */
export function SearchInput({ compact = false, trailing, containerClassName, className, ...props }: SearchInputProps) {
  return (
    <div className={clsx("relative", containerClassName)}>
      <Search
        aria-hidden="true"
        className={clsx(
          "pointer-events-none absolute top-1/2 -translate-y-1/2 text-fg-subtle",
          compact ? "left-2.5 size-3.5" : "left-3 size-4",
        )}
      />
      <input
        type="text"
        autoComplete="off"
        {...props}
        className={clsx("input", compact ? "input-sm pl-8" : "pl-9", trailing !== undefined && "pr-14", className)}
      />
      {trailing !== undefined && (
        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">{trailing}</span>
      )}
    </div>
  );
}
