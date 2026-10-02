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
        "flex h-8 items-center gap-2 rounded-full border px-3 text-xs font-medium transition-colors",
        panelOpen
          ? "border-white/15 bg-white/[0.08] text-zinc-100"
          : "border-white/10 text-zinc-300 hover:bg-white/[0.05] hover:text-zinc-100",
      )}
    >
      <Monitor className="size-3.5 text-zinc-400" />
      <span className="hidden sm:inline">Computer ·</span>
      <StatusDot tone={tone} pulse={pulse} />
      <span>{computer ? computer.state : "not started"}</span>
    </button>
  );
}
