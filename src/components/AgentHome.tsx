import { agentIsland } from "@shared/islands";
import { useNow } from "../hooks/useNow";
import { selectDevice, useDevices } from "../lib/remote";
import { selectActiveAgent, useStore } from "../store";
import { HeroArt } from "./home/HeroArt";
import { Callout } from "./ui/Callout";
import { defaultMascot, MascotStage } from "./mascot";

/** What the agent says on its home, by the hour. */
function greeting(hour: number): string {
  if (hour >= 5 && hour < 12) return "Morning! What's first?";
  if (hour >= 12 && hour < 17) return "What are we working on?";
  if (hour >= 17 && hour < 22) return "Evening! What should we take on?";
  return "Up late? What are we making?";
}

/**
 * An agent's new-chat hero: the scene, zoomed in on the agent's own island, behind its mascot, who says hello in
 * a speech bubble above the composer. The scene runs up under the (transparent, on Home) header and fades out where the bubble sits.
 */
export function AgentHome() {
  const agent = useStore(selectActiveAgent);
  const name = agent?.name ?? "TOT";
  const device = useDevices(selectDevice(agent?.deviceId));
  const hour = new Date(useNow(true, 60_000)).getHours();

  return (
    <div className="relative flex min-h-64 flex-1 flex-col items-center justify-end px-4 pb-6">
      <HeroArt island={agent ? agentIsland(agent) : undefined} />
      <div className="relative flex flex-col items-center">
        <div className="flex items-end gap-3">
          <MascotStage spec={agent?.mascot ?? defaultMascot} size={64} title={name} className="shrink-0" />
          {/* A chat bubble from the mascot: its squared corner points back at it. */}
          <div className="mb-8 rounded-2xl rounded-bl-sm border border-hairline bg-elevated/85 px-4 py-2.5 shadow-popover backdrop-blur-md">
            <h1 className="font-display text-xl font-semibold text-balance text-fg-strong sm:text-2xl">{greeting(hour)}</h1>
          </div>
        </div>
        {device && !device.online && (
          <Callout tone="warning" className="mt-4 max-w-md">
            {device.name} is offline, so {name} can't answer right now. Its chats are safe on it.
          </Callout>
        )}
      </div>
    </div>
  );
}
