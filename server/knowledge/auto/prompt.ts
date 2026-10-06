import type { Project, WikiPage } from "../../../shared/types.ts";
import { MAX_PAGE_CHARS, wiki } from "../../data/wiki.ts";
import { repoEntries } from "../../memory/index.ts";
import { entryText } from "../../memory/repo.ts";
import { hideSecrets, secretKind } from "../../trust/secrets.ts";
import { docScope, knowledgeRepo, type OutlinePage } from "./repos.ts";

/**
 * Module 11, lane C: what the light model sees for one auto-update, and checking what it answers. It's shown the
 * repo's doc pages (an index, plus in full the head page and the pages the change touches, found by the paths it
 * changed and by keyword), the project's facts, and the change (a landed task's diff, or the commits a base branch
 * moved by). It answers with at most 8 JSON operations. Each is checked on its own: only pages shown in full are
 * updated, only facts shown, parents from the index; no secrets; never a page shrunk by more than 60%.
 */

export const MAX_OPS = 8;
/** A page may not lose more than this share of its text in one update. */
export const MAX_SHRINK = 0.6;
const PAGES_IN_FULL = 5;
const PAGES_BUDGET = 24_000;
const INDEX_BUDGET = 8000;
const FACTS_BUDGET = 6000;
/** Pages searched for the paths a change touched. */
const SCAN_PAGES = 300;

export type KnowledgeOp =
  | { op: "page_update"; id: string; content: string; summary?: string }
  | { op: "page_create"; parent: string | null; title: string; summary: string; content: string }
  | { op: "fact_add"; text: string }
  | { op: "fact_update"; id: string; text: string };

export interface Refusal {
  op: unknown;
  reason: string;
}

/** A page as the model was shown it: what an update is checked against when it's applied. */
export interface PageSnapshot {
  id: string;
  title: string;
  summary: string;
  content: string;
  pinned: boolean;
}

/** What the model was shown, for checking its answer. */
export interface Shown {
  brainId: string;
  /** Pages shown in full: the only ones it may update. */
  pages: Map<string, PageSnapshot>;
  /** Pages in the index: possible parents. */
  index: Map<string, string>;
  /** Facts shown, by key, with their text then. */
  facts: Map<string, string>;
  /** Where a new page goes when the model names no parent: the repo's head page, or the top level. */
  home: string | null;
}

/** What changed, as the model reads it, and what to look for in the docs. */
export interface Material {
  /** The `<change>` block. */
  text: string;
  /** Files it touched: pages mentioning them are shown in full. */
  paths: string[];
  /** Words to find related pages by (a title, a summary, commit subjects). */
  words: string;
}

export const SYSTEM = `You keep a software project's knowledge base current in TOT, an AI agent app. It has documentation pages (markdown) and short facts, one line each, that agents read before they work on the project. Some code just changed. Update only what the change made out of date, or newly worth knowing, then reply with JSON only.`;

const INSTRUCTIONS = `What to do:
- Pages are documentation: how the code works, where things live, conventions, commands. When the change makes a page shown in full wrong or incomplete, update it: return its complete new content, keeping everything that's still true. Never cut a page down to a summary.
- Create a page only for a substantial area of the code the docs don't cover, with a short title, a one-line summary, and its parent's id from the index.
- Facts are one short line each: how to build, test and ship, conventions, gotchas. Add one only when the change establishes it; update one the change made wrong.
- Describe how things are now, as documentation, not the change as a story ("this task added…"). File paths in backticks.
- Never copy secrets (passwords, tokens, keys).
- Usually 0–3 operations; at most ${MAX_OPS}. If the docs already cover it, return none.

Operations (use only ids shown above):
- {"op": "page_update", "id": "<id of a page shown in full>", "content": "...", "summary": "<optional: a new one-line summary>"}
- {"op": "page_create", "parent": "<page id from the index, or null>", "title": "...", "summary": "...", "content": "..."}
- {"op": "fact_add", "text": "..."}
- {"op": "fact_update", "id": "<fact id>", "text": "..."}

Reply with JSON only:
{"ops": [...], "notes": "<one line: what you changed and why>"}`;

