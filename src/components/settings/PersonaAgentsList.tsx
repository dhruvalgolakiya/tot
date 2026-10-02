import { ChevronRight } from "lucide-react";
import type { Agent, Persona } from "@shared/types";
import { openAgentSettings } from "../../store";
import { Mascot } from "../mascot";
import { SectionHeader } from "../ui/SectionHeader";

type PersonaAgentsListProps = {
  persona: Persona;
  agents: Agent[];
};

/** Which agents work as this persona. Reassigning that happens in each agent's own settings. */
export function PersonaAgentsList({ persona, agents }: PersonaAgentsListProps) {
  const workingAgents = agents.filter((a) => persona.agentIds.includes(a.id));

  return (
    <div className="space-y-3">
      <SectionHeader title="Agents using it" description="Change which persona an agent uses in its own settings." />
      {workingAgents.length === 0 ? (
        <p className="text-sm text-fg-subtle">No agents work as {persona.name} yet.</p>
      ) : (
        <ul className="space-y-0.5">
          {workingAgents.map((agent) => (
            <li key={agent.id}>
              <button
                type="button"
                onClick={() => openAgentSettings(agent.id)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-fg transition-colors hover:bg-hover"
              >
                <Mascot spec={agent.mascot} size={24} title={agent.name} />
                <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                <ChevronRight className="size-4 shrink-0 text-fg-subtle" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
