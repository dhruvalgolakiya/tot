import { Monitor } from "lucide-react";
import { goToSettings, selectActiveAgent, setComputerPanelOpen, useStore } from "../store";
import { ComputerActivity } from "./ComputerActivity";
import { ComputerDetails } from "./ComputerDetails";
import { Mascot } from "./mascot";
import { Button } from "./ui/Button";
import { SidePanel } from "./ui/SidePanel";

/** Right-hand panel for the active agent's computer. */
export function ComputerPanel() {
  const open = useStore((s) => s.computerPanelOpen);
  const agent = useStore(selectActiveAgent);
  const computerMode = useStore((s) => s.settings?.computer.mode);
  const boatKeySet = useStore((s) => s.settings?.computer.boatApiKeySet);

  if (!open || !agent) return null;

  const needsBoatKey = computerMode === "boat" && !boatKeySet;

  return (
    <SidePanel label="Computer" icon={<Monitor />} title="Computer" onClose={() => setComputerPanelOpen(false)}>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        {needsBoatKey ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-white/10 px-4 py-8 text-center">
            <Mascot spec={agent.mascot} size={56} state="sleeping" title={agent.name} />
            <p className="text-sm text-zinc-300">
              Add a Boat API key to give {agent.name} a cloud computer to work in.
            </p>
            <Button size="sm" variant="primary" onClick={() => goToSettings("computer")}>
              Open Settings → Computer
            </Button>
          </div>
        ) : agent.computer ? (
          <ComputerDetails
            agentId={agent.id}
            agentName={agent.name}
            mascot={agent.mascot}
            computer={agent.computer}
          />
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-white/10 px-4 py-8 text-center">
            <Mascot spec={agent.mascot} size={56} state="sleeping" title={agent.name} />
            <p className="text-sm text-zinc-500">
              No computer yet. {agent.name} starts one the first time it needs to run something.
            </p>
          </div>
        )}
        <ComputerActivity agentId={agent.id} />
      </div>
    </SidePanel>
  );
}
