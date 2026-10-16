import type { Agent, AgentIsland } from "./types.ts";

/** The islands agents work from, in the order new agents get them; names as on the landing page's crew. */
export const AGENT_ISLANDS: readonly { id: AgentIsland; name: string }[] = [
  { id: "workshop", name: "the workshop" },
  { id: "observatory", name: "the observatory" },
  { id: "tower", name: "the signal tower" },
  { id: "greenhouse", name: "the greenhouse" },
];

export function isAgentIsland(value: unknown): value is AgentIsland {
  return AGENT_ISLANDS.some((island) => island.id === value);
}

/** The island for the agent at this position in creation order (round-robin). */
export function defaultIsland(index: number): AgentIsland {
  return AGENT_ISLANDS[((index % AGENT_ISLANDS.length) + AGENT_ISLANDS.length) % AGENT_ISLANDS.length]!.id;
}

export function islandName(island: AgentIsland | undefined): string {
  return AGENT_ISLANDS.find((i) => i.id === island)?.name ?? AGENT_ISLANDS[0]!.name;
}

/** "the workshop" unless the agent has a tagline of its own. */
export function agentTagline(agent: Pick<Agent, "island" | "tagline">): string {
  return agent.tagline?.trim() || islandName(agentIsland(agent));
}

/** The agent's island; the first one for an agent from a paired device that predates islands. */
export function agentIsland(agent: Pick<Agent, "island">): AgentIsland {
  return isAgentIsland(agent.island) ? agent.island : AGENT_ISLANDS[0]!.id;
}

/** The island's picture in apps/web/public/hero/islands/: at night for dark mode, at dawn for light mode. */
export function islandImage(island: AgentIsland, dawn: boolean): string {
  return `/hero/islands/${island}${dawn ? "-dawn" : ""}.webp`;
}
