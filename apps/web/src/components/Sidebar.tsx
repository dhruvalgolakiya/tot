import clsx from "clsx";
import { PanelLeftClose, Search, SquarePen } from "lucide-react";
import type { Agent } from "@tot/shared/types";
import { DESKTOP_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { setPaletteOpen } from "../lib/palette";
import {
  navigateToAgentHome,
  selectActiveAgent,
  setSidebarOpen,
  useStore,
} from "../store";
import { AgentMenu } from "./AgentMenu";
import { AgentRail } from "./AgentRail";
import { ConversationList } from "./ConversationList";
import { SettingsNav } from "./settings/SettingsNav";
import { IconButton } from "./ui/IconButton";
import { Kbd } from "./ui/Kbd";
import { listRowClass } from "./ui/ListRow";
import { Tip } from "./ui/Tip";
import { UpdatePrompt } from "./UpdatePrompt";

const PANEL_WIDTH = 260;
/**
 * Slack/Discord-style workspace layout: a narrow agent rail (workspace
 * switcher) plus a panel for the selected agent's chats. Collapsible on
 * desktop — collapsing hides the panel but keeps the rail visible. On phones
 * the rail and panel slide in together as one drawer.
 */
export function Sidebar() {
  const open = useStore((s) => s.sidebarOpen);
  const onSettings = useStore((s) => s.page === "settings");
  const agent = useStore(selectActiveAgent);
  const desktop = useMediaQuery(DESKTOP_QUERY);

  const panel = <SidebarPanel agent={agent} />;

  if (desktop) {
    return (
      <>
        {/* Above the panel, which slides underneath it when the sidebar collapses. */}
        <AgentRail className="relative z-50" />
        <aside
          aria-label={onSettings ? "Settings" : "Chats"}
          inert={!open}
          style={{ width: PANEL_WIDTH }}
          className={clsx(
            "relative z-40 flex h-full shrink-0 flex-col border-r border-hairline transition-[margin] duration-200 ease-out",
            // Tailwind needs the literal class string in source to generate it; keep in sync with PANEL_WIDTH.
            open ? "ml-0" : "-ml-[260px]",
          )}
        >
          {onSettings ? <SettingsNav /> : panel}
          <UpdatePrompt />
        </aside>
      </>
    );
  }

  return (
    <>
      {open && (
        <div
          aria-hidden="true"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-30 animate-fade-in bg-scrim/60 backdrop-blur-[2px]"
        />
      )}
      <div
        inert={!open}
        className={clsx(
          "fixed inset-y-0 left-0 z-40 flex h-full bg-panel transition-transform duration-200 ease-out",
          // Shadow only while open: off-screen it would still bleed onto the page's left edge.
          open ? "translate-x-0 shadow-2xl shadow-shade/80" : "-translate-x-full",
        )}
      >
        <AgentRail />
        <aside aria-label="Chats" style={{ width: PANEL_WIDTH }} className="flex h-full shrink-0 flex-col">
          {panel}
          <UpdatePrompt />
        </aside>
      </div>
    </>
  );
}

/** The selected agent's chats: agent menu, new chat, search (the command palette), chat list. */
function SidebarPanel({ agent }: { agent: Agent | undefined }) {
  return (
    <>
      <PanelHeader agent={agent} />

      <div className="shrink-0 space-y-0.5 px-2 pb-1">
        <button type="button" onClick={() => agent && navigateToAgentHome(agent.id)} className={listRowClass()}>
          <SquarePen className="size-4 shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1 truncate">New chat</span>
          <span className="ml-auto hidden shrink-0 items-center opacity-0 transition-opacity group-hover/row:opacity-100 md:flex">
            <Kbd keys={["mod", "shift", "O"]} />
          </span>
        </button>

        <button type="button" onClick={() => setPaletteOpen(true)} className={listRowClass()}>
          <Search className="size-4 shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1 truncate">Search chats</span>
          <span className="ml-auto hidden shrink-0 items-center opacity-0 transition-opacity group-hover/row:opacity-100 md:flex">
            <Kbd keys={["mod", "K"]} />
          </span>
        </button>
      </div>

      <ConversationList />

    </>
  );
}

/** The agent menu, plus a collapse button that only shows on hover (always on touch screens). */
function PanelHeader({ agent }: { agent: Agent | undefined }) {
  return (
    <div className="app-drag-region group/header flex h-14 shrink-0 items-center gap-1 pr-1.5 pl-2">
      {agent && <AgentMenu agent={agent} />}
      <Tip content="Close sidebar" side="bottom">
        <IconButton
          label="Close sidebar"
          size="sm"
          className="ml-auto opacity-0 transition-opacity group-hover/header:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
          onClick={() => setSidebarOpen(false)}
        >
          <PanelLeftClose />
        </IconButton>
      </Tip>
    </div>
  );
}
