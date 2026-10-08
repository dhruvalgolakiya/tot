import { useRef, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { Archive, Bell, Brain, Ellipsis, FolderGit2, GraduationCap, ScrollText, SlidersHorizontal, SquarePen, Wrench } from "lucide-react";
import type { Agent, Project } from "@shared/types";
import { api } from "../../lib/api";
import { archiveProject, isCodeProject } from "../../lib/projects";
import { navigateToAgentHome, navigateToConversation, navigateToWiki, newChatInProject, notifyError, selectActiveAgentId, useStore } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { IconButton } from "../ui/IconButton";
import { Modal, ModalBody } from "../ui/Modal";
import { InstructionsDialog, ProjectSettingsDialog, WorktreeSetupDialog } from "./ProjectDialogs";
import { ProjectRepos } from "./ProjectRepos";
import { ProjectSubscriptionsDialog } from "./ProjectSubscriptionsDialog";

type Dialog = "repos" | "instructions" | "subscriptions" | "settings" | "worktree" | "archive";

/**
 * The project page's one menu: New chat, Repos, Knowledge (the Knowledge page, on this project), then Instructions,
 * Subscriptions (module 12), Learn this project, Worktree setup, Settings, Archive. The page itself is only the Lead chat.
 */
export function ProjectMenu({ project, agent }: { project: Project; agent: Agent | undefined }) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [learning, setLearning] = useState(false);
  const activeAgentId = useStore(selectActiveAgentId);
  const knowledgeAgentId = agent?.id ?? activeAgentId;
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
            {!project.archived && (
              <DropdownMenu.Item className="menu-item" onSelect={() => newChatInProject(project.id)}>
                <SquarePen className="size-4 text-fg-muted" /> New chat
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item className="menu-item" onSelect={() => (pending.current = "repos")}>
              <FolderGit2 className="size-4 text-fg-muted" /> Repos
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="menu-item"
              disabled={!knowledgeAgentId}
              onSelect={() => knowledgeAgentId && navigateToWiki(knowledgeAgentId, null, project.brainId)}
            >
              <Brain className="size-4 text-fg-muted" /> Knowledge
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="menu-separator" />
            <DropdownMenu.Item className="menu-item" onSelect={() => (pending.current = "instructions")}>
              <ScrollText className="size-4 text-fg-muted" /> Instructions
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={() => (pending.current = "subscriptions")}>
              <Bell className="size-4 text-fg-muted" /> Subscriptions
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

      <Modal open={dialog === "repos"} onOpenChange={close} title="Repos" description={`The code ${project.name}'s tasks work in.`} className="max-w-2xl">
        <ModalBody>
          <ProjectRepos project={project} />
        </ModalBody>
      </Modal>
      <InstructionsDialog project={project} open={dialog === "instructions"} onOpenChange={close} />
      <ProjectSubscriptionsDialog project={project} open={dialog === "subscriptions"} onOpenChange={close} />
      <ProjectSettingsDialog project={project} open={dialog === "settings"} onOpenChange={close} />
      {isCodeProject(project) && <WorktreeSetupDialog project={project} open={dialog === "worktree"} onOpenChange={close} />}
      <ConfirmDialog
        open={dialog === "archive"}
        onOpenChange={close}
        title={`Archive ${project.name}?`}
        description="It leaves the sidebar for every agent. Its chats and its knowledge stay."
        confirmLabel="Archive"
        onConfirm={() => void archive()}
      />
    </>
  );
}
