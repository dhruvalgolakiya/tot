import { randomUUID } from "node:crypto";
import type {
  WikiAuthor,
  WikiPage,
  WikiPageInput,
  WikiPagePatch,
  WikiPageSummary,
  WikiRevision,
  WikiSearchHit,
} from "@tot/shared/types";
import { db, type Row } from "../db.ts";
import { OVERVIEW_PATH } from "../knowledge/files.ts";
import { atomically, gitRevisions, linked, modeOf, record } from "../knowledge/store.ts";
import { brains } from "./brains.ts";
import { toFtsQuery } from "./memories.ts";

/**
 * Each brain's wiki (see brains.ts): markdown pages that nest, searchable, with a
 * revision kept before every change. Titles are unique among siblings (so two
 * repo pages can each have an "Architecture" child); agents refer to pages by
 * id, or by title when that's unambiguous. Every brain has one pinned Overview
 * page, created on first use. Deleting a page only marks it deleted, so it and
 * its history can be recovered. Reads can span several brains (`BrainScope`);
 * writes go to one.
 *
 * Since module 11 a brain's pages are markdown files in a git repo (knowledge/store.ts) and `wiki_pages` is
 * their index: writes update it at once and are committed in the background, and a page's history comes from
 * git. A brain whose move into git hasn't landed works from the database as before. Pages never hold secrets.
 */

/** One brain id, or several (e.g. every brain an agent can see). */
export type BrainScope = string | string[];
const scopeJson = (scope: BrainScope) => JSON.stringify(typeof scope === "string" ? [scope] : scope);
const IN_SCOPE = `brain_id IN (SELECT value FROM json_each(?))`;

/** A change the user should see as a validation message (bad title, unknown page…). */
export class WikiError extends Error {}

export const OVERVIEW_TITLE = "Overview";
const OVERVIEW_SUMMARY = "What this workspace is for, its projects and where they live, current status and next steps.";
const SHARED_OVERVIEW_SUMMARY = "Start here: what this brain covers, where things live, and a map of its pages.";

const STOPWORDS = new Set(
  (
    "the and for are but not you your yours with this that these those from have has had was were will would can could should " +
    "about into over under again then than them they their there here what when where which who why how all any both each few " +
    "more most other some such only own same too very just now also please thanks thank hey hello okay let lets make need want " +
    "get got use using like know think does did doing done its it's i'm i've we're our ours out off one two new"
  ).split(" "),
);

const MAX_TITLE = 120;
const MAX_SUMMARY = 300;
export const MAX_PAGE_CHARS = 60_000;
/** Edits to a page by the same author in the same chat within this window share one revision. */
const REVISION_COALESCE_MS = 15 * 60_000;
const MAX_REVISIONS_PER_PAGE = 30;

function toSummary(row: Row): WikiPageSummary {
  return {
    id: String(row.id),
    brainId: String(row.brain_id),
    parentId: (row.parent_id as string | null) ?? null,
    title: String(row.title),
    summary: String(row.summary),
    pinned: Boolean(row.pinned),
    position: Number(row.position),
    updatedBy: row.updated_by as WikiAuthor,
    updatedAt: Number(row.updated_at),
    repo: (row.repo as string | null) ?? null,
  };
}

function toPage(row: Row): WikiPage {
  return {
    ...toSummary(row),
    content: String(row.content),
    conversationId: (row.conversation_id as string | null) ?? null,
    createdAt: Number(row.created_at),
  };
}

function toRevision(row: Row): WikiRevision {
  return {
    id: String(row.id),
    pageId: String(row.page_id),
    title: String(row.title),
    summary: String(row.summary),
    content: String(row.content),
    updatedBy: row.updated_by as WikiAuthor,
    conversationId: (row.conversation_id as string | null) ?? null,
    createdAt: Number(row.created_at),
  };
}

