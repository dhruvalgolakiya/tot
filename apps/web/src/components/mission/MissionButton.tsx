import clsx from "clsx";
import { SquareKanban } from "lucide-react";
import { navigateToMission } from "../../store";
import { Kbd } from "../ui/Kbd";
import { Tip } from "../ui/Tip";

/** Shows on hover of the sidebar group it sits in (always on touch screens). */
const REVEAL = {
  tasks: "group-hover/tasks:opacity-100",
  projects: "group-hover/projects:opacity-100",
} as const;

/** Module 09: the way to mission control from a sidebar group's header (Tasks, Projects), revealed on hover. */
export function MissionButton({ group }: { group: keyof typeof REVEAL }) {
  return (
    <Tip
      content={
        <span className="flex items-center gap-2">
          Mission control <Kbd keys={["mod", "shift", "M"]} />
        </span>
      }
    >
      <button
        type="button"
        aria-label="Mission control"
        onClick={() => navigateToMission()}
        className={clsx(
          "-my-1 grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle opacity-0 transition-[opacity,color,background-color] hover:bg-hover hover:text-fg-muted focus-visible:opacity-100 pointer-coarse:opacity-100",
          REVEAL[group],
        )}
      >
        <SquareKanban className="size-3.5" />
      </button>
    </Tip>
  );
}
