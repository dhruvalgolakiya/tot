import { Laptop } from "lucide-react";
import type { Agent } from "@tot/shared/types";
import { selectDevice, useDevices } from "../lib/remote";
import { Tip } from "./ui/Tip";

/** "on MacBook" for another device's agent (module 07): its chats, files and logins are there. */
export function DeviceChip({ agent }: { agent: Agent | undefined }) {
  const device = useDevices(selectDevice(agent?.deviceId));
  if (!agent || !device) return null;
  return (
    <Tip content={device.online ? `${agent.name} lives on ${device.name}: its chats, files and logins are there.` : `${device.name} is offline. Its chats are safe on it.`}>
      <span className="flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-xs text-fg-muted">
        <Laptop className="size-3.5" />
        <span className="max-w-32 truncate">
          on {device.name}
          {!device.online && " · offline"}
        </span>
      </span>
    </Tip>
  );
}
