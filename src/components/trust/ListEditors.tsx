import { useState, type KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";
import clsx from "clsx";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";

type RuleListProps = {
  /** Names the list for screen readers, e.g. "Conventions". */
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
  addLabel: string;
};

/** A list of short rules, one editable line each, with a remove button per line and an add button below. */
export function RuleList({ label, items, onChange, placeholder, addLabel }: RuleListProps) {
  const update = (index: number, value: string) => onChange(items.map((item, i) => (i === index ? value : item)));
  return (
    <div className="space-y-1.5">
      {items.length > 0 && (
        <ul aria-label={label} className="space-y-1.5">
          {items.map((item, index) => (
            <li key={index} className="flex items-center gap-1.5">
              <input
                aria-label={`${label} ${index + 1}`}
                value={item}
                onChange={(event) => update(index, event.target.value)}
                placeholder={placeholder}
                className="input input-sm rounded-lg"
                maxLength={300}
              />
              <IconButton label={`Remove ${label.toLowerCase()} ${index + 1}`} size="sm" onClick={() => onChange(items.filter((_, i) => i !== index))}>
                <X />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <Button type="button" size="sm" variant="ghost" className="-ml-2" onClick={() => onChange([...items, ""])}>
        <Plus /> {addLabel}
      </Button>
    </div>
  );
}

type ChipInputProps = {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  /** Monospace chips, for paths and globs. */
  mono?: boolean;
};

/** Values as removable chips; type one and press Enter (or a comma) to add it. */
export function ChipInput({ label, values, onChange, placeholder, mono = false }: ChipInputProps) {
  const [draft, setDraft] = useState("");

  function commit() {
    const value = draft.trim().replace(/,$/, "");
    if (value && !values.includes(value)) onChange([...values, value]);
    setDraft("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit();
    } else if (event.key === "Backspace" && !draft && values.length) {
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div className="space-y-2">
      {values.length > 0 && (
        <ul aria-label={label} className="flex flex-wrap gap-1.5">
          {values.map((value) => (
            <li key={value} className={clsx("inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-fill pr-1 pl-2.5 text-ui text-fg", mono && "font-mono")}>
              <span className="truncate">{value}</span>
              <button
                type="button"
                aria-label={`Remove ${value}`}
                onClick={() => onChange(values.filter((v) => v !== value))}
                className="grid size-5 shrink-0 place-items-center rounded-full text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        aria-label={`Add to ${label.toLowerCase()}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        placeholder={placeholder}
        className={clsx("input input-sm rounded-lg", mono && "font-mono")}
      />
    </div>
  );
}
