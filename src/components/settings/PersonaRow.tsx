import { ChevronRight } from "lucide-react";
import type { Agent, Persona } from "@shared/types";
import { mailboxStatus } from "../../lib/personas";
import { Badge } from "../ui/Badge";
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
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-hover"
      >
        <PersonaAvatar name={persona.name} url={persona.avatarUrl} size="size-10" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-medium text-fg">{persona.name}</p>
            <Tip content={status.label}>
              <span>
                <StatusDot tone={status.tone} pulse={status.pulse} />
              </span>
            </Tip>
          </div>
          <p className="truncate text-xs text-fg-subtle">{persona.email}</p>
          {agentNames && <p className="truncate text-xs text-fg-subtle">{agentNames}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {persona.unread > 0 && (
            <Badge tone="accent" aria-label={`${persona.unread} unread`}>
              {persona.unread}
            </Badge>
          )}
          <ChevronRight className="size-4 text-fg-subtle" />
        </div>
      </button>
    </li>
  );
}
