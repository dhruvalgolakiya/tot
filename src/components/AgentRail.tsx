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
import { Logo } from "./ui/Logo";
import { Tip } from "./ui/Tip";

/**
 * Discord/Slack-style workspace rail: TOT mark, one mascot per agent (the
 * workspace switcher), "add agent", then app-wide settings and theme at
 * the bottom. Always visible on desktop — collapsing the sidebar only hides
 * the chats panel next to it.
 */
export function AgentRail({ className }: { className?: string }) {
  const agents = useStore((s) => s.agents);
  const activeAgentId = useStore(selectActiveAgentId);
  const settingsActive = useStore((s) => s.page === "settings");

  return (
    <nav
      aria-label="Agents"
      className={clsx("flex h-full w-16 shrink-0 flex-col items-center border-r border-white/[0.04] py-3", className)}
    >
      <Logo className="mb-3 size-7 shrink-0" />

      <ul className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto">
        {agents.map((agent) => (
          <RailAgentButton key={agent.id} agent={agent} active={agent.id === activeAgentId} />
        ))}
      </ul>

      <Tip content="New agent" side="right">
        <button
          type="button"
          aria-label="New agent"
          onClick={() => setNewAgentDialogOpen(true)}
          className="mt-1.5 grid size-10 shrink-0 place-items-center rounded-full border border-dashed border-white/15 text-zinc-500 transition-colors hover:border-white/25 hover:bg-white/[0.05] hover:text-zinc-300"
        >
          <Plus className="size-4" />
        </button>
      </Tip>

      <div className="mt-2 flex w-full shrink-0 flex-col items-center gap-1 border-t border-white/[0.06] pt-2.5">
        <Tip content="Settings" side="right">
          <button
            type="button"
            aria-label="Settings"
            aria-current={settingsActive ? "page" : undefined}
            onClick={() => goToSettings()}
            className={clsx(
              "grid size-9 place-items-center rounded-lg transition-colors hover:bg-white/[0.07] hover:text-zinc-100",
              settingsActive ? "bg-white/[0.07] text-zinc-100" : "text-zinc-400",
            )}
          >
            <Settings className="size-[18px]" />
          </button>
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
      <span
        aria-hidden="true"
        className={clsx(
          "absolute left-0 h-6 w-1 rounded-r-full transition-opacity",
          active ? "opacity-100" : "opacity-0",
        )}
        style={{ background: "var(--agent-accent)" }}
      />
      <Tip content={agent.name} side="right">
        <button
          type="button"
          aria-label={agent.name}
          aria-current={active ? "page" : undefined}
          onClick={() => navigateToAgentHome(agent.id)}
          style={active ? { background: "var(--agent-accent-16)" } : undefined}
          className="relative grid size-11 shrink-0 place-items-center rounded-2xl transition-colors hover:bg-white/[0.07]"
        >
          <Mascot spec={agent.mascot} size={32} state={mascotState} title={agent.name} />
          {working && (
            <span
              className="absolute right-0.5 bottom-0.5 size-2.5 animate-pulse rounded-full ring-2 ring-[var(--color-panel)]"
              style={{ background: "var(--agent-accent)" }}
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
      <button
        type="button"
        aria-label={`Switch to ${next} mode`}
        onClick={() => setThemePreference(next)}
        className="grid size-9 shrink-0 place-items-center rounded-lg text-zinc-400 transition-colors hover:bg-white/[0.07] hover:text-zinc-100"
      >
        {theme === "dark" ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
      </button>
    </Tip>
  );
}
