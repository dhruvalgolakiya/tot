import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { Popover, RadioGroup } from "radix-ui";
import { ChevronDown } from "lucide-react";
import type { Effort, ModelOption } from "@tot/shared/types";
import { EFFORT_LABELS, filterModels, groupModels, modelLabel } from "../lib/models";
import { selectActiveModels, selectCurrentEffort, selectCurrentModelId, setEffort, setModel, useStore } from "../store";
import { ModelMenuItem } from "./ModelMenuItem";
import { SearchInput } from "./ui/SearchInput";

/**
 * Header model menu: a search box, TOT Auto, then each provider account's models under its name (Claude accounts
 * first); below them, the reasoning effort when the chat's model has one to pick. Arrows move, Enter picks.
 */
export function ModelPicker() {
  const models = useStore(selectActiveModels);
  const currentModelId = useStore(selectCurrentModelId);
  const effort = useStore(selectCurrentEffort);
  const [open, setOpen] = useState(false);
  const efforts = models.find((m) => m.id === currentModelId)?.efforts;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="flex h-9 min-w-0 items-center gap-1 rounded-lg px-2 text-lg font-semibold text-fg transition-colors hover:bg-hover data-[state=open]:bg-selected"
        >
          <span className="truncate">{modelLabel(models, currentModelId)}</span>
          {effort && efforts?.includes(effort) && <span className="shrink-0 font-normal text-fg-subtle">{EFFORT_LABELS[effort]}</span>}
          <ChevronDown className="size-4 shrink-0 text-fg-subtle" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          // The list scrolls; search and effort stay put.
          className="menu flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-96 max-w-[calc(100vw-16px)] flex-col p-0"
        >
          {models.length === 0 ? (
            <div className="px-3 py-3 text-sm text-fg-subtle">Models aren't available yet. Is the TOT server running?</div>
          ) : (
            <ModelMenu
              models={models}
              currentModelId={currentModelId}
              onPick={(id) => {
                void setModel(id);
                setOpen(false);
              }}
            />
          )}
          {efforts && efforts.length > 0 && <EffortPicker efforts={efforts} effort={effort} />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ModelMenu({ models, currentModelId, onPick }: { models: ModelOption[]; currentModelId: string; onPick: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterModels(models, query), [models, query]);
  const { auto, groups } = groupModels(shown);
  // In the order they're listed (groupModels keeps the server's account order), for the arrow keys.
  const pickable = useMemo(() => [...auto, ...groups.flatMap((g) => g.models)].filter((m) => m.available), [auto, groups]);
  const [activeId, setActiveId] = useState<string | null>(currentModelId);
  const active = pickable.find((m) => m.id === activeId) ?? pickable[0];

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    // A frame later: on opening, the menu gets its height only once it's been placed.
    const frame = requestAnimationFrame(() =>
      listRef.current?.querySelector(`[data-model="${CSS.escape(active.id)}"]`)?.scrollIntoView({ block: "nearest" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [active]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || !pickable.length) return;
    const at = active ? pickable.indexOf(active) : -1;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const by = event.key === "ArrowDown" ? 1 : -1;
      setActiveId(pickable[(at + by + pickable.length) % pickable.length]!.id);
    } else if (event.key === "Enter" && active) {
      event.preventDefault();
      onPick(active.id);
    }
  };

  return (
    <>
      <div className="shrink-0 border-b border-hairline p-1.5">
        <SearchInput
          compact
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="model-options"
          aria-activedescendant={active ? `model-${active.id}` : undefined}
          aria-label="Search models"
          placeholder="Search models"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveId(null);
          }}
          onKeyDown={onKeyDown}
          // Inside the menu's own surface: no second box around the field.
          className="border-transparent bg-transparent hover:border-transparent focus:border-transparent focus:shadow-none"
        />
      </div>
      <div ref={listRef} id="model-options" role="listbox" aria-label="Models" className="min-h-0 flex-1 overflow-y-auto p-1">
        {shown.length === 0 && <div className="px-2 py-3 text-sm text-fg-subtle">No models match “{query.trim()}”</div>}
        {auto.map((model) => (
          <ModelMenuItem key={model.id} model={model} selected={model.id === currentModelId} active={model === active} onHover={setActiveId} onPick={onPick} />
        ))}
        {groups.map((group, index) => (
          <Fragment key={group.accountId}>
            {(index > 0 || auto.length > 0) && <div role="separator" className="menu-separator" />}
            <div className="menu-label">{group.label}</div>
            {group.models.map((model) => (
              <ModelMenuItem key={model.id} model={model} selected={model.id === currentModelId} active={model === active} onHover={setActiveId} onPick={onPick} />
            ))}
          </Fragment>
        ))}
      </div>
    </>
  );
}

const AUTO_EFFORT = "auto";

/** How hard the chat's model thinks: TOT's pick each turn (Auto), or one of the model's levels, kept for the chat. */
function EffortPicker({ efforts, effort }: { efforts: Effort[]; effort: Effort | null }) {
  const value = effort && efforts.includes(effort) ? effort : AUTO_EFFORT;
  return (
    <div className="shrink-0 space-y-1.5 border-t border-hairline px-3 pt-2.5 pb-3">
      <div className="text-xs font-medium text-fg-subtle" id="effort-label">
        Reasoning effort
      </div>
      <RadioGroup.Root
        value={value}
        onValueChange={(next) => void setEffort(next === AUTO_EFFORT ? null : (next as Effort))}
        aria-labelledby="effort-label"
        className="flex gap-0.5 rounded-lg bg-fill p-0.5"
      >
        {[AUTO_EFFORT, ...efforts].map((level) => (
          <RadioGroup.Item
            key={level}
            value={level}
            title={level === AUTO_EFFORT ? "TOT picks it for each message" : level === "xhigh" ? "Extra high" : undefined}
            className={clsx(
              "h-7 min-w-0 flex-1 truncate rounded-md px-1 text-xs font-medium text-fg-muted transition-colors hover:text-fg",
              "data-[state=checked]:bg-fg data-[state=checked]:text-canvas",
            )}
          >
            {level === AUTO_EFFORT ? "Auto" : EFFORT_LABELS[level as Effort]}
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
    </div>
  );
}
