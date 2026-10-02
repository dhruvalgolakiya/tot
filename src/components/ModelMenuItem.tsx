import { DropdownMenu } from "radix-ui";
import { Check } from "lucide-react";
import type { ModelOption } from "@shared/types";
import { displayDescription, displayLabel } from "../lib/models";

/** One radio option in the model picker; unavailable models are disabled with their reason. */
export function ModelMenuItem({ model }: { model: ModelOption }) {
  const description = model.available ? displayDescription(model) : (model.unavailableReason ?? "Unavailable");
  return (
    <DropdownMenu.RadioItem value={model.id} disabled={!model.available} className="menu-item items-start py-2">
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-fg">{displayLabel(model)}</span>
        {description && <span className="mt-0.5 block text-xs leading-snug text-fg-subtle">{description}</span>}
      </span>
      <span className="grid size-4 shrink-0 place-items-center pt-2">
        <DropdownMenu.ItemIndicator>
          <Check className="size-4 text-fg" />
        </DropdownMenu.ItemIndicator>
      </span>
    </DropdownMenu.RadioItem>
  );
}
