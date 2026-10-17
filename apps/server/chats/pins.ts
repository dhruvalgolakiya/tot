import { HttpError } from "../agent/orchestrator.ts";
import { db, type Row } from "../db.ts";
import { conversations, type ConversationRecord } from "../data/conversations.ts";

/** The order of each agent's pinned chats: dragged into place, and a newly pinned chat on top. */
export const pins = {
  /** Where a chat pinned now goes: above the agent's other pinned chats. */
  topFor(agentId: string): number {
    const row = db.prepare(`SELECT min(pin_position) AS top FROM conversations WHERE agent_id = ? AND pinned = 1`).get(agentId) as Row;
    return row.top === null ? 0 : Number(row.top) - 1;
  },

  /** Puts one agent's pinned chats in the order of `ids` (all of them, each once). */
  reorder(ids: unknown): ConversationRecord[] {
    if (!Array.isArray(ids) || !ids.length || !ids.every((id) => typeof id === "string")) throw new HttpError(400, "ids must list chat ids.");
    if (new Set(ids).size !== ids.length) throw new HttpError(400, "Each chat goes in the order once.");
    const chats = ids.map((id) => conversations.get(id));
    const missing = ids.find((_, i) => !chats[i]);
    if (missing) throw new HttpError(404, "Chat not found.");
    const records = chats as ConversationRecord[];
    if (records.some((c) => !c.pinned)) throw new HttpError(400, "Only pinned chats have an order.");
    const agentId = records[0]!.agentId;
    if (records.some((c) => c.agentId !== agentId)) throw new HttpError(400, "Pinned chats are ordered one agent at a time.");
    db.exec("BEGIN");
    try {
      ids.forEach((id, index) => conversations.update(id as string, { pinPosition: index }));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return ids.map((id) => conversations.get(id as string)!);
  },
};
