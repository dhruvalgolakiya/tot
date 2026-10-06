import type { KnowledgeCommit, KnowledgeStatus, MemoryCommit, Project, WikiPage, WikiPageSummary } from "../../shared/types.ts";
import { appEvents } from "../app-events.ts";
import { memories } from "../data/memories.ts";
import { wiki, WikiError } from "../data/wiki.ts";
import { db, type Row } from "../db.ts";
import { dreamUndone } from "../memory/dreaming.ts";
import { history as memoryHistory, undo as memoryUndo } from "../memory/memory.ts";
import { projectRepoId, repoDir } from "../memory/repo.ts";
import { tildePath } from "../projects/folders.ts";
import "./link.ts";
import { atomically, commitPages, flush, inBatch, landedIn, modeOf, moving, record, repoOf, scheduleFlush, storeError } from "./store.ts";

/**
 * A project's knowledge (roadmap module 11, lane B): its wiki pages and its memory facts in one git repo
 * (`memory/projects/<slug>`). The wiki keeps its `wiki.*` API (data/wiki.ts); these are the extras — where a
 * brain's pages live, a project repo's docs, waiting for (or grouping) commits, and the project's status and
 * history for the Knowledge panel. Lane C's auto-updates build on `repoHead`, `batch` and `flush`.
 */

const MAX_PAGES_LISTED = 50;
const ACTIONS = { create: "created", edit: "edited", move: "moved", delete: "deleted", restore: "restored", import: "imported" } as const;

function cleanRepoName(value: string): string {
  const name = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!name || name.length > 80) throw new WikiError("A repo's name needs 1–80 characters.");
  return name;
}

/** Marks a page as the head of a repo's docs: it and its subtree move into repos/<name>/. */
function setRepo(page: WikiPage, repo: string | null): WikiPage {
  const apply = () => db.prepare(`UPDATE wiki_pages SET repo = ? WHERE id = ?`).run(repo, page.id);
  if (modeOf(page.brainId) === "git") {
    atomically(() => {
      apply();
      record(page.brainId, [{ id: page.id, op: "move" }], "agent", null);
    });
  } else {
    apply();
  }
  appEvents.brainChanged(page.brainId, { structure: true });
  return wiki.get(page.id)!;
}

