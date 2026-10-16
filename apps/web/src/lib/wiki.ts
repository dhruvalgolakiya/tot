import type { WikiPageSummary } from "@shared/types";

/** A wiki page with its children nested, for the page-tree sidebar. */
export interface WikiTreeNode extends WikiPageSummary {
  children: WikiTreeNode[];
}

/**
 * Nest pages by `parentId` into a tree. `GET /agents/:id/wiki` already returns
 * them in display order (Overview first, then by parent/position), so this
 * only needs to group siblings — not re-sort them.
 */
export function buildWikiTree(pages: WikiPageSummary[]): WikiTreeNode[] {
  const byParent = new Map<string | null, WikiPageSummary[]>();
  for (const page of pages) {
    const siblings = byParent.get(page.parentId);
    if (siblings) siblings.push(page);
    else byParent.set(page.parentId, [page]);
  }
  const build = (parentId: string | null): WikiTreeNode[] =>
    (byParent.get(parentId) ?? []).map((page) => ({ ...page, children: build(page.id) }));
  return build(null);
}

export interface WikiHeading {
  text: string;
  level: 2 | 3;
}

const HEADING_LINE = /^(#{2,3})[ \t]+(.+)$/gm;

/** h2/h3 headings in a page's markdown, for the optional "On this page" outline. */
export function extractHeadings(content: string): WikiHeading[] {
  const headings: WikiHeading[] = [];
  for (const match of content.matchAll(HEADING_LINE)) {
    const text = match[2].replace(/[*_`]/g, "").trim();
    if (text) headings.push({ text, level: match[1].length === 2 ? 2 : 3 });
  }
  return headings;
}

/** "«matched words»" (the server's snippet markers) as plain text + highlight ranges. */
export function splitSnippet(snippet: string): { text: string; marked: boolean }[] {
  return snippet
    .split(/(«[^»]*»)/g)
    .filter((part) => part.length > 0)
    .map((part) =>
      part.startsWith("«") && part.endsWith("»") ? { text: part.slice(1, -1), marked: true } : { text: part, marked: false },
    );
}