/** Pinned first, then depth-first through the tree in position order. */
function treeOrder(pages: WikiPageSummary[]): (WikiPageSummary & { depth: number })[] {
  const children = new Map<string | null, WikiPageSummary[]>();
  const ids = new Set(pages.map((p) => p.id));
  for (const page of pages) {
    const parent = page.parentId && ids.has(page.parentId) ? page.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), page]);
  }
  const ordered: (WikiPageSummary & { depth: number })[] = [];
  const visit = (parent: string | null, depth: number) => {
    const siblings = (children.get(parent) ?? []).sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || a.position - b.position || a.title.localeCompare(b.title),
    );
    for (const page of siblings) {
      ordered.push({ ...page, depth });
      visit(page.id, depth + 1);
    }
  };
  visit(null, 0);
  return ordered;
}

function text(value: unknown, field: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new WikiError(`The ${field} must be text.`);
  return value;
}

function cleanTitle(title: unknown): string {
  const value = text(title, "title").replace(/\s+/g, " ").trim();
  if (!value || value.length > MAX_TITLE) throw new WikiError(`Page titles need 1–${MAX_TITLE} characters.`);
  return value;
}

function cleanSummary(summary: unknown): string {
  const value = text(summary, "summary").replace(/\s+/g, " ").trim();
  if (value.length > MAX_SUMMARY) throw new WikiError(`Keep the summary under ${MAX_SUMMARY} characters (it's one line).`);
  return value;
}

function cleanContent(content: unknown): string {
  const value = text(content, "content").replace(/\r\n/g, "\n").trim();
  if (value.length > MAX_PAGE_CHARS) {
    throw new WikiError(`Pages are limited to ${MAX_PAGE_CHARS.toLocaleString("en-US")} characters; split this into smaller pages.`);
  }
  return value;
}

/** Case-insensitive across scripts (SQLite's lower() only folds ASCII). */
const sameTitle = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

export const WIKI_SECRET_REFUSAL = "That looks like a secret; the wiki never stores secrets.";

/**
 * Refuses text that brings in a secret (as memory does: anything shaped like a key, TOT's own secrets, a password
 * written out). Only what's new counts, so a line that was already on the page doesn't lock it.
 */
function assertNoNewSecret(before: string, after: string): void {
  if (before === after) return;
  const old = new Set(before.split("\n"));
  const added = after
    .split("\n")
    .filter((line) => !old.has(line))
    .join("\n");
  if (linked.secretKind(added)) throw new WikiError(WIKI_SECRET_REFUSAL);
}

const isGit = (brainId: string) => modeOf(brainId) === "git";

