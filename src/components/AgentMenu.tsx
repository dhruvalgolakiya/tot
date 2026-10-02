import type { ReactNode } from "react";
import { DropdownMenu } from "radix-ui";
import { Brain, ChevronDown, Clock, Monitor, Settings } from "lucide-react";
import type { Agent, ComputerSummary } from "@shared/types";
import { computerTone } from "../lib/computer";
import { navigateToWiki, openAgentSettings, setComputerPanelOpen } from "../store";
import { StatusDot } from "./ui/StatusDot";

function computerLabel(computer: ComputerSummary | null): string {
  if (!computer) return "not started";
  if (computer.state === "stopped") return "asleep";
  if (computer.state === "running") return "on";
  return computer.state;
}

/** The agent's name in the chats panel; everything about its workspace lives in this one menu. */
export function AgentMenu({ agent }: { agent: Agent }) {
  const { pages, routines } = agent.counts;
  const tone = agent.computer ? computerTone(agent.computer.state) : { tone: "gray" as const, pulse: false };

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex min-w-0 items-center gap-1 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover data-[state=open]:bg-selected"
        >
          <span className="truncate text-sm font-medium text-fg">{agent.name}</span>
          <ChevronDown className="size-4 shrink-0 text-fg-muted" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className="menu w-56">
          <MenuItem icon={<Settings />} onSelect={() => openAgentSettings(agent.id)}>
            Settings
          </MenuItem>
          <DropdownMenu.Separator className="menu-separator" />
          <MenuItem
            icon={<Monitor />}
            detail={
              <>
                <StatusDot tone={tone.tone} pulse={tone.pulse} />
                {computerLabel(agent.computer)}
              </>
            }
            onSelect={() => setComputerPanelOpen(true)}
          >
            Computer
          </MenuItem>
          <MenuItem icon={<Brain />} detail={pages} onSelect={() => navigateToWiki(agent.id)}>
            Brains
          </MenuItem>
          <MenuItem icon={<Clock />} detail={routines} onSelect={() => openAgentSettings(agent.id, "routines")}>
            Routines
          </MenuItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function MenuItem({
  icon,
  detail,
  onSelect,
  children,
}: {
  icon: ReactNode;
  detail?: ReactNode;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.Item className="menu-item" onSelect={onSelect}>
      <span className="text-fg-muted [&_svg]:size-4">{icon}</span>
      {children}
      {detail !== undefined && (
        <span className="ml-auto flex items-center gap-1.5 text-xs text-fg-subtle tabular-nums">{detail}</span>
      )}
    </DropdownMenu.Item>
  );
}
