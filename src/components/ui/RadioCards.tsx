import type { ReactNode } from "react";
import clsx from "clsx";
import { RadioGroup } from "radix-ui";

export type RadioCardOption<T extends string> = {
  value: T;
  label: ReactNode;
  description?: ReactNode;
};

type RadioCardsProps<T extends string> = {
  value: T;
  onValueChange: (value: T) => void;
  options: RadioCardOption<T>[];
  label: string;
  className?: string;
};

/** A radio group rendered as selectable cards with a one-line explanation each. */
export function RadioCards<T extends string>({ value, onValueChange, options, label, className }: RadioCardsProps<T>) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(next) => onValueChange(next as T)}
      aria-label={label}
      className={clsx("grid gap-2", className)}
    >
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          className="group flex w-full items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-3 text-left transition-colors outline-none hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-[var(--agent-accent-ring)] data-[state=checked]:border-[var(--agent-accent-border)] data-[state=checked]:bg-[var(--agent-accent-08)]"
        >
          <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-zinc-600 group-data-[state=checked]:border-[var(--agent-accent)]">
            <RadioGroup.Indicator className="size-2 rounded-full bg-[var(--agent-accent)]" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-zinc-100">{option.label}</span>
            {option.description && (
              <span className="mt-0.5 block text-xs leading-relaxed text-zinc-400">{option.description}</span>
            )}
          </span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
