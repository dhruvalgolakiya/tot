import type { MascotSpec, MascotState } from "@tot/shared/types";
import { Mascot } from "./mascot";

interface AssistantAvatarProps {
  mascot: MascotSpec;
  name: string;
  state?: MascotState;
}

/** The agent's mascot, used as its avatar in the message list. */
export function AssistantAvatar({ mascot, name, state = "idle" }: AssistantAvatarProps) {
  return (
    <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center">
      <Mascot spec={mascot} state={state} size={28} title={name} />
    </div>
  );
}