const attr = (text: string) => text.replace(/"/g, "'").replace(/\s+/g, " ").trim();

const snapshot = (page: WikiPage): PageSnapshot => ({ id: page.id, title: page.title, summary: page.summary, content: page.content, pinned: page.pinned });

/** The head page (or Overview) first, then pages naming the most changed files, then related ones; within budget. */
function pagesInFull(project: Project, scope: OutlinePage[], home: OutlinePage | null, material: Material): WikiPage[] {
  const ids = new Set(scope.map((page) => page.id));
  const needles = [...new Set(material.paths.flatMap((path) => [path, path.split("/").pop() ?? ""]))].filter((needle) => needle.length >= 4).slice(0, 200);
  const scored: { page: WikiPage; hits: number }[] = [];
  for (const summary of scope.slice(0, SCAN_PAGES)) {
    if (summary.id === home?.id) continue;
    const page = wiki.get(summary.id);
    if (!page) continue;
    const hits = needles.filter((needle) => page.content.includes(needle)).length;
    if (hits) scored.push({ page, hits });
  }
  scored.sort((a, b) => b.hits - a.hits);
  const related = wiki.relevant(project.brainId, material.words, PAGES_IN_FULL * 2).filter((page) => ids.has(page.id));
  const homePage = home ? wiki.get(home.id) : null;
  const picked: WikiPage[] = [];
  const seen = new Set<string>();
  let used = 0;
  const most = PAGES_IN_FULL + (homePage ? 1 : 0);
  for (const page of [...(homePage ? [homePage] : []), ...scored.map((s) => s.page), ...related]) {
    if (seen.has(page.id) || picked.length >= most) continue;
    seen.add(page.id);
    if (used + page.content.length > PAGES_BUDGET) continue;
    used += page.content.length;
    picked.push(page);
  }
  return picked;
}

/** The project's facts, MEMORY.md first, each "- text (id)", within budget. */
function factsBlock(project: Project): { text: string; facts: Map<string, string> } {
  const facts = new Map<string, string>();
  const lines: string[] = [];
  let used = 0;
  let file = "";
  for (const entry of repoEntries(knowledgeRepo(project))) {
    const line = `- ${hideSecrets(entry.text)} (${entry.key})`;
    const heading = entry.path !== file ? `[${entry.path}]` : "";
    if (used + line.length + heading.length > FACTS_BUDGET) break;
    if (heading) lines.push(heading);
    file = entry.path;
    used += line.length + heading.length;
    lines.push(line);
    facts.set(entry.key, entry.text);
  }
  return { text: lines.join("\n"), facts };
}

/** The prompt for one update, and what it showed. */
export function buildPrompt(project: Project, repoName: string | null, material: Material): { prompt: string; shown: Shown } {
  const { pages: scope, head, home } = docScope(project, repoName);
  const full = pagesInFull(project, scope, home, material);
  const index: string[] = [];
  const indexed = new Map<string, string>();
  let used = 0;
  for (const page of scope) {
    const line = `${"  ".repeat(Math.max(0, page.depth - (head?.depth ?? 0)))}- ${page.title} (${page.id})${page.summary ? ` — ${page.summary}` : ""}`;
    if ((used += line.length) > INDEX_BUDGET) break;
    index.push(line);
    indexed.set(page.id, page.title);
  }
  const { text: facts, facts: shownFacts } = factsBlock(project);
  const pageBlocks = full.map((page) => `<page id="${page.id}" title="${attr(page.title)}" summary="${attr(page.summary)}">\n${page.content || "(empty)"}\n</page>`);
  const prompt = `<project name="${attr(project.name)}"${repoName ? ` repo="${attr(repoName)}"` : ""}>
<index note="${head ? `the ${attr(repoName ?? "")} repo's pages` : "the project's pages"}: title (id) — summary">
${index.join("\n") || "(no pages yet)"}
</index>
<pages>
${pageBlocks.join("\n") || "(none)"}
</pages>
<facts note="one per line, with its id">
${facts || "(none yet)"}
</facts>
</project>

${material.text}

${INSTRUCTIONS}`;
  return {
    prompt,
    shown: {
      brainId: project.brainId,
      pages: new Map(full.map((page) => [page.id, snapshot(page)])),
      index: indexed,
      facts: shownFacts,
      home: head?.id ?? null,
    },
  };
}

/** Pulls the operations out of the model's reply (tolerates code fences and stray prose). */
export function parseOps(raw: string): unknown[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("The knowledge update's reply had no JSON.");
  const parsed = JSON.parse(raw.slice(start, end + 1)) as { ops?: unknown };
  if (!Array.isArray(parsed.ops)) throw new Error("The knowledge update's reply had no list of operations.");
  return parsed.ops;
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

export const SECRET_REFUSAL = "That looks like a secret; knowledge never stores secrets.";

/** Whether any of these texts holds something shaped like a secret (a key, one of TOT's own, a password written out). */
const secretIn = (...texts: string[]) => texts.some((text) => secretKind(text) !== null);

/**
 * Checks the model's operations against what it was shown. Each bad one is refused on its own: past the 8th, an
 * id it wasn't shown (or used twice), a secret, a page shrunk by more than 60%, a page over the size limit, an
 * empty field. Whether a page or fact changed since it was read is checked again when it's applied.
 */
export function checkOps(raw: unknown[], shown: Shown): { ops: KnowledgeOp[]; refused: Refusal[] } {
  const ops: KnowledgeOp[] = [];
  const refused: Refusal[] = [];
  const used = new Set<string>();
  for (const item of raw) {
    const v = (item ?? {}) as Record<string, unknown>;
    const refuse = (reason: string) => refused.push({ op: item, reason });
    if (ops.length >= MAX_OPS) {
      refuse(`More than ${MAX_OPS} operations.`);
      continue;
    }
    if (v.op === "page_update") {
      const id = str(v.id);
      const page = shown.pages.get(id);
      const content = str(v.content).replace(/\r\n/g, "\n").trim();
      const summary = str(v.summary).trim() || undefined;
      if (!page) refuse(shown.index.has(id) ? `Page ${id} wasn't shown in full, so it can't be updated.` : `Unknown page "${id}".`);
      else if (used.has(id)) refuse(`Page ${id} is in two operations.`);
      else if (!content) refuse("No content.");
      else if (content.length > MAX_PAGE_CHARS) refuse(`“${page.title}” would be longer than a page can be.`);
      else if (content.length < page.content.length * (1 - MAX_SHRINK)) refuse(`That would cut “${page.title}” by more than ${MAX_SHRINK * 100}%.`);
      else if (secretIn(content, summary ?? "")) refuse(SECRET_REFUSAL);
      else {
        used.add(id);
        ops.push({ op: "page_update", id, content, ...(summary ? { summary } : {}) });
      }
    } else if (v.op === "page_create") {
      const title = str(v.title).replace(/\s+/g, " ").trim();
      const summary = str(v.summary).replace(/\s+/g, " ").trim();
      const content = str(v.content).replace(/\r\n/g, "\n").trim();
      const parentRef = str(v.parent).trim();
      const parent = !parentRef || parentRef === "null" ? shown.home : shown.index.has(parentRef) ? parentRef : undefined;
      if (!title || !summary || !content) refuse("A new page needs a title, a summary and content.");
      else if (parent === undefined) refuse(`Unknown parent page "${parentRef}".`);
      else if (content.length > MAX_PAGE_CHARS) refuse(`“${title}” would be longer than a page can be.`);
      else if (secretIn(title, summary, content)) refuse(SECRET_REFUSAL);
      else ops.push({ op: "page_create", parent, title, summary, content });
    } else if (v.op === "fact_add" || v.op === "fact_update") {
      const id = str(v.id);
      const text = entryText(str(v.text));
      if (v.op === "fact_update" && !shown.facts.has(id)) refuse(`Unknown fact "${id}".`);
      else if (v.op === "fact_update" && used.has(`fact:${id}`)) refuse(`Fact ${id} is in two operations.`);
      else if (text.length < 2) refuse("No text.");
      else if (text.length > 1000) refuse("A fact is one short line.");
      else if (secretIn(text)) refuse(SECRET_REFUSAL);
      else if (v.op === "fact_update") {
        used.add(`fact:${id}`);
        ops.push({ op: "fact_update", id, text });
      } else ops.push({ op: "fact_add", text });
    } else {
      refuse(`Unknown operation "${str(v.op)}".`);
    }
  }
  return { ops, refused };
}
