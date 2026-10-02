import clsx from "clsx";
import { MessageSquare, PanelLeft, SquarePen } from "lucide-react";
import {
  navigateToAgentHome,
  selectActiveAgent,
  selectAgentWorking,
  selectCurrentConversation,
  setSidebarOpen,
  useStore,
} from "../store";
import { ComputerChip } from "./ComputerChip";
import { Mascot } from "./mascot";
import { ModelPicker } from "./ModelPicker";
import { IconButton } from "./ui/IconButton";
import { Kbd } from "./ui/Kbd";
import { Tip } from "./ui/Tip";

/**
 * Floats over the chat content (no hard bottom border at rest) and only grows
 * a blurred background once that content has scrolled under it — see the
 * `chatScrolled` listener in MessageList.
 */
export function Header() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const agent = useStore(selectActiveAgent);
  const working = useStore((s) => (agent ? selectAgentWorking(s, agent.id) : false));
  const scrolled = useStore((s) => s.chatScrolled);
  const slackUrl = useStore((s) => {
    const origin = selectCurrentConversation(s)?.origin;
    return origin?.kind === "slack" ? origin.url : null;
  });

  return (
    <header
      className={clsx(
        "absolute inset-x-0 top-0 z-10 flex h-14 shrink-0 items-center gap-1 border-b px-2 transition-all duration-200 sm:px-3",
        scrolled
          ? "border-white/[0.06] bg-canvas/80 backdrop-blur-xl"
          : "border-transparent bg-transparent backdrop-blur-none",
      )}
    >
      {!sidebarOpen && (
        <>
          <Tip content="Open sidebar" side="bottom">
            <IconButton label="Open sidebar" onClick={() => setSidebarOpen(true)}>
              <PanelLeft />
            </IconButton>
          </Tip>
          <Tip
            side="bottom"
            content={
              <span className="flex items-center gap-2">
                New chat <Kbd keys={["mod", "shift", "O"]} />
              </span>
            }
          >
            <IconButton label="New chat" onClick={() => agent && navigateToAgentHome(agent.id)}>
              <SquarePen />
            </IconButton>
          </Tip>
        </>
      )}
      {/* On desktop the agent rail already shows whose chat this is. */}
      {agent && (
        <button
          type="button"
          onClick={() => navigateToAgentHome(agent.id)}
          className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-zinc-200 transition hover:bg-white/5 md:hidden"
        >
          <Mascot spec={agent.mascot} size={24} state={working ? "working" : "idle"} title={agent.name} />
          {/* Phones show just the mascot so the model picker has room. */}
          <span className="hidden truncate tracking-tight sm:inline">{agent.name}</span>
        </button>
      )}
      <ModelPicker />
      <div className="ml-auto flex items-center gap-2">
        {slackUrl && (
          <Tip content="Open in Slack">
            <a
              href={slackUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open in Slack"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/[0.07] hover:text-zinc-100"
            >
              <MessageSquare className="size-[18px]" />
            </a>
          </Tip>
        )}
        <ComputerChip />
      </div>
    </header>
  );
}
