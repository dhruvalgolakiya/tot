import type { Agent, Persona } from "@shared/types";
import { openAgentSettings } from "../../store";
import { Mascot } from "../mascot";
import { EmptyState } from "../ui/EmptyState";
import { LedgerGroup, LedgerRow } from "../ui/Ledger";

type PersonaAgentsListProps = {
  persona: Persona;
  agents: Agent[];
};

/** Which agents work as this persona. Reassigning that happens in each agent's own settings. */
export function PersonaAgentsList({ persona, agents }: PersonaAgentsListProps) {
  const workingAgents = agents.filter((a) => persona.agentIds.includes(a.id));

  return (
    <LedgerGroup title="Agents using it" description="Change which persona an agent uses in its own settings." body="rows">
      {workingAgents.length === 0 ? (
        <EmptyState variant="quiet" title={`No agents work as ${persona.name} yet`} />
      ) : (
        workingAgents.map((agent) => (
          <LedgerRow
            key={agent.id}
            onClick={() => openAgentSettings(agent.id)}
            leading={<Mascot spec={agent.mascot} size={20} title={agent.name} />}
            title={agent.name}
          />
        ))
      )}
    </LedgerGroup>
  );
}
