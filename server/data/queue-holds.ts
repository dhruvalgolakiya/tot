import type { ProviderId, QueueHold } from "../../shared/types.ts";
import { db, type Row } from "../db.ts";

/**
 * Paused task queues (module 05). When a task fails because its provider kept erroring (not a
 * usage limit: failover handles those), every queued task would fail the same way in turn, so
 * the agent's queue stops starting tasks until the user resumes it.
 */
export const queueHolds = {
  get(agentId: string): QueueHold | null {
    const row = db.prepare(`SELECT * FROM queue_holds WHERE agent_id = ?`).get(agentId) as Row | undefined;
    return row ? { provider: (row.provider as ProviderId | null) ?? null, reason: String(row.reason), createdAt: Number(row.created_at) } : null;
  },

  set(agentId: string, provider: ProviderId | null, reason: string): void {
    db.prepare(`INSERT OR REPLACE INTO queue_holds (agent_id, provider, reason, created_at) VALUES (?, ?, ?, ?)`).run(agentId, provider, reason.slice(0, 1000), Date.now());
  },

  /** True when there was a hold to clear. */
  clear(agentId: string): boolean {
    return Number(db.prepare(`DELETE FROM queue_holds WHERE agent_id = ?`).run(agentId).changes) > 0;
  },
};
