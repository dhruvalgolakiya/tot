import type { Agent, Brain, BrainAccess, WikiAuthor, WikiPageSummary } from "@shared/types";

/**
 * The Knowledge page's helpers, ported from the web's src/lib/brains.ts and src/lib/wiki.ts (Metro bundles only
 * `mobile/`), so brains, the page tree and search snippets read the same on the phone.
 */

/** What an agent may do in a brain, or null when the brain isn't its own and isn't attached to it. */
export function accessOf(brain: Brain, agentId: string): BrainAccess | null {
  if (brain.ownerAgentId === agentId || brain.allAgents) return "write";
  if (brain.ownerAgentId) return null;
  return brain.agents.find((a) => a.agentId === agentId)?.access ?? null;
}

/** The brains an agent uses: its notebook first, then shared ones by name. */
export function brainsOf(brains: Brain[], agentId: string): Brain[] {
  const mine = brains.filter((brain) => accessOf(brain, agentId) !== null);
  return mine.sort((a, b) => Number(Boolean(b.ownerAgentId)) - Number(Boolean(a.ownerAgentId)) || a.name.localeCompare(b.name));
}

/** "Notebook" for the viewing agent's own; "Tot's notebook" for another agent's; otherwise the brain's name. */
export function brainName(brain: Brain, agents: Agent[], viewerAgentId?: string | null): string {
  if (brain.kind !== "notebook") return brain.name;
  if (brain.ownerAgentId === viewerAgentId) return "Notebook";
  const owner = agents.find((agent) => agent.id === brain.ownerAgentId);
  return owner ? `${owner.name}'s notebook` : "Notebook";
}

/** A page in the tree, with how deep it sits. */
export interface TreeRow extends WikiPageSummary {
  depth: number;
  hasChildren: boolean;
}

/**
 * The page tree as rows (pages, then each repo's docs), nested by `parentId`. The list comes in display order
 * (Overview first, then by parent and position), so only siblings are grouped. A page that heads a repo's docs is
 * pulled out under Repos with its subtree, wherever it sits, as the web's WikiTree does.
 */
export function pageTree(pages: WikiPageSummary[], collapsed: Set<string>): { pages: TreeRow[]; repos: TreeRow[] } {
  const byParent = new Map<string | null, WikiPageSummary[]>();
  for (const page of pages) {
    const siblings = byParent.get(page.parentId);
    if (siblings) siblings.push(page);
    else byParent.set(page.parentId, [page]);
  }
  const out = { pages: [] as TreeRow[], repos: [] as TreeRow[] };
  const walk = (parentId: string | null, depth: number, into: TreeRow[]) => {
    for (const page of byParent.get(parentId) ?? []) {
      const target = page.repo ? out.repos : into;
      const rowDepth = page.repo ? 0 : depth;
      const hasChildren = Boolean(byParent.get(page.id)?.length);
      target.push({ ...page, title: page.repo ?? page.title, depth: rowDepth, hasChildren });
      if (!collapsed.has(page.id)) walk(page.id, rowDepth + 1, target);
    }
  };
  walk(null, 0, out.pages);
  return out;
}

/** "«matched words»" (the server's snippet markers) as plain text and highlighted parts. */
export function splitSnippet(snippet: string): { text: string; marked: boolean }[] {
  return snippet
    .split(/(«[^»]*»)/g)
    .filter((part) => part.length > 0)
    .map((part) => (part.startsWith("«") && part.endsWith("»") ? { text: part.slice(1, -1), marked: true } : { text: part, marked: false }));
}

/** Who last changed a page, as the web's PageMeta says it. */
export function authorText(author: WikiAuthor, agentName: string): string {
  return author === "user" ? "by you" : author === "agent" ? `by ${agentName}` : "after a chat";
}

export const projectMemoryRepo = (slug: string) => `projects/${slug}`;
