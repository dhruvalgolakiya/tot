import { PanelLeft, SquarePen } from "lucide-react";
import {
  navigateToAgentHome,
  selectActiveAgent,
  selectAgentWorking,
  selectCurrentConversation,
  setSidebarOpen,
  useStore,
} from "../store";
import { useProjects } from "../lib/projects";
import { isTask } from "../lib/tasks";
import { ChatMenu } from "./ChatMenu";
import { ComputerChip } from "./ComputerChip";
import { Mascot } from "./mascot";
import { ModelPicker } from "./ModelPicker";
import { DeviceChip } from "./DeviceChip";
import { ChatProjectCrumb, TicketChip } from "./projects/ChatProjectCrumb";
import { ProjectMenu } from "./projects/ProjectMenu";
import { ProjectTitle } from "./projects/ProjectTitle";
import { IconButton } from "./ui/IconButton";
import { Kbd } from "./ui/Kbd";
import { SlackMark } from "./ui/SlackMark";
import { Tip } from "./ui/Tip";
import { TaskHeaderActions, TaskHeaderInfo } from "./tasks/TaskHeader";

/**
 * Floats over the chat content on a flat, always-opaque `bg-canvas` — no
 * border, no blur card. `bg-canvas` matches the content below it exactly, so
 * the header stays legible once that content scrolls underneath without
 * needing the old scroll-triggered blur (see `chatScrolled`/MessageList).
 */
export function Header() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const agent = useStore(selectActiveAgent);
  const working = useStore((s) => (agent ? selectAgentWorking(s, agent.id) : false));
  const conversation = useStore(selectCurrentConversation);
  const slackUrl = conversation?.origin?.kind === "slack" ? conversation.origin.url : null;
  const task = isTask(conversation) ? conversation : null;
  // Mission control and the compare view (module 09) span every agent's tasks: no model to pick there.
  const board = useStore((s) => s.page === "mission" || s.page === "compare");
  // A project's page (module 11): its Lead (or a new chat in it) under the project's name and menu.
  const projectId = useStore((s) => (s.page === "project" ? s.projectId : null));
  const project = useProjects((s) => (projectId ? s.projects.find((p) => p.id === projectId) : undefined));

  return (
    <header className="app-drag-region absolute inset-x-0 top-0 z-10 flex h-14 shrink-0 items-center gap-1 bg-canvas px-3">
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
      {/* On desktop the agent rail already shows whose chat this is. A project's page names the project instead. */}
      {agent && !task && !board && !project && (
        <button
          type="button"
          onClick={() => navigateToAgentHome(agent.id)}
          className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-heading text-fg transition-colors hover:bg-hover md:hidden"
        >
          <Mascot spec={agent.mascot} size={24} state={working ? "working" : "idle"} title={agent.name} />
          {/* Phones show just the mascot so the model picker has room. */}
          <span className="hidden truncate sm:inline">{agent.name}</span>
        </button>
      )}
      {task ? (
        <>
          <DeviceChip agent={agent} />
          <ChatProjectCrumb chat={task} withTitle={false} />
          <TaskHeaderInfo task={task} />
        </>
      ) : board ? null : (
        <>
          <ModelPicker />
          <DeviceChip agent={agent} />
          {project ? <ProjectTitle project={project} /> : conversation && <ChatProjectCrumb chat={conversation} />}
        </>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {conversation && <TicketChip chat={conversation} />}
        {task && <TaskHeaderActions task={task} />}
        {project ? <ProjectMenu project={project} agent={agent} /> : conversation && !task && <ChatMenu chat={conversation} />}
        {slackUrl && (
          <Tip content="Open in Slack">
            <a
              href={slackUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open in Slack"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <SlackMark className="size-4" />
            </a>
          </Tip>
        )}
        {!board && <ComputerChip />}
      </div>
    </header>
  );
}
