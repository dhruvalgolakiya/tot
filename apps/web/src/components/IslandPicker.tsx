import clsx from "clsx";
import { AGENT_ISLANDS, islandImage } from "@shared/islands";
import type { AgentIsland } from "@shared/types";
import { useResolvedTheme } from "../lib/theme";

/** The islands as small thumbnails to pick from; the picked one gets a ring. */
export function IslandPicker({ value, onChange }: { value: AgentIsland; onChange: (island: AgentIsland) => void }) {
  const dawn = useResolvedTheme() === "light";
  return (
    <div role="radiogroup" aria-label="Island" className="flex flex-wrap gap-2">
      {AGENT_ISLANDS.map((island) => {
        const checked = island.id === value;
        return (
          <button
            key={island.id}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={island.name}
            title={island.name}
            onClick={() => onChange(island.id)}
            className={clsx(
              "overflow-hidden rounded-lg transition-shadow",
              checked ? "ring-2 ring-fg" : "ring-1 ring-hairline hover:ring-edge-strong",
            )}
          >
            <img src={islandImage(island.id, dawn)} alt="" width={72} height={48} loading="lazy" className="block h-12 w-18 object-cover" />
          </button>
        );
      })}
    </div>
  );
}
