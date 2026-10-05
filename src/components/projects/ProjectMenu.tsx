import { useRef, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { Archive, Brain, Ellipsis, GraduationCap, ScrollText, SlidersHorizontal, Wrench } from "lucide-react";
import type { Agent, Project } from "@shared/types";
import { api } from "../../lib/api";
import { archiveProject, isCodeProject } from "../../lib/projects";
import { navigateToAgentHome, navigateToConversation, navigateToWiki, notifyError } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { IconButton } from "../ui/IconButton";
import { InstructionsDialog, ProjectSettingsDialog, WorktreeSetupDialog } from "./ProjectDialogs";

type Dialog = "instructions" | "settings" | "worktree" | "archive";

/** The project page's one menu: Instructions, Brain, Learn this project, Worktree setup, Settings, Archive. */
export function ProjectMenu({ project, agent }: { project: Project; agent: Agent | undefined }) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [learning, setLearning] = useState(false);
  // Dialogs open once the menu has closed: a closing Radix menu would take focus back from them.
  const pending = useRef<Dialog | null>(null);
  const close = (open: boolean) => !open && setDialog(null);

  async function learn() {
    if (!agent || learning) return;
    setLearning(true);
    try {
      const { conversationId } = await api.learnProject(project.id, agent.id);
      navigateToConversation(conversationId);
    } catch (error) {
      notifyError(error);
    } finally {
      setLearning(false);
    }
  }

  async function archive() {
    try {
      await archiveProject(project.id);
      if (agent) navigateToAgentHome(agent.id);
    } catch (error) {
      notifyError(error);
    }
  }

  return (
    <>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <IconButton label="Project options">
            <Ellipsis />
          </IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="menu w-56"
            onCloseAutoFocus={(event) => {
              const next = pending.current;
              pending.current = null;
              if (!next) return;
              event.preventDefault();
              setDialog(next);
            }}
          >
            <DropdownMenu.Item className="menu-item" onSelect={() => (pending.current = "instructions")}>
              <ScrollText className="size-4 text-fg-muted" /> Instructions
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="menu-item"
              disabled={!agent}
              onSelect={() => agent && navigateToWiki(agent.id, null, project.brainId)}
            >
              <Brain className="size-4 text-fg-muted" /> Brain
            </DropdownMenu.Item>
            {isCodeProject(project) && (
              <DropdownMenu.Item className="menu-item" disabled={!agent || learning} onSelect={() => void learn()}>
                <GraduationCap className="size-4 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate">{learning ? "Starting…" : "Learn this project"}</span>
              </DropdownMenu.Item>
            )}
            {isCodeProject(project) && (
              <DropdownMenu.Item className="menu-item" onSelect={() => (pending.current = "worktree")}>
                <Wrench className="size-4 text-fg-muted" /> Worktree setup
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item className="menu-item" onSelect={() => (pending.current = "settings")}>
              <SlidersHorizontal className="size-4 text-fg-muted" /> Settings
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="menu-separator" />
            <DropdownMenu.Item className="menu-item menu-item-danger" onSelect={() => (pending.current = "archive")}>
              <Archive className="size-4" /> Archive
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <InstructionsDialog project={project} open={dialog === "instructions"} onOpenChange={close} />
      <ProjectSettingsDialog project={project} open={dialog === "settings"} onOpenChange={close} />
      {isCodeProject(project) && <WorktreeSetupDialog project={project} open={dialog === "worktree"} onOpenChange={close} />}
      <ConfirmDialog
        open={dialog === "archive"}
        onOpenChange={close}
        title={`Archive ${project.name}?`}
        description="It leaves the sidebar for every agent. Its chats and its brain stay."
        confirmLabel="Archive"
        onConfirm={() => void archive()}
      />
    </>
  );
}
