import { randomUUID } from "node:crypto";
import type { LeadSignal, LeadSignalKind } from "../../shared/types.ts";
import { db, type Row } from "../db.ts";
import type { NewSignal } from "../lead/inbox.ts";

/**
 * Module 12 (docs/roadmap/12-coordinator.md), lane A: a project's signals, what its Lead heard about on its own
 * (pull requests, tickets, schedules). Each is kept until the Lead's turn has read it (`readAt`), across restarts,
 * and after that for the Board. A signal posted with a key (the watcher's: the PR, the kind, the head commit or the
 * comment id) is stored once only; one without a key is a duplicate while an identical one is still unread.
 * Signal wakes are counted per project for the hourly bound (signalWakes).
 */

const KINDS: readonly LeadSignalKind[] = [
  "ci-failed",
  "ci-passed",
  "changes-requested",
  "review-comment",
  "comment",
  "pr-merged",
  "pr-closed",
  "pr-conflict",
  "ticket",
  "schedule",
];

const MAX_TITLE = 300;
const MAX_DETAIL = 4000;
/** Read signals are kept this long, and at most this many per project, for the Board. */
const KEEP_READ_MS = 60 * 24 * 60 * 60_000;
const KEEP_READ = 300;

/** At most this many signal wakes per project in an hour; beyond that, signals wait for the next one. */
export const SIGNAL_WAKES_PER_HOUR = 12;
const HOUR_MS = 60 * 60_000;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function toSignal(row: Row): LeadSignal {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    kind: row.kind as LeadSignalKind,
    title: String(row.title),
    detail: (row.detail as string | null) ?? null,
    url: (row.url as string | null) ?? null,
    repoName: (row.repo_name as string | null) ?? null,
    taskId: (row.task_id as string | null) ?? null,
    prNumber: row.pr_number === null || row.pr_number === undefined ? null : Number(row.pr_number),
    at: Number(row.at),
    readAt: row.read_at === null || row.read_at === undefined ? null : Number(row.read_at),
  };
}

/** Old read signals go: the Board shows the recent ones, and unread ones are never removed. */
function prune(projectId: string, now: number): void {
  db.prepare(`DELETE FROM lead_signals WHERE project_id = ? AND read_at IS NOT NULL AND at < ?`).run(projectId, now - KEEP_READ_MS);
  db.prepare(
    `DELETE FROM lead_signals WHERE project_id = ? AND read_at IS NOT NULL AND id NOT IN
       (SELECT id FROM lead_signals WHERE project_id = ? AND read_at IS NOT NULL ORDER BY at DESC LIMIT ?)`,
  ).run(projectId, projectId, KEEP_READ);
}

export const leadSignals = {
  /** Stores a signal; null when it's a duplicate (the same key, or an identical unread one), or not a signal at all. */
  add(projectId: string, input: NewSignal, key: string | null = null, now = Date.now()): LeadSignal | null {
    if (!KINDS.includes(input.kind)) return null;
    const title = clip(input.title.replace(/\s+/g, " ").trim(), MAX_TITLE);
    if (!title) return null;
    const detail = input.detail?.trim() ? clip(input.detail.trim(), MAX_DETAIL) : null;
    if (key) {
      if (db.prepare(`SELECT 1 FROM lead_signals WHERE project_id = ? AND dedupe_key = ?`).get(projectId, key)) return null;
    } else if (
      db
        .prepare(`SELECT 1 FROM lead_signals WHERE project_id = ? AND read_at IS NULL AND kind = ? AND title = ? AND detail IS ? AND url IS ?`)
        .get(projectId, input.kind, title, detail, input.url ?? null)
    ) {
      return null;
    }
    const id = `sig_${randomUUID().slice(0, 12)}`;
    const inserted = db
      .prepare(
        `INSERT OR IGNORE INTO lead_signals (id, project_id, kind, title, detail, url, repo_name, task_id, pr_number, dedupe_key, at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, projectId, input.kind, title, detail, input.url ?? null, input.repoName ?? null, input.taskId ?? null, input.prNumber ?? null, key, now);
    if (Number(inserted.changes) === 0) return null;
    prune(projectId, now);
    return leadSignals.get(id);
  },

  get(id: string): LeadSignal | null {
    const row = db.prepare(`SELECT * FROM lead_signals WHERE id = ?`).get(id) as Row | undefined;
    return row ? toSignal(row) : null;
  },

  /** The project's signals, newest first (GET /api/projects/:id/signals). */
  list(projectId: string, limit = 50): LeadSignal[] {
    const rows = db.prepare(`SELECT * FROM lead_signals WHERE project_id = ? ORDER BY at DESC, rowid DESC LIMIT ?`).all(projectId, limit) as Row[];
    return rows.map(toSignal);
  },

  /** Those the Lead hasn't heard yet, oldest first. */
  unread(projectId: string): LeadSignal[] {
    const rows = db.prepare(`SELECT * FROM lead_signals WHERE project_id = ? AND read_at IS NULL ORDER BY at, rowid`).all(projectId) as Row[];
    return rows.map(toSignal);
  },

  /** The Lead's turn has them (a wake, or its next turn). */
  markRead(ids: string[], at = Date.now()): void {
    const mark = db.prepare(`UPDATE lead_signals SET read_at = ? WHERE id = ? AND read_at IS NULL`);
    for (const id of ids) mark.run(at, id);
  },

  /** The turn that was to read them didn't get through: they wait for the next one. */
  markUnread(ids: string[]): void {
    const mark = db.prepare(`UPDATE lead_signals SET read_at = NULL WHERE id = ?`);
    for (const id of ids) mark.run(id);
  },
};

/** The hourly bound on signal wakes, per project; kept in the database, so a restart doesn't reset it. */
export const signalWakes = {
  /** Wakes in the hour before `now`. */
  used(projectId: string, now = Date.now()): number {
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM lead_signal_wakes WHERE project_id = ? AND at > ?`).get(projectId, now - HOUR_MS) as Row).n);
  },

  /** Whether another signal wake fits in the hour. */
  allowed(projectId: string, now = Date.now()): boolean {
    return signalWakes.used(projectId, now) < SIGNAL_WAKES_PER_HOUR;
  },

  record(projectId: string, now = Date.now()): void {
    db.prepare(`DELETE FROM lead_signal_wakes WHERE project_id = ? AND at <= ?`).run(projectId, now - HOUR_MS);
    db.prepare(`INSERT INTO lead_signal_wakes (project_id, at) VALUES (?, ?)`).run(projectId, now);
  },

  /** When the next one fits (now, when one does already). */
  nextAt(projectId: string, now = Date.now()): number {
    const rows = db
      .prepare(`SELECT at FROM lead_signal_wakes WHERE project_id = ? AND at > ? ORDER BY at DESC LIMIT ?`)
      .all(projectId, now - HOUR_MS, SIGNAL_WAKES_PER_HOUR) as Row[];
    if (rows.length < SIGNAL_WAKES_PER_HOUR) return now;
    return Number(rows[rows.length - 1]!.at) + HOUR_MS + 1;
  },

  /** Tests: forget the project's wakes. */
  clear(projectId: string): void {
    db.prepare(`DELETE FROM lead_signal_wakes WHERE project_id = ?`).run(projectId);
  },
};
