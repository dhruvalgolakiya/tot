import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { selectDevice, useDevices } from "../lib/remote";
import { openAgentSettings, selectActiveAgent, useStore } from "../store";
import { Callout } from "./ui/Callout";
import { defaultMascot, MascotStage } from "./mascot";
import { routinesApi } from "./routines/routinesApi";

/** An agent's new-chat hero: its mascot and a ChatGPT-style greeting above the composer. */
export function AgentHome() {
  const agent = useStore(selectActiveAgent);
  const name = agent?.name ?? "TOT";
  const device = useDevices(selectDevice(agent?.deviceId));
  const [routineCount, setRoutineCount] = useState(0);

  useEffect(() => {
    setRoutineCount(0);
    if (!agent || (device && !device.online)) return;
    let cancelled = false;
    routinesApi.list(agent.id).then(
      (routines) => {
        if (!cancelled) setRoutineCount(routines.length);
      },
      () => {
        // Quiet failure: the chip just doesn't show. RoutinesPanel reports errors itself.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agent?.id, device?.online]);

  return (
    <div className="flex flex-1 flex-col items-center justify-end px-4 pb-6">
      <MascotStage spec={agent?.mascot ?? defaultMascot} size={120} title={name} />
      <h1 className="mt-5 text-center font-display text-4xl font-semibold text-fg-strong">What can I help with?</h1>
      {device && !device.online && (
        <Callout tone="warning" className="mt-4 max-w-md">
          {device.name} is offline, so {name} can't answer right now. Its chats are safe on it.
        </Callout>
      )}
      {agent && routineCount > 0 && (
        <button
          type="button"
          onClick={() => openAgentSettings(agent.id, "routines")}
          className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-edge px-3 py-1 text-xs font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <Clock className="size-3.5" />
          <span className="tabular-nums">
            {routineCount} routine{routineCount === 1 ? "" : "s"}
          </span>
        </button>
      )}
    </div>
  );
}
