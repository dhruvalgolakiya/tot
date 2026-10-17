import clsx from "clsx";
import { Check } from "lucide-react";
import type { ModelOption } from "@tot/shared/types";
import { displayDescription, displayLabel } from "../lib/models";

interface ModelMenuItemProps {
  model: ModelOption;
  /** The chat's model. */
  selected: boolean;
  /** Where the arrow keys are. */
  active: boolean;
  onHover: (id: string) => void;
  onPick: (id: string) => void;
}

/** One option in the model menu; unavailable models are disabled with their reason. */
export function ModelMenuItem({ model, selected, active, onHover, onPick }: ModelMenuItemProps) {
  const description = model.available ? displayDescription(model) : (model.unavailableReason ?? "Unavailable");
  return (
    <div
      id={`model-${model.id}`}
      data-model={model.id}
      role="option"
      aria-selected={selected}
      aria-disabled={!model.available || undefined}
      // Pointer moves, not enters: a list scrolled by the keyboard under a still pointer keeps its place.
      onPointerMove={() => model.available && !active && onHover(model.id)}
      onClick={() => model.available && onPick(model.id)}
      className={clsx(
        "flex min-h-8 items-start gap-2 rounded-lg px-2 py-2 select-none",
        model.available ? "cursor-pointer" : "cursor-not-allowed opacity-45",
        active && "bg-hover",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-fg">{displayLabel(model)}</span>
        {description && <span className="mt-0.5 block text-xs leading-snug text-fg-subtle">{description}</span>}
      </span>
      <span className="grid size-4 shrink-0 place-items-center pt-2">{selected && <Check className="size-4 text-fg" />}</span>
    </div>
  );
}
