import { Fragment, useMemo } from "react";
import clsx from "clsx";
import { Laptop, Moon, Plus, Settings, Sun } from "lucide-react";
import type { Agent, Device, MascotState } from "@shared/types";
import { relativeTime } from "../lib/format";
import { useDevices } from "../lib/remote";
import { setThemePreference, useResolvedTheme } from "../lib/theme";
import {
  goToSettings,
  selectActiveAgentId,
  selectAgent,
  selectAgentWorking,
  setNewAgentDialogOpen,
  useStore,
} from "../store";
import { Mascot } from "./mascot";
import { IconButton } from "./ui/IconButton";
import { Logo } from "./ui/Logo";
import { Tip } from "./ui/Tip";

/**
 * Discord/Slack-style workspace rail: TOT mark, one mascot per agent (the
 * workspace switcher), "add agent", then app-wide settings and theme at
 * the bottom. Always visible on desktop — collapsing the sidebar only hides
 * the chats panel next to it. A hairline (plus a slightly darker `bg-rail` in
 * light mode) separates it from that panel. Paired devices' agents (module 07) follow below
 * a hairline, one group per device, each with a small laptop badge.
 */
export function AgentRail({ className }: { className?: string }) {
  const agents = useStore((s) => s.agents);
  const activeAgentId = useStore(selectActiveAgentId);
  const settingsActive = useStore((s) => s.page === "settings");
  const devices = useDevices((s) => s.status?.devices);
  const groups = useMemo(
    () =>
      (devices ?? [])
        .map((device) => ({ device, agents: agents.filter((a) => a.deviceId === device.id) }))
        .filter((group) => group.agents.length > 0),
    [agents, devices],
  );

  return (
    <nav aria-label="Agents" className={clsx("flex h-full w-16 shrink-0 flex-col items-center border-r border-hairline bg-rail py-3", className)}>
      <Logo className="mb-3 size-7 shrink-0" />

      <ul className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto">
        {agents
          .filter((agent) => !agent.deviceId)
          .map((agent) => (
            <RailAgentButton key={agent.id} agent={agent} active={agent.id === activeAgentId} />
          ))}
        {groups.map(({ device, agents: theirs }) => (
          <Fragment key={device.id}>
            <li aria-hidden="true" className="my-1.5 h-px w-6 shrink-0 bg-hairline" />
            {theirs.map((agent) => (
              <RailAgentButton key={agent.id} agent={agent} device={device} active={agent.id === activeAgentId} />
            ))}
          </Fragment>
        ))}
      </ul>

      <Tip content="New agent" side="right">
        <IconButton label="New agent" className="mt-1.5" onClick={() => setNewAgentDialogOpen(true)}>
          <Plus />
        </IconButton>
      </Tip>

      <div className="mt-2 flex w-full shrink-0 flex-col items-center gap-1 border-t border-hairline pt-2.5">
        <Tip content="Settings" side="right">
          <IconButton
            label="Settings"
            aria-current={settingsActive ? "page" : undefined}
            onClick={() => goToSettings()}
            className={settingsActive ? "bg-selected text-fg" : undefined}
          >
            <Settings />
          </IconButton>
        </Tip>
        <RailThemeToggle />
      </div>
    </nav>
  );
}

interface RailAgentButtonProps {
  agent: Agent;
  /** The paired device it lives on; absent for this device's agents. */
  device?: Device;
  active: boolean;
}

/** "Kiwi · on MacBook", plus when that device was last seen if it's offline. */
export function agentPlace(agent: Agent, device: Device | undefined): string {
  if (!device) return agent.name;
  if (device.online) return `${agent.name} · on ${device.name}`;
  return `${agent.name} · on ${device.name}, offline${device.lastSeenAt ? ` since ${relativeTime(device.lastSeenAt)}` : ""}`;
}

function RailAgentButton({ agent, device, active }: RailAgentButtonProps) {
  const working = useStore((s) => selectAgentWorking(s, agent.id));
  const offline = Boolean(device && !device.online);
  const asleep = !working && (offline || agent.computer?.state === "stopped");
  const mascotState: MascotState = working ? "working" : asleep ? "sleeping" : "idle";
  const label = agentPlace(agent, device);

  return (
    <li className="relative flex w-full shrink-0 items-center justify-center">
      <Tip content={label} side="right">
        <button
          type="button"
          aria-label={label}
          aria-current={active ? "page" : undefined}
          onClick={() => selectAgent(agent.id)}
          className={clsx(
            "relative grid size-10 shrink-0 place-items-center rounded-xl transition-colors hover:bg-hover",
            active && "bg-selected",
          )}
        >
          <span className={clsx("grid place-items-center transition-opacity", offline && "opacity-40 grayscale")}>
            <Mascot spec={agent.mascot} size={32} state={mascotState} title={agent.name} />
          </span>
          {device && (
            <span
              className="absolute bottom-0 left-0 grid size-4 place-items-center rounded-full bg-elevated text-fg-muted ring-2 ring-rail"
              aria-hidden="true"
            >
              <Laptop className="size-2.5" />
            </span>
          )}
          {working && (
            <span
              className="absolute right-0.5 bottom-0.5 size-2.5 animate-pulse rounded-full bg-accent ring-2 ring-rail"
              aria-hidden="true"
            />
          )}
        </button>
      </Tip>
    </li>
  );
}

/** One-click switch between light and dark (Settings → General also offers "System"). */
function RailThemeToggle() {
  const theme = useResolvedTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <Tip content={theme === "dark" ? "Light mode" : "Dark mode"} side="right">
      <IconButton label={`Switch to ${next} mode`} onClick={() => setThemePreference(next)}>
        {theme === "dark" ? <Sun /> : <Moon />}
      </IconButton>
    </Tip>
  );
}
