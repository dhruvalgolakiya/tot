import { useState, type FormEvent } from "react";
import { X } from "lucide-react";
import type { Agent, Persona } from "@shared/types";
import { api } from "../../lib/api";
import { isValidEmail } from "../../lib/personas";
import { notifyError, setPersona } from "../../store";
import { LedgerField, LedgerGroup } from "../ui/Ledger";
import { Select } from "../ui/Select";

type PersonaEmailTasksProps = {
  persona: Persona;
  agents: Agent[];
};

/** Who can give this persona's mailbox tasks by email, and which agent answers them. */
export function PersonaEmailTasks({ persona, agents }: PersonaEmailTasksProps) {
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const workingAgents = agents.filter((a) => persona.agentIds.includes(a.id));
  const firstAgentId = workingAgents[0]?.id ?? null;

  async function patch(body: { allowedSenders?: string[]; defaultAgentId?: string | null }) {
    setBusy(true);
    try {
      setPersona(await api.updatePersona(persona.id, body));
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(false);
    }
  }

  function addSender(event: FormEvent) {
    event.preventDefault();
    const address = draft.trim().toLowerCase();
    if (!address) return;
    if (!isValidEmail(address)) {
      setDraftError("That doesn't look like an email address.");
      return;
    }
    if (persona.allowedSenders.includes(address)) {
      setDraftError("Already in the list.");
      return;
    }
    setDraft("");
    setDraftError(null);
    void patch({ allowedSenders: [...persona.allowedSenders, address] });
  }

  function removeSender(address: string) {
    void patch({ allowedSenders: persona.allowedSenders.filter((a) => a !== address) });
  }

  return (
    <LedgerGroup title="Email tasks" description="Who can give tasks by email">
      <LedgerField
        stacked
        title="Allowed senders"
        description="Only authenticated mail from these addresses becomes a chat and gets answered back. Everything else (including a spoofed From) is just stored for the agent to read."
        control={
          <>
            <div className="flex flex-wrap gap-1.5">
              {persona.allowedSenders.map((address) => (
                <span key={address} className="inline-flex items-center gap-1.5 rounded-full bg-fill px-2.5 py-1 text-xs text-fg">
                  {address}
                  <button
                    type="button"
                    onClick={() => removeSender(address)}
                    aria-label={`Remove ${address}`}
                    disabled={busy}
                    className="text-fg-subtle transition-colors hover:text-fg disabled:pointer-events-none"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              {persona.allowedSenders.length === 0 && <span className="text-xs text-fg-subtle">Nobody yet</span>}
            </div>

            <form onSubmit={addSender} className="mt-2.5 flex items-start gap-2">
              <div className="flex-1">
                <input
                  type="email"
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setDraftError(null);
                  }}
                  placeholder="name@example.com"
                  aria-label="Add an allowed sender"
                  autoComplete="off"
                  className="input-sm w-full rounded-lg"
                />
                {draftError && <p className="mt-1 text-xs leading-relaxed text-danger">{draftError}</p>}
              </div>
              <button type="submit" disabled={!draft.trim() || busy} className="link-muted shrink-0 pt-1.5 text-xs disabled:pointer-events-none disabled:opacity-50">
                Add
              </button>
            </form>
          </>
        }
      />

      {workingAgents.length > 0 ? (
        <LedgerField
          title="Default agent"
          htmlFor="persona-default-agent"
          description="Answers emailed tasks when more than one agent works as this persona."
          control={
            <Select
              id="persona-default-agent"
              value={persona.defaultAgentId ?? firstAgentId ?? ""}
              onValueChange={(agentId) => void patch({ defaultAgentId: agentId === firstAgentId ? null : agentId })}
              disabled={busy}
              className="h-9 w-56 rounded-xl"
              options={workingAgents.map((agent) => ({
                value: agent.id,
                label: agent.id === firstAgentId ? `${agent.name} (default)` : agent.name,
              }))}
            />
          }
        />
      ) : (
        <LedgerField title="Default agent" description={`No agents work as ${persona.name} yet — add one in its agent settings.`} />
      )}
    </LedgerGroup>
  );
}
