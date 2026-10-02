import type { Agent, Brain, BrainAccess } from "@shared/types";

/** What an agent may do in a brain, or null when the brain isn't its own and isn't attached to it. */
export function accessOf(brain: Brain, agentId: string): BrainAccess | null {
  if (brain.ownerAgentId === agentId || brain.allAgents) return "write";
  if (brain.ownerAgentId) return null;
  return brain.agents.find((a) => a.agentId === agentId)?.access ?? null;
}

/** The brains an agent uses — its notebook first, then shared ones by name — and the shared ones it doesn't. */
export function brainsFor(brains: Brain[], agentId: string): { mine: Brain[]; others: Brain[] } {
  const mine = brains.filter((brain) => accessOf(brain, agentId) !== null);
  mine.sort((a, b) => Number(Boolean(b.ownerAgentId)) - Number(Boolean(a.ownerAgentId)) || a.name.localeCompare(b.name));
  // Other agents' notebooks are private to them; only shared brains can be attached.
  const others = brains.filter((brain) => !brain.ownerAgentId && accessOf(brain, agentId) === null);
  return { mine, others };
}

/** "Notebook" for the viewing agent's own; "Tot's notebook" for another agent's; otherwise the brain's name. */
export function brainName(brain: Brain, agents: Agent[], viewerAgentId?: string | null): string {
  if (brain.kind !== "notebook") return brain.name;
  if (brain.ownerAgentId === viewerAgentId) return "Notebook";
  const owner = agents.find((agent) => agent.id === brain.ownerAgentId);
  return owner ? `${owner.name}'s notebook` : "Notebook";
}

/** Who can use a brain, in a few words. */
export function brainAudience(brain: Brain, agents: Agent[]): string {
  if (brain.ownerAgentId) return "Private";
  if (brain.allAgents) return "All agents";
  const names = brain.agents.map((a) => agents.find((agent) => agent.id === a.agentId)?.name).filter(Boolean);
  if (!names.length) return "No agents yet";
  return names.length <= 2 ? names.join(", ") : `${names.length} agents`;
}
