import { Monitor } from "lucide-react";
import type { ComputerSummary } from "@shared/types";
import { computerTone } from "../lib/computer";
import { selectActiveAgent, setComputerPanelOpen, useStore } from "../store";
import { IconButton } from "./ui/IconButton";
import { StatusDot } from "./ui/StatusDot";
import { Tip } from "./ui/Tip";

function computerLabel(computer: ComputerSummary | null): string {
  if (!computer) return "not started";
  if (computer.state === "stopped") return "asleep";
  if (computer.state === "running") return "on";
  return computer.state;
}

/** A quiet monitor icon with the computer's status dot on its corner; opens the Computer panel. Hidden while computers are off. */
export function ComputerChip() {
  const agent = useStore(selectActiveAgent);
  const mode = useStore((s) => s.settings?.computer.mode);
  const panelOpen = useStore((s) => s.computerPanelOpen);
  if (!agent || !mode || mode === "off") return null;
  const computer = agent.computer;
  const { tone, pulse } = computer ? computerTone(computer.state) : { tone: "gray" as const, pulse: false };
  const label = `Computer · ${computerLabel(computer)}`;

  return (
    <Tip content={label}>
      <IconButton label={label} aria-pressed={panelOpen} onClick={() => setComputerPanelOpen(!panelOpen)}>
        <span className="relative grid place-items-center">
          <Monitor />
          <span className="absolute -right-1 -bottom-0.5 grid place-items-center rounded-full bg-canvas p-[2px]">
            <StatusDot tone={tone} pulse={pulse} />
          </span>
        </span>
      </IconButton>
    </Tip>
  );
}
