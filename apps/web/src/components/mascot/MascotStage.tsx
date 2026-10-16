// A hero presentation for a single mascot: a soft color-matched glow behind it, and a
// Grok-Bot-style bounce-into-scene entrance that plays once whenever this component
// mounts (e.g. landing on an agent's home screen). Not part of the required public
// API, but exported as a recommended way to show a mascot "on stage".
import clsx from "clsx";
import type { MascotSpec, MascotState } from "@tot/shared/types";
import { Mascot } from "./Mascot";
import { derivePalette, withAlpha } from "./utils";

export interface MascotStageProps {
  spec: MascotSpec;
  state?: MascotState;
  size?: number;
  className?: string;
  title?: string;
}

export function MascotStage({ spec, state = "idle", size = 160, className, title }: MascotStageProps) {
  const palette = derivePalette(spec.color);
  return (
    <div className={clsx("mascot-stage-enter relative inline-grid place-items-center", className)}>
      <div
        className="absolute inset-0 -z-10 rounded-full blur-3xl"
        style={{
          background: `radial-gradient(circle, ${withAlpha(palette.glow, 0.6)}, transparent 75%)`,
          transform: "scale(1.7)",
        }}
        aria-hidden="true"
      />
      <Mascot spec={spec} state={state} size={size} title={title} />
    </div>
  );
}