export const knowledge = {
  /** The repo a brain's pages live in: "projects/<slug>" for a project's brain, else "brains/<brainId>" (module 10's repo ids). */
  repoFor: (brainId: string): string => repoOf(brainId),

  /** "git" once the brain's pages live in its repo; "database" while its move hasn't happened (or failed). */
  mode: (brainId: string) => modeOf(brainId),

  /**
   * The page that heads a project repo's docs (`repo: <name>`; its subtree is that repo's, under repos/<name>/).
   * Made when it's missing: a top-level page already titled after the repo becomes it, else a new empty page
   * is created at the top level.
   */
  repoHead(brainId: string, repoName: string): WikiPage {
    const name = cleanRepoName(repoName);
    const row = db
      .prepare(`SELECT id FROM wiki_pages WHERE brain_id = ? AND deleted_at IS NULL AND repo IS NOT NULL AND lower(repo) = lower(?) ORDER BY created_at LIMIT 1`)
      .get(brainId, name) as Row | undefined;
    if (row) return wiki.get(String(row.id))!;
    return inBatch(brainId, { subject: `TOT: start the docs of ${name}`, actor: "TOT" }, () => {
      const top = wiki.withTitle(brainId, name, null).find((page) => !page.pinned && !page.repo);
      if (top) return setRepo(top, name);
      let title = name;
      for (let n = 2; wiki.withTitle(brainId, title, null).length; n++) title = n === 2 ? `${name} repo` : `${name} repo ${n}`;
      const page = wiki.create(brainId, { title, summary: `The ${name} repo: what it is, how it's built and where things are.`, content: "" }, "agent");
      return setRepo(page, name);
    }).result;
  },

  /** A repo's docs: its head page and everything under it, in tree order (empty when it has none yet). */
  repoPages(brainId: string, repoName: string): WikiPageSummary[] {
    const outline = wiki.list(brainId);
    const head = outline.find((page) => page.repo && page.repo.toLowerCase() === repoName.trim().toLowerCase());
    if (!head) return [];
    const inside = new Set([head.id]);
    for (const page of outline) if (page.parentId && inside.has(page.parentId)) inside.add(page.id);
    return outline.filter((page) => inside.has(page.id));
  },

  /** Waits until every change made to the brain's pages so far is committed; the repo's head commit after it. */
  flush: (brainId: string): Promise<string | null> => flush(brainId),

  /**
   * Runs `fn` — synchronous `wiki.*` writes to this brain — so its changes land as one commit with this subject
   * (e.g. "Knowledge: after “Fix cart”", actor "TOT"), and resolves with that commit's sha (null when nothing
   * changed). A failure in `fn` keeps the writes it already made (each is whole on its own).
   */
  async batch<T>(brainId: string, message: { subject: string; actor: string }, fn: () => T): Promise<{ result: T; sha: string | null }> {
    const { result, id } = inBatch(brainId, message, fn);
    if (modeOf(brainId) !== "git") return { result, sha: null };
    await scheduleFlush(brainId);
    return { result, sha: landedIn(id) };
  },

  /** Where a project's knowledge lives, and whether its wiki's move into git is done. */
  status(project: Project): KnowledgeStatus {
    const repo = projectRepoId(project.slug);
    const mode = modeOf(project.brainId);
    return {
      projectId: project.id,
      repo,
      path: tildePath(repoDir(repo)),
      state: moving.has(project.brainId) ? "moving" : mode,
      error: storeError(project.brainId),
      pages: wiki.count(project.brainId),
      facts: memories.count(repo),
    };
  },

  /** The project's knowledge history, facts and pages alike, newest first. */
  async history(project: Project, limit = 30, skip = 0): Promise<KnowledgeCommit[]> {
    const repo = projectRepoId(project.slug);
    const commits = await memoryHistory(repo, limit, skip);
    return withPages(repo, project.brainId, commits);
  },

  /** Undoes one change (a fact's or a page's) with a new commit; pages waiting to be committed land first. */
  async undo(project: Project, sha: string): Promise<KnowledgeCommit> {
    const repo = projectRepoId(project.slug);
    if (modeOf(project.brainId) === "git") await flush(project.brainId);
    const made = await memoryUndo(repo, sha, "you");
    dreamUndone(repo, sha);
    return withPages(repo, project.brainId, [made])[0]!;
  },
};

/** Adds what each commit did to the brain's pages (from its trailers, or the page files it touched). */
function withPages(repo: string, brainId: string, commits: MemoryCommit[]): KnowledgeCommit[] {
  let byCommit: ReturnType<typeof commitPages>;
  try {
    byCommit = commitPages(repo);
  } catch {
    byCommit = new Map();
  }
  const titleOf = db.prepare(`SELECT title FROM wiki_pages WHERE id = ?`);
  const byPath = db.prepare(`SELECT id, title FROM wiki_pages WHERE brain_id = ? AND path = ?`);
  return commits.map((commit) => {
    const found = byCommit.get(commit.sha);
    const pages: KnowledgeCommit["pages"] = [];
    if (found?.pages.length) {
      // One entry per page; a page made (or deleted) in a commit that also moved it reads as made (or deleted).
      const ops = new Map<string, string[]>();
      for (const line of found.pages) ops.set(line.id, [...(ops.get(line.id) ?? []), line.op]);
      for (const [id, list] of ops) {
        const title = (titleOf.get(id) as Row | undefined)?.title;
        const op = list.includes("delete") ? "delete" : list.includes("create") ? "create" : list.at(-1)!;
        if (title !== undefined) pages.push({ id, title: String(title), action: ACTIONS[op as keyof typeof ACTIONS] ?? "edited" });
      }
    } else {
      for (const path of found?.files ?? []) {
        const row = byPath.get(brainId, path) as Row | undefined;
        if (row) pages.push({ id: String(row.id), title: String(row.title), action: "edited" });
      }
    }
    return { ...commit, pages: pages.slice(0, MAX_PAGES_LISTED) };
  });
}
