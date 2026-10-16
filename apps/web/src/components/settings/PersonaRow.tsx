import type { Agent, Persona } from "@shared/types";
import { mailboxStatus } from "../../lib/personas";
import { Badge } from "../ui/Badge";
import { LedgerRow } from "../ui/Ledger";
import { StatusDot } from "../ui/StatusDot";
import { Tip } from "../ui/Tip";
import { PersonaAvatar } from "./PersonaAvatar";

type PersonaRowProps = {
  persona: Persona;
  agents: Agent[];
  onClick: () => void;
};

/** One row in the personas list: avatar, name, email, mailbox status, unread count, and who uses it. */
export function PersonaRow({ persona, agents, onClick }: PersonaRowProps) {
  const status = mailboxStatus(persona.mailbox);
  const agentNames = agents
    .filter((a) => persona.agentIds.includes(a.id))
    .map((a) => a.name)
    .join(", ");

  return (
    <LedgerRow
      onClick={onClick}
      leading={<PersonaAvatar name={persona.name} url={persona.avatarUrl} size="size-5" />}
      title={
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="truncate">{persona.name}</span>
          <Tip content={status.label}>
            <span>
              <StatusDot tone={status.tone} pulse={status.pulse} />
            </span>
          </Tip>
        </span>
      }
      detail={agentNames ? `${persona.email} · ${agentNames}` : persona.email}
      trailing={
        persona.unread > 0 ? (
          <Badge tone="accent" aria-label={`${persona.unread} unread`}>
            {persona.unread}
          </Badge>
        ) : undefined
      }
    />
  );
}
