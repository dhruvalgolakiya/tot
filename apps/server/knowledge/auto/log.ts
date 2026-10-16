import { createHash, randomUUID } from "node:crypto";
import type { KnowledgeTrigger, KnowledgeUpdate } from "../../../shared/types.ts";
import { appEvents } from "../../app-events.ts";
import { db, parseJson, type Row } from "../../db.ts";
import { projects } from "../../projects/projects.ts";
import { knowledgeRepo } from "./repos.ts";

/**
 * Module 11, lane C: the log of a project's knowledge auto-updates (`KnowledgeUpdate`, the last 50 per project),
 * what each run needs for Undo, and the base branch head last seen per project repo. Every change to the log
 * goes out as a `memory` event for the project's knowledge repo, so open views reload.
 */

const KEEP = 50;

/** A page a run changed, as Undo needs it: its text before (null for one it created) and a hash of what it wrote. */
export interface PageUndo {
  id: string;
  action: "created" | "updated";
  before: { title: string; summary: string; content: string } | null;
  wrote: string;
}

/** What Undo needs beyond the log row: the run's commits (newest first; one, unless it couldn't squash them) and its pages. */
export interface RunUndo {
  commits: string[];
  pages: PageUndo[];
}

/** One way to compare what a page says now with what a run wrote. */
export const pageHash = (page: { title: string; summary: string; content: string }) =>
  createHash("sha1").update(`${page.title}\n${page.summary}\n${page.content}`).digest("hex");

function toUpdate(row: Row): KnowledgeUpdate {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    trigger: row.kind as KnowledgeTrigger,
    repoName: (row.repo_name as string | null) ?? null,
    taskId: (row.task_id as string | null) ?? null,
    at: Number(row.at),
    sha: (row.sha as string | null) ?? null,
    pages: parseJson<KnowledgeUpdate["pages"]>(row.pages, []),
    facts: Number(row.facts),
    summary: String(row.summary),
    error: (row.error as string | null) ?? null,
    undoneAt: row.undone_at === null || row.undone_at === undefined ? null : Number(row.undone_at),
  };
}

/** Tells open views of the project's knowledge to reload (a `memory` event for its repo). */
export function knowledgeChanged(projectId: string, sha: string | null = null): void {
  const project = projects.get(projectId);
  if (project) appEvents.publish({ type: "memory", repo: knowledgeRepo(project), sha });
}

/** Tasks with an on-land update queued or running: the wiki keeper leaves them to it. */
export const landingsPending = new Set<string>();

export const knowledgeLog = {
  /** Newest first. */
  list(projectId: string): KnowledgeUpdate[] {
    return (db.prepare(`SELECT * FROM knowledge_updates WHERE project_id = ? ORDER BY at DESC, rowid DESC LIMIT ?`).all(projectId, KEEP) as Row[]).map(toUpdate);
  },

  get(id: string): (KnowledgeUpdate & { undo: RunUndo }) | null {
    const row = db.prepare(`SELECT * FROM knowledge_updates WHERE id = ?`).get(id) as Row | undefined;
    if (!row) return null;
    const undo = parseJson<Partial<RunUndo>>(row.undo, {});
    return { ...toUpdate(row), undo: { commits: undo.commits ?? [], pages: undo.pages ?? [] } };
  },

  /** Records a run (and drops the project's oldest beyond the last 50). */
  record(update: Omit<KnowledgeUpdate, "id" | "at" | "undoneAt" | "running"> & { at?: number; undo?: RunUndo }): KnowledgeUpdate {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO knowledge_updates (id, project_id, kind, repo_name, task_id, at, sha, pages, facts, summary, error, undo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      update.projectId,
      update.trigger,
      update.repoName,
      update.taskId,
      update.at ?? Date.now(),
      update.sha,
      JSON.stringify(update.pages),
      update.facts,
      update.summary,
      update.error,
      JSON.stringify(update.undo ?? { commits: [], pages: [] }),
    );
    db.prepare(
      `DELETE FROM knowledge_updates WHERE project_id = ? AND id NOT IN
         (SELECT id FROM knowledge_updates WHERE project_id = ? ORDER BY at DESC, rowid DESC LIMIT ?)`,
    ).run(update.projectId, update.projectId, KEEP);
    knowledgeChanged(update.projectId, update.sha);
    return knowledgeLog.get(id)!;
  },

  markUndone(id: string): KnowledgeUpdate | null {
    db.prepare(`UPDATE knowledge_updates SET undone_at = ? WHERE id = ? AND undone_at IS NULL`).run(Date.now(), id);
    const update = knowledgeLog.get(id);
    if (update) knowledgeChanged(update.projectId);
    return update;
  },

  /** A commit was undone elsewhere (Settings → Memory, the knowledge history): its run no longer offers Undo. */
  undoneElsewhere(repo: string, sha: string): void {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return;
    for (const row of db.prepare(`SELECT id, project_id FROM knowledge_updates WHERE sha LIKE ? AND undone_at IS NULL`).all(`${sha}%`) as Row[]) {
      const project = projects.get(String(row.project_id));
      if (project && knowledgeRepo(project) === repo) knowledgeLog.markUndone(String(row.id));
    }
  },

  /** The newest on-land run for a task, if there was one. */
  landedRun(taskId: string): KnowledgeUpdate | null {
    const row = db.prepare(`SELECT * FROM knowledge_updates WHERE task_id = ? AND kind = 'landed' ORDER BY at DESC LIMIT 1`).get(taskId) as Row | undefined;
    return row ? toUpdate(row) : null;
  },
};

/** The base branch head last seen per project repo. */
export const repoHeads = {
  get(projectId: string, repoName: string): { branch: string | null; sha: string; checkedAt: number } | null {
    const row = db.prepare(`SELECT * FROM knowledge_repo_heads WHERE project_id = ? AND repo_name = ?`).get(projectId, repoName) as Row | undefined;
    return row ? { branch: (row.branch as string | null) ?? null, sha: String(row.sha), checkedAt: Number(row.checked_at) } : null;
  },

  set(projectId: string, repoName: string, branch: string | null, sha: string): void {
    db.prepare(
      `INSERT INTO knowledge_repo_heads (project_id, repo_name, branch, sha, checked_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, repo_name) DO UPDATE SET branch = excluded.branch, sha = excluded.sha, checked_at = excluded.checked_at`,
    ).run(projectId, repoName, branch, sha, Date.now());
  },

  /** The repo was renamed (module 11): its head follows, so a rename isn't taken for a move. */
  rename(projectId: string, from: string, to: string): void {
    db.prepare(`UPDATE OR REPLACE knowledge_repo_heads SET repo_name = ? WHERE project_id = ? AND repo_name = ?`).run(to, projectId, from);
  },

  /** Checked and unchanged: only the time moves. */
  touch(projectId: string, repoName: string): void {
    db.prepare(`UPDATE knowledge_repo_heads SET checked_at = ? WHERE project_id = ? AND repo_name = ?`).run(Date.now(), projectId, repoName);
  },
};
