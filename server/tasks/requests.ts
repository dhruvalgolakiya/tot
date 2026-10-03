import { HttpError } from "../agent/orchestrator.ts";
import { db, type Row } from "../db.ts";
import { taskStore, type TaskRecord } from "./store.ts";

/**
 * Retry-safe starts (module 05): an optional request id passed with task_start / task_spawn_many
 * (by the agent) or "Run as task" (by the app). The same id from the same chat always means the
 * same tasks, across restarts too, so a retried tool call or a double click never starts work twice.
 */

const MAX_ID = 100;

export function cleanRequestId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_ID) throw new HttpError(400, `A request id is text of up to ${MAX_ID} characters.`);
  return value;
}

export const taskRequests = {
  /** The tasks this request id started from the chat, in order (without any deleted since); null when it's new. */
  find(parentId: string, requestId: string): TaskRecord[] | null {
    const rows = db.prepare(`SELECT task_id FROM task_requests WHERE parent_id = ? AND request_id = ? ORDER BY idx`).all(parentId, requestId) as Row[];
    if (!rows.length) return null;
    return rows.map((row) => taskStore.get(String(row.task_id))).filter((task): task is TaskRecord => task !== null);
  },

  /**
   * Starts tasks at most once per request id: `start` runs the first time, and a repeat gets those
   * tasks back. Everything here is synchronous, so two calls can't both start.
   */
  once(parentId: string, requestId: string | null, start: () => TaskRecord[]): { tasks: TaskRecord[]; repeat: boolean } {
    if (!requestId) return { tasks: start(), repeat: false };
    const earlier = taskRequests.find(parentId, requestId);
    if (earlier) return { tasks: earlier, repeat: true };
    const started = start();
    const insert = db.prepare(`INSERT INTO task_requests (parent_id, request_id, idx, task_id, created_at) VALUES (?, ?, ?, ?, ?)`);
    const now = Date.now();
    started.forEach((task, idx) => insert.run(parentId, requestId, idx, task.id, now));
    return { tasks: started, repeat: false };
  },
};