export const wiki = {
  /** The brain's pinned Overview (its start-here page), created on first use. */
  overview(brainId: string): WikiPage {
    const row = db.prepare(`SELECT * FROM wiki_pages WHERE brain_id = ? AND pinned = 1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`).get(brainId) as
      | Row
      | undefined;
    if (row) return toPage(row);
    const id = randomUUID();
    const now = Date.now();
    const summary = brains.get(brainId)?.kind === "notebook" ? OVERVIEW_SUMMARY : SHARED_OVERVIEW_SUMMARY;
    // In git, an empty Overview nobody wrote in yet is only in the index: its file comes with its first edit.
    const path = isGit(brainId) ? OVERVIEW_PATH : null;
    db.prepare(
      `INSERT INTO wiki_pages (id, brain_id, title, summary, content, pinned, position, updated_by, created_at, updated_at, path)
       VALUES (?, ?, ?, ?, '', 1, 0, 'agent', ?, ?, ?)`,
    ).run(id, brainId, OVERVIEW_TITLE, summary, now, now, path);
    return wiki.get(id)!;
  },

  /** Every page of a brain, Overview first, then in tree order. */
  list(brainId: string): WikiPageSummary[] {
    return wiki.outline(brainId).map(({ depth: _depth, ...page }) => page);
  },

  /** The page index as the agent sees it: titles indented by depth. */
  outline(brainId: string): (WikiPageSummary & { depth: number })[] {
    wiki.overview(brainId);
    const rows = db.prepare(`SELECT * FROM wiki_pages WHERE brain_id = ? AND deleted_at IS NULL`).all(brainId) as Row[];
    return treeOrder(rows.map(toSummary));
  },

  count(scope: BrainScope): number {
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM wiki_pages WHERE ${IN_SCOPE} AND deleted_at IS NULL`).get(scopeJson(scope)) as Row).n);
  },

  search(scope: BrainScope, query: string, limit = 10): WikiSearchHit[] {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const rows = db
      .prepare(
        `SELECT p.*, snippet(wiki_fts, -1, '«', '»', ' … ', 16) AS snippet
         FROM wiki_fts f JOIN wiki_pages p ON p.rowid = f.rowid
         WHERE wiki_fts MATCH ? AND p.${IN_SCOPE} AND p.deleted_at IS NULL
         ORDER BY bm25(wiki_fts, 8.0, 3.0, 1.0) LIMIT ?`,
      )
      .all(fts, scopeJson(scope), limit) as Row[];
    return rows.map((row) => ({ ...toSummary(row), snippet: String(row.snippet) }));
  },

  /** Full pages ranked by relevance to some text, e.g. the first message of a chat. */
  relevant(scope: BrainScope, text: string, limit: number): WikiPage[] {
    // Only meaningful words, so "can you fix the bug" doesn't match every page.
    const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu)?.filter((word) => !STOPWORDS.has(word)) ?? [];
    const fts = toFtsQuery(words.join(" "));
    if (!fts) return [];
    const rows = db
      .prepare(
        `SELECT p.* FROM wiki_fts f JOIN wiki_pages p ON p.rowid = f.rowid
         WHERE wiki_fts MATCH ? AND p.${IN_SCOPE} AND p.pinned = 0 AND p.deleted_at IS NULL
         ORDER BY bm25(wiki_fts, 8.0, 3.0, 1.0) LIMIT ?`,
      )
      .all(fts, scopeJson(scope), limit) as Row[];
    return rows.map(toPage);
  },

  get(id: string): WikiPage | null {
    const row = db.prepare(`SELECT * FROM wiki_pages WHERE id = ? AND deleted_at IS NULL`).get(id) as Row | undefined;
    return row ? toPage(row) : null;
  },

  /** A page in these brains by id or (case-insensitive) title; throws when several pages share the title. */
  find(scope: BrainScope, ref: string): WikiPage | null {
    const key = ref.trim();
    const byId = db.prepare(`SELECT * FROM wiki_pages WHERE ${IN_SCOPE} AND id = ? AND deleted_at IS NULL`).get(scopeJson(scope), key) as
      | Row
      | undefined;
    if (byId) return toPage(byId);
    const matches = wiki.withTitle(scope, key);
    if (matches.length > 1) {
      const several = new Set(matches.map((page) => page.brainId)).size > 1;
      const options = matches.map((page) => {
        const where = [
          several && `in brain “${brains.get(page.brainId)?.name}”`,
          page.parentId && `under “${wiki.get(page.parentId)?.title}”`,
        ].filter(Boolean);
        return `${page.id}${where.length ? ` (${where.join(", ")})` : ""}`;
      });
      throw new WikiError(`Several pages are called “${key}”; use the id: ${options.join(", ")}.`);
    }
    return matches[0] ?? null;
  },

  /** Pages with this title (case-insensitive), optionally only under one parent (null = top level). */
  withTitle(scope: BrainScope, title: string, parentId?: string | null): WikiPage[] {
    const rows =
      parentId === undefined
        ? db.prepare(`SELECT * FROM wiki_pages WHERE ${IN_SCOPE} AND deleted_at IS NULL`).all(scopeJson(scope))
        : db.prepare(`SELECT * FROM wiki_pages WHERE ${IN_SCOPE} AND parent_id IS ? AND deleted_at IS NULL`).all(scopeJson(scope), parentId);
    return (rows as Row[]).map(toPage).filter((page) => sameTitle(page.title, title));
  },

  create(brainId: string, input: WikiPageInput, author: WikiAuthor, conversationId: string | null = null): WikiPage {
    const title = cleanTitle(input.title);
    const summary = cleanSummary(input.summary);
    const content = cleanContent(input.content);
    assertNoNewSecret("", `${title}\n${summary}\n${content}`);
    wiki.overview(brainId);
    const parentId = input.parentId ? wiki.checkParent(brainId, input.parentId, null) : null;
    if (wiki.withTitle(brainId, title, parentId).length) throw new WikiError(`There's already a page called “${title}” here.`);
    const position = Number(
      (
        db
          .prepare(
            `SELECT COALESCE(MAX(position), 0) + 1 AS next FROM wiki_pages WHERE brain_id = ? AND parent_id IS ? AND deleted_at IS NULL`,
          )
          .get(brainId, parentId) as Row
      ).next,
    );
    const id = randomUUID();
    const now = Date.now();
    const insert = () =>
      db.prepare(
        `INSERT INTO wiki_pages (id, brain_id, parent_id, title, summary, content, pinned, position, updated_by, conversation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      ).run(id, brainId, parentId, title, summary, content, position, author, conversationId, now, now);
    if (isGit(brainId)) {
      atomically(() => {
        insert();
        record(brainId, [{ id, op: "create" }], author, conversationId);
      });
    } else {
      insert();
    }
    return wiki.get(id)!;
  },

  update(id: string, patch: WikiPagePatch, author: WikiAuthor, conversationId: string | null = null): WikiPage {
    const page = wiki.get(id);
    if (!page) throw new WikiError("Page not found.");
    const title = patch.title === undefined ? page.title : cleanTitle(patch.title);
    const summary = patch.summary === undefined ? page.summary : cleanSummary(patch.summary);
    const content = patch.content === undefined ? page.content : cleanContent(patch.content);
    if (page.pinned && title !== page.title) throw new WikiError(`The ${page.title} page can't be renamed.`);
    let parentId = page.parentId;
    if (patch.parentId !== undefined) {
      if (page.pinned && patch.parentId) throw new WikiError(`The ${page.title} page stays at the top.`);
      parentId = patch.parentId ? wiki.checkParent(page.brainId, patch.parentId, page.id) : null;
    }
    // Only a rename or a move can create a clash; re-checking otherwise would lock out pages that already clash.
    const renamedOrMoved = !sameTitle(title, page.title) || parentId !== page.parentId;
    if (renamedOrMoved && wiki.withTitle(page.brainId, title, parentId).some((other) => other.id !== page.id)) {
      throw new WikiError(`There's already a page called “${title}” here.`);
    }
    const position = patch.position ?? page.position;
    const git = isGit(page.brainId);

    if (title === page.title && summary === page.summary && content === page.content) {
      // Nothing to read changed (a move or reorder): keep who wrote it and when.
      const move = () => db.prepare(`UPDATE wiki_pages SET parent_id = ?, position = ? WHERE id = ?`).run(parentId, position, id);
      if (!git) move();
      else if (parentId !== page.parentId || position !== page.position) {
        atomically(() => {
          move();
          record(page.brainId, [{ id, op: "move" }], author, conversationId);
        });
      }
      return wiki.get(id)!;
    }
    assertNoNewSecret(page.title, title);
    assertNoNewSecret(page.summary, summary);
    assertNoNewSecret(page.content, content);
    const write = () =>
      db.prepare(
        `UPDATE wiki_pages SET title = ?, summary = ?, content = ?, parent_id = ?, position = ?, updated_by = ?, conversation_id = ?, updated_at = ?
         WHERE id = ?`,
      ).run(title, summary, content, parentId, position, author, conversationId, Date.now(), id);
    if (git) {
      // Git keeps every version; the commit says who and from which chat.
      atomically(() => {
        write();
        record(page.brainId, [{ id, op: "edit" }], author, conversationId);
      });
    } else {
      wiki.snapshot(page, author, conversationId);
      write();
    }
    return wiki.get(id)!;
  },

  /**
   * Deletes a page (kept, marked deleted); its children move up a level, renamed
   * if a sibling there already has their title. The pinned Overview can't be deleted. `author`: who deleted it
   * (the history says so; module 11).
   */
  delete(id: string, author: WikiAuthor = "user", conversationId: string | null = null): WikiPage {
    const page = wiki.get(id);
    if (!page) throw new WikiError("Page not found.");
    if (page.pinned) throw new WikiError(`The ${page.title} page can't be deleted.`);
    const remove = () => {
      const moved: string[] = [];
      for (const child of db.prepare(`SELECT * FROM wiki_pages WHERE parent_id = ? AND deleted_at IS NULL`).all(id) as Row[]) {
        const { id: childId, title } = toSummary(child);
        let free = title;
        for (let n = 1; wiki.withTitle(page.brainId, free, page.parentId).length; n++) {
          free = n === 1 ? `${title} (${page.title})` : `${title} (${page.title} ${n})`;
        }
        db.prepare(`UPDATE wiki_pages SET parent_id = ?, title = ? WHERE id = ?`).run(page.parentId, free, childId);
        moved.push(childId);
      }
      db.prepare(`UPDATE wiki_pages SET deleted_at = ? WHERE id = ?`).run(Date.now(), id);
      return moved;
    };
    if (isGit(page.brainId)) {
      // The file goes (git keeps it, and an undo brings it back); the index keeps the page, marked deleted.
      atomically(() => {
        const moved = remove();
        record(page.brainId, [{ id, op: "delete" }, ...moved.map((child) => ({ id: child, op: "move" as const }))], author, conversationId);
      });
    } else {
      remove();
    }
    return page;
  },

  revisions(pageId: string): WikiRevision[] {
    const brain = db.prepare(`SELECT brain_id FROM wiki_pages WHERE id = ?`).get(pageId) as Row | undefined;
    if (brain && isGit(String(brain.brain_id))) return gitRevisions(String(brain.brain_id), pageId);
    return (db.prepare(`SELECT * FROM wiki_revisions WHERE page_id = ? ORDER BY created_at DESC`).all(pageId) as Row[]).map(
      toRevision,
    );
  },

  restore(pageId: string, revisionId: string, author: WikiAuthor): WikiPage {
    const current = wiki.get(pageId);
    if (current && isGit(current.brainId)) return restoreFromGit(current, revisionId, author);
    const row = db.prepare(`SELECT * FROM wiki_revisions WHERE id = ? AND page_id = ?`).get(revisionId, pageId) as Row | undefined;
    if (!row) throw new WikiError("That version no longer exists.");
    const revision = toRevision(row);
    const page = wiki.get(pageId);
    if (!page) throw new WikiError("Page not found.");
    assertNoNewSecret(page.content, revision.content);
    // The old title comes back unless it's pinned or a sibling took it meanwhile.
    const titleFree =
      !page.pinned && !wiki.withTitle(page.brainId, revision.title, page.parentId).some((other) => other.id !== page.id);
    // Restoring always records the current state, so a restore can itself be undone.
    wiki.snapshot(page, author, null, true);
    db.prepare(`UPDATE wiki_pages SET title = ?, summary = ?, content = ?, updated_by = ?, conversation_id = NULL, updated_at = ? WHERE id = ?`).run(
      titleFree ? revision.title : page.title,
      revision.summary,
      revision.content,
      author,
      Date.now(),
      pageId,
    );
    return wiki.get(pageId)!;
  },

  /** Records a page's current state before a change, merging rapid edits from the same chat. */
  snapshot(page: WikiPage, author: WikiAuthor, conversationId: string | null, force = false): void {
    const now = Date.now();
    // Same author, same chat, still editing: the revision from the start of this burst covers it.
    const sameBurst =
      !force &&
      page.updatedBy === author &&
      page.conversationId === conversationId &&
      now - page.updatedAt < REVISION_COALESCE_MS &&
      db.prepare(`SELECT 1 FROM wiki_revisions WHERE page_id = ? AND created_at >= ?`).get(page.id, now - REVISION_COALESCE_MS) !==
        undefined;
    // A page that was never edited and is still empty has nothing worth restoring.
    const pristine = !page.content && page.updatedAt === page.createdAt;
    if (sameBurst || pristine) return;
    db.prepare(
      `INSERT INTO wiki_revisions (id, page_id, title, summary, content, updated_by, conversation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), page.id, page.title, page.summary, page.content, page.updatedBy, page.conversationId, now);
    db.prepare(
      `DELETE FROM wiki_revisions WHERE page_id = ? AND id NOT IN
         (SELECT id FROM wiki_revisions WHERE page_id = ? ORDER BY created_at DESC LIMIT ?)`,
    ).run(page.id, page.id, MAX_REVISIONS_PER_PAGE);
  },

  /** Validates a parent reference (id or title) and returns its id; refuses cycles. */
  checkParent(brainId: string, ref: unknown, childId: string | null): string {
    if (typeof ref !== "string") throw new WikiError("The parent must be a page id or title.");
    const parent = wiki.find(brainId, ref);
    if (!parent) throw new WikiError(`No parent page “${ref}” in this wiki.`);
    for (let at: WikiPage | null = parent; at; at = at.parentId ? wiki.get(at.parentId) : null) {
      if (at.id === childId) throw new WikiError("A page can't be nested inside itself.");
    }
    return parent.id;
  },
};

/** A git brain's restore: the old version comes back as a new change (a commit), so a restore can be undone too. */
function restoreFromGit(page: WikiPage, revisionId: string, author: WikiAuthor): WikiPage {
  const revision = wiki.revisions(page.id).find((candidate) => candidate.id === revisionId);
  if (!revision) throw new WikiError("That version no longer exists.");
  const titleFree =
    !page.pinned && !wiki.withTitle(page.brainId, revision.title, page.parentId).some((other) => other.id !== page.id);
  const title = titleFree ? revision.title : page.title;
  assertNoNewSecret(page.title, title);
  assertNoNewSecret(page.summary, revision.summary);
  assertNoNewSecret(page.content, revision.content);
  atomically(() => {
    db.prepare(`UPDATE wiki_pages SET title = ?, summary = ?, content = ?, updated_by = ?, conversation_id = NULL, updated_at = ? WHERE id = ?`).run(
      title,
      revision.summary,
      revision.content,
      author,
      Date.now(),
      page.id,
    );
    record(page.brainId, [{ id: page.id, op: "restore" }], author, null);
  });
  return wiki.get(page.id)!;
}

// The store's secret checks and events come from modules that use the wiki while they load (knowledge/link.ts):
// linked once everything has loaded (knowledge/index.ts and memory/start.ts link them too).
void Promise.resolve()
  .then(() => import("../knowledge/link.ts"))
  .catch((err) => console.error("[tot] the wiki couldn't link its secret checks:", err instanceof Error ? err.message : err));

// Every agent has its notebook, and every brain its Overview, from the start.
for (const row of db.prepare(`SELECT id FROM agents`).all() as Row[]) brains.notebook(String(row.id));
for (const brain of brains.list()) wiki.overview(brain.id);

// Notes saved per workspace before the wiki existed move into a "Notes" page, all
// or nothing, and never in a way that could stop the server from starting. (Since module 10 the old memory
// rows are in memories_legacy; `memories` is the memory repos' index.)
const workspaceNotes = db
  .prepare(`SELECT agent_id, content FROM memories_legacy WHERE agent_id IS NOT NULL ORDER BY created_at`)
  .all() as Row[];
if (workspaceNotes.length) {
  const byAgent = new Map<string, string[]>();
  for (const row of workspaceNotes) byAgent.set(String(row.agent_id), [...(byAgent.get(String(row.agent_id)) ?? []), String(row.content)]);
  db.exec("BEGIN");
  try {
    for (const [agentId, notes] of byAgent) {
      const notebook = brains.notebook(agentId).id;
      let title = "Notes";
      for (let n = 2; wiki.withTitle(notebook, title, null).length; n++) title = `Notes ${n}`;
      const content = notes.map((note) => `- ${note}`).join("\n").slice(0, MAX_PAGE_CHARS);
      wiki.create(notebook, { title, summary: "Notes saved before the wiki existed", content }, "agent");
    }
    db.prepare(`DELETE FROM memories_legacy WHERE agent_id IS NOT NULL`).run();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    console.warn("[tot] couldn't move workspace notes into the wiki:", err instanceof Error ? err.message : err);
  }
}
