import clsx from "clsx";
import { Monitor } from "lucide-react";
import { computerTone } from "../lib/computer";
import { selectActiveAgent, setComputerPanelOpen, useStore } from "../store";
import { StatusDot } from "./ui/StatusDot";

/** "Computer · running" — opens the Computer panel. Hidden while computers are turned off. */
export function ComputerChip() {
  const agent = useStore(selectActiveAgent);
  const mode = useStore((s) => s.settings?.computer.mode);
  const panelOpen = useStore((s) => s.computerPanelOpen);
  if (!agent || !mode || mode === "off") return null;
  const computer = agent.computer;
  const { tone, pulse } = computer ? computerTone(computer.state) : { tone: "gray" as const, pulse: false };

  return (
    <button
      type="button"
      onClick={() => setComputerPanelOpen(!panelOpen)}
      aria-pressed={panelOpen}
      className={clsx(
        "flex h-8 items-center gap-2 rounded-full border border-edge px-3 text-xs font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg active:bg-selected",
        panelOpen && "border-edge-strong bg-selected text-fg",
      )}
    >
      <Monitor className="size-3.5" />
      <span className="hidden sm:inline">Computer ·</span>
      <StatusDot tone={tone} pulse={pulse} />
      <span>{computer ? computer.state : "not started"}</span>
    </button>
  );
}
