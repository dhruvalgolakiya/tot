import { useState } from "react";
import { DropdownMenu } from "radix-ui";
import { ArrowLeft, Ellipsis, Pencil, RefreshCw, Trash, Unplug } from "lucide-react";
import type { Persona } from "@shared/types";
import { api } from "../../lib/api";
import { mailboxStatus } from "../../lib/personas";
import { notifyError, removePersona, setPersona, useStore } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { IconButton } from "../ui/IconButton";
import { StatusDot } from "../ui/StatusDot";
import { Tip } from "../ui/Tip";
import { PersonaAgentsList } from "./PersonaAgentsList";
import { PersonaAvatar } from "./PersonaAvatar";
import { PersonaEmailTasks } from "./PersonaEmailTasks";
import { PersonaFormModal } from "./PersonaFormModal";
import { PersonaGitHubCard } from "./PersonaGitHubCard";
import { PersonaInbox } from "./PersonaInbox";
import { PersonaMailboxConnect } from "./PersonaMailboxConnect";

type PersonaDetailProps = {
  persona: Persona;
  onBack: () => void;
};

/** A persona's own sub-page: mailbox, email tasks, GitHub, and the agents using it. */
export function PersonaDetail({ persona, onBack }: PersonaDetailProps) {
  const agents = useStore((s) => s.agents);
  const status = mailboxStatus(persona.mailbox);
  const [renaming, setRenaming] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [disconnectingMailbox, setDisconnectingMailbox] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const hasMailbox = persona.mailbox.state === "connected" || persona.mailbox.state === "error";

  async function checkForMail() {
    setRefreshing(true);
    try {
      setPersona(await api.refreshPersonaMailbox(persona.id));
    } catch (error) {
      notifyError(error);
    } finally {
      setRefreshing(false);
    }
  }

  async function disconnectMailbox() {
    setDisconnectingMailbox(true);
    try {
      setPersona(await api.disconnectPersonaMailbox(persona.id));
    } catch (error) {
      notifyError(error);
    } finally {
      setDisconnectingMailbox(false);
    }
  }

  async function deletePersona() {
    setDeleting(true);
    try {
      await api.deletePersona(persona.id);
      removePersona(persona.id);
      onBack();
    } catch (error) {
      notifyError(error);
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-3">
        <IconButton label="Back to personas" onClick={onBack}>
          <ArrowLeft />
        </IconButton>
        <PersonaAvatar name={persona.name} size="size-10" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-heading text-fg-strong">{persona.name}</p>
          <p className="truncate text-xs text-fg-subtle">{persona.email}</p>
        </div>
        <Tip content={status.label}>
          <span>
            <StatusDot tone={status.tone} pulse={status.pulse} />
          </span>
        </Tip>
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <IconButton label={`More options for ${persona.name}`} size="sm">
              <Ellipsis />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={4} className="menu w-56">
              <DropdownMenu.Item className="menu-item" onSelect={() => setRenaming(true)}>
                <Pencil className="size-4 text-fg-muted" /> Rename / Change email
              </DropdownMenu.Item>
              {persona.mailbox.state === "connected" && (
                <DropdownMenu.Item className="menu-item" disabled={refreshing} onSelect={() => void checkForMail()}>
                  <RefreshCw className="size-4 text-fg-muted" /> {refreshing ? "Checking…" : "Check for new mail"}
                </DropdownMenu.Item>
              )}
              {hasMailbox && (
                <DropdownMenu.Item className="menu-item" disabled={disconnectingMailbox} onSelect={() => void disconnectMailbox()}>
                  <Unplug className="size-4 text-fg-muted" /> Disconnect mailbox
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Separator className="menu-separator" />
              <DropdownMenu.Item className="menu-item menu-item-danger" onSelect={() => setConfirmDeleteOpen(true)}>
                <Trash className="size-4" /> Delete persona
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      <section className="border-t border-hairline pt-6">
        {persona.mailbox.state === "connected" ? <PersonaInbox persona={persona} /> : <PersonaMailboxConnect persona={persona} />}
      </section>

      <section className="border-t border-hairline pt-6">
        <PersonaEmailTasks persona={persona} agents={agents} />
      </section>

      <section className="border-t border-hairline pt-6">
        <PersonaGitHubCard persona={persona} />
      </section>

      <section className="border-t border-hairline pt-6">
        <PersonaAgentsList persona={persona} agents={agents} />
      </section>

      <PersonaFormModal open={renaming} onOpenChange={setRenaming} persona={persona} />

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title="Delete persona?"
        description={
          <>
            Agents working as <span className="font-medium text-fg">{persona.name}</span> go back to working as you. Its
            password, GitHub token and stored mail are forgotten. This can&rsquo;t be undone.
          </>
        }
        confirmLabel={deleting ? "Deleting…" : "Delete"}
        onConfirm={() => void deletePersona()}
      />
    </div>
  );
}
