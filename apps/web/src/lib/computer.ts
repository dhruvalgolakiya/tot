import type { ComputerKind, ComputerState } from "@shared/types";

export type DotTone = "green" | "gray" | "amber" | "red";

export function computerTone(state: ComputerState): { tone: DotTone; pulse: boolean } {
  switch (state) {
    case "running":
      return { tone: "green", pulse: false };
    case "starting":
    case "stopping":
      return { tone: "amber", pulse: true };
    case "error":
      return { tone: "red", pulse: false };
    case "stopped":
      return { tone: "gray", pulse: false };
  }
}

export const COMPUTER_KIND_LABELS: Record<ComputerKind, string> = {
  boat: "Boat VM",
  local: "Local",
};

export const COMPUTER_SIZES = [
  { value: "small", label: "Small · 2 vCPU / 4 GB" },
  { value: "default", label: "Default · 4 vCPU / 8 GB" },
  { value: "large", label: "Large · 8 vCPU / 16 GB" },
] as const;
