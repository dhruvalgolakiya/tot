import { DropdownMenu } from "radix-ui";
import { ChevronDown } from "lucide-react";
import { groupModels, modelLabel } from "../lib/models";
import { selectActiveModels, selectCurrentModelId, setModel, useStore } from "../store";
import { ModelMenuItem } from "./ModelMenuItem";

/** Header model menu: TOT Auto, then Claude models, then ChatGPT models. */
export function ModelPicker() {
  const models = useStore(selectActiveModels);
  const currentModelId = useStore(selectCurrentModelId);
  const groups = groupModels(models);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex h-9 min-w-0 items-center gap-1 rounded-lg px-2 text-lg font-semibold text-fg transition-colors hover:bg-hover data-[state=open]:bg-selected"
        >
          <span className="truncate">{modelLabel(models, currentModelId)}</span>
          <ChevronDown className="size-4 shrink-0 text-fg-subtle" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="menu max-h-[var(--radix-dropdown-menu-content-available-height)] w-80 max-w-[calc(100vw-16px)] overflow-y-auto"
        >
          {models.length === 0 ? (
            <div className="px-3 py-3 text-sm text-fg-subtle">Models aren't available yet. Is the TOT server running?</div>
          ) : (
            <DropdownMenu.RadioGroup value={currentModelId} onValueChange={(id) => void setModel(id)}>
              {groups.auto.map((model) => (
                <ModelMenuItem key={model.id} model={model} />
              ))}
              {groups.claude.length > 0 && (
                <>
                  {groups.auto.length > 0 && <DropdownMenu.Separator className="menu-separator" />}
                  <DropdownMenu.Label className="menu-label">Claude</DropdownMenu.Label>
                  {groups.claude.map((model) => (
                    <ModelMenuItem key={model.id} model={model} />
                  ))}
                </>
              )}
              {groups.chatgpt.length > 0 && (
                <>
                  <DropdownMenu.Separator className="menu-separator" />
                  <DropdownMenu.Label className="menu-label">ChatGPT</DropdownMenu.Label>
                  {groups.chatgpt.map((model) => (
                    <ModelMenuItem key={model.id} model={model} />
                  ))}
                </>
              )}
            </DropdownMenu.RadioGroup>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
