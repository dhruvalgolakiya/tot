import { Monitor } from "lucide-react";
import { goToSettings, selectActiveAgent, setComputerPanelOpen, useStore } from "../store";
import { ComputerActivity } from "./ComputerActivity";
import { ComputerDetails } from "./ComputerDetails";
import { Mascot } from "./mascot";
import { Button } from "./ui/Button";
import { EmptyState } from "./ui/EmptyState";
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
          <EmptyState
            variant="dashed"
            size="sm"
            media={<Mascot spec={agent.mascot} size={56} state="sleeping" title={agent.name} />}
            title={`Add a Boat API key to give ${agent.name} a cloud computer to work in.`}
            action={
              <Button size="sm" variant="primary" onClick={() => goToSettings("computer")}>
                Open Settings → Computer
              </Button>
            }
          />
        ) : agent.computer ? (
          <ComputerDetails
            agentId={agent.id}
            agentName={agent.name}
            mascot={agent.mascot}
            computer={agent.computer}
          />
        ) : (
          <EmptyState
            variant="dashed"
            size="sm"
            media={<Mascot spec={agent.mascot} size={56} state="sleeping" title={agent.name} />}
            title="No computer yet"
            description={`${agent.name} starts one the first time it needs to run something.`}
          />
        )}
        <ComputerActivity agentId={agent.id} />
      </div>
    </SidePanel>
  );
}
