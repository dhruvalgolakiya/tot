import type { Role, Tier } from "@tot/shared/types";

export const ROLE_LABELS: Record<Role, string> = {
  explorer: "Explorer",
  planner: "Planner",
  implementer: "Implementer",
  tester: "Tester",
  reviewer: "Reviewer",
  researcher: "Researcher",
  writer: "Writer",
};

export const TIER_LABELS: Record<Tier, string> = { fast: "Fast", standard: "Standard", deep: "Deep" };

export const TIERS: Tier[] = ["fast", "standard", "deep"];
export const ROLES = Object.keys(ROLE_LABELS) as Role[];

export const TIER_DESCRIPTIONS: Record<Tier, string> = {
  fast: "Searching, classifying, quick answers",
  standard: "Most work: research, tests, writing",
  deep: "The hard change",
};

/** "Researcher · standard" for a task's role and tier, when it has a role. */
export function roleLine(role: Role | null, tier: Tier | null): string | null {
  if (!role) return null;
  return tier ? `${ROLE_LABELS[role]} · ${tier}` : ROLE_LABELS[role];
}
