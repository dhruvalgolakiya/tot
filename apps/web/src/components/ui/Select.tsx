import { Fragment, type ReactNode } from "react";
import { Select as RadixSelect } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import clsx from "clsx";

export type SelectOption = {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
};

/** A labeled run of options, for an `<optgroup>`-style list (e.g. models grouped by provider). */
export type SelectOptionGroup = {
  label: ReactNode;
  options: SelectOption[];
};

type SelectEntry = SelectOption | SelectOptionGroup;

type SelectProps = {
  value: string;
  onValueChange: (value: string) => void;
  /** Plain options and groups can be mixed, e.g. ungrouped options first, then a couple of labeled groups. */
  options: SelectEntry[];
  placeholder?: ReactNode;
  /** sm = 32px (`.input-sm`), md = 36px (`.input`, the default). */
  size?: "sm" | "md";
  disabled?: boolean;
  id?: string;
  /** Renders a hidden native select for plain form submission (`FormData`), as Radix does for inputs. */
  name?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
};

/**
 * Radix reserves the empty string for "nothing selected" and won't let an Item use it as a value, but
 * several callers use "" (or map `null` to "") for "None" / "Me" / "Default". Map it to this internal
 * sentinel instead so callers can keep their existing value shapes unchanged.
 */
const EMPTY_VALUE = "__select-empty__";

function isGroup(entry: SelectEntry): entry is SelectOptionGroup {
  return "options" in entry;
}

function flattenOptions(options: SelectEntry[]): SelectOption[] {
  return options.flatMap((entry) => (isGroup(entry) ? entry.options : [entry]));
}

/**
 * Custom dropdown on top of Radix Select, styled like `.input` with the app's `.menu`/`.menu-item` popover
 * (see AgentMenu, ModelPicker). A drop-in for a native `<select>`: `options` may mix plain entries and
 * labeled groups, and empty-string values are handled internally (see `EMPTY_VALUE` above).
 */
export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  size = "md",
  disabled,
  id,
  name,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: SelectProps) {
  const selected = flattenOptions(options).find((option) => option.value === value);

  return (
    <RadixSelect.Root
      value={value === "" ? EMPTY_VALUE : value}
      onValueChange={(next) => onValueChange(next === EMPTY_VALUE ? "" : next)}
      disabled={disabled}
      name={name}
    >
      <RadixSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        className={clsx(
          "input flex items-center justify-between gap-2 bg-elevated text-left",
          size === "sm" && "input-sm",
          className,
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
          {selected?.icon && <span className="shrink-0 text-fg-muted [&_svg]:size-4">{selected.icon}</span>}
          <RadixSelect.Value>
            <span className={clsx("truncate", !selected && "text-fg-subtle")}>
              {selected ? selected.label : placeholder}
            </span>
          </RadixSelect.Value>
        </span>
        <RadixSelect.Icon>
          <ChevronDown className="size-4 shrink-0 text-fg-muted" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className="menu w-(--radix-select-trigger-width) max-h-[min(20rem,var(--radix-select-content-available-height))] overflow-y-auto"
        >
          <RadixSelect.Viewport>
            {options.map((entry, index) =>
              isGroup(entry) ? (
                <Fragment key={index}>
                  {index > 0 && <RadixSelect.Separator className="menu-separator" />}
                  <RadixSelect.Group>
                    <RadixSelect.Label className="menu-label">{entry.label}</RadixSelect.Label>
                    {entry.options.map((option) => (
                      <SelectItemRow key={option.value} option={option} />
                    ))}
                  </RadixSelect.Group>
                </Fragment>
              ) : (
                <SelectItemRow key={entry.value} option={entry} />
              ),
            )}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

function SelectItemRow({ option }: { option: SelectOption }) {
  return (
    <RadixSelect.Item
      value={option.value === "" ? EMPTY_VALUE : option.value}
      disabled={option.disabled}
      className={clsx("menu-item", option.description && "items-start py-2")}
    >
      {option.icon && (
        <span className={clsx("shrink-0 text-fg-muted [&_svg]:size-4", option.description && "mt-0.5")}>
          {option.icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <RadixSelect.ItemText className="block truncate text-sm text-fg">{option.label}</RadixSelect.ItemText>
        {option.description && (
          <span className="mt-0.5 block text-xs leading-snug text-fg-subtle">{option.description}</span>
        )}
      </span>
      <span className="grid size-4 shrink-0 place-items-center">
        <RadixSelect.ItemIndicator>
          <Check className="size-4 text-fg" />
        </RadixSelect.ItemIndicator>
      </span>
    </RadixSelect.Item>
  );
}
