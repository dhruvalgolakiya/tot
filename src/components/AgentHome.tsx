import { selectDevice, useDevices } from "../lib/remote";
import { selectActiveAgent, useStore } from "../store";
import { HeroArt } from "./home/HeroArt";
import { Callout } from "./ui/Callout";
import { defaultMascot, MascotStage } from "./mascot";

/**
 * An agent's new-chat hero: a pixel-art scene behind the agent's mascot and the question above the composer.
 * The scene runs up under the (transparent, on Home) header and fades out where the title sits.
 */
export function AgentHome() {
  const agent = useStore(selectActiveAgent);
  const name = agent?.name ?? "TOT";
  const device = useDevices(selectDevice(agent?.deviceId));

  return (
    <div className="relative flex min-h-64 flex-1 flex-col items-center justify-end px-4 pb-6">
      <HeroArt />
      <div className="hero-copy relative flex flex-col items-center">
        <MascotStage spec={agent?.mascot ?? defaultMascot} size={72} title={name} />
        <h1 className="mt-4 text-center font-display text-3xl font-semibold text-fg-strong sm:text-4xl">What should {name} work on?</h1>
        {device && !device.online && (
          <Callout tone="warning" className="mt-4 max-w-md">
            {device.name} is offline, so {name} can't answer right now. Its chats are safe on it.
          </Callout>
        )}
      </div>
    </div>
  );
}
