import clsx from "clsx";
import { Moon, Plus, Settings, Sun } from "lucide-react";
import type { Agent, MascotState } from "@shared/types";
import { setThemePreference, useResolvedTheme } from "../lib/theme";
import {
  goToSettings,
  navigateToAgentHome,
  selectActiveAgentId,
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
 * light mode) separates it from that panel.
 */
export function AgentRail({ className }: { className?: string }) {
  const agents = useStore((s) => s.agents);
  const activeAgentId = useStore(selectActiveAgentId);
  const settingsActive = useStore((s) => s.page === "settings");

  return (
    <nav aria-label="Agents" className={clsx("flex h-full w-16 shrink-0 flex-col items-center border-r border-hairline bg-rail py-3", className)}>
      <Logo className="mb-3 size-7 shrink-0" />

      <ul className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto">
        {agents.map((agent) => (
          <RailAgentButton key={agent.id} agent={agent} active={agent.id === activeAgentId} />
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
  active: boolean;
}

function RailAgentButton({ agent, active }: RailAgentButtonProps) {
  const working = useStore((s) => selectAgentWorking(s, agent.id));
  const asleep = !working && agent.computer?.state === "stopped";
  const mascotState: MascotState = working ? "working" : asleep ? "sleeping" : "idle";

  return (
    <li className="relative flex w-full shrink-0 items-center justify-center">
      <Tip content={agent.name} side="right">
        <button
          type="button"
          aria-label={agent.name}
          aria-current={active ? "page" : undefined}
          onClick={() => navigateToAgentHome(agent.id)}
          className={clsx(
            "relative grid size-10 shrink-0 place-items-center rounded-xl transition-colors hover:bg-hover",
            active && "bg-selected",
          )}
        >
          <Mascot spec={agent.mascot} size={32} state={mascotState} title={agent.name} />
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
