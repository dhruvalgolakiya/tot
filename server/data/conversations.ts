import { randomUUID } from "node:crypto";
import type { Conversation, ProviderId } from "../../shared/types.ts";
import { db, type Row } from "../db.ts";
import { getComputerSummary } from "./computers.ts";

/** Server-side view of a conversation, including provider session state. */
export interface ConversationRecord extends Conversation {
  providerSessionId: string | null;
  systemPrompt: string | null;
}

function toRecord(row: Row): ConversationRecord {
  const id = String(row.id);
  const agentId = String(row.agent_id);
  return {
    id,
    agentId,
    routineId: (row.routine_id as string | null) ?? null,
    title: String(row.title),
    modelId: String(row.model_id),
    provider: (row.provider as ProviderId | null) ?? null,
    pinned: Boolean(row.pinned),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    computer: getComputerSummary(agentId),
    providerSessionId: (row.provider_session_id as string | null) ?? null,
    systemPrompt: (row.system_prompt as string | null) ?? null,
  };
}

export function toPublicConversation(record: ConversationRecord): Conversation {
  const { providerSessionId: _s, systemPrompt: _p, ...conversation } = record;
  return conversation;
}

type ConversationPatch = Partial<{
  title: string;
  pinned: boolean;
  modelId: string;
  provider: ProviderId | null;
  providerSessionId: string | null;
  systemPrompt: string | null;
}>;

export const conversations = {
  list(agentId?: string): Conversation[] {
    const rows = (
      agentId
        ? db.prepare(`SELECT * FROM conversations WHERE agent_id = ? ORDER BY updated_at DESC`).all(agentId)
        : db.prepare(`SELECT * FROM conversations ORDER BY updated_at DESC`).all()
    ) as Row[];
    return rows.map((row) => toPublicConversation(toRecord(row)));
  },

  get(id: string): ConversationRecord | null {
    const row = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  },

  create(input: { agentId: string; modelId: string; title?: string; routineId?: string }): ConversationRecord {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO conversations (id, agent_id, routine_id, title, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.agentId, input.routineId ?? null, input.title ?? "New chat", input.modelId, now, now);
    return conversations.get(id)!;
  },

  update(id: string, patch: ConversationPatch, touch = false): ConversationRecord | null {
    const columns: Record<string, string | number | null | undefined> = {
      title: patch.title,
      pinned: patch.pinned === undefined ? undefined : Number(patch.pinned),
      model_id: patch.modelId,
      provider: patch.provider,
      provider_session_id: patch.providerSessionId,
      system_prompt: patch.systemPrompt,
      updated_at: touch ? Date.now() : undefined,
    };
    const entries = Object.entries(columns).filter(([, v]) => v !== undefined);
    if (entries.length) {
      db.prepare(
        `UPDATE conversations SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`,
      ).run(...(entries.map(([, v]) => v) as (string | number | null)[]), id);
    }
    return conversations.get(id);
  },

  delete(id: string): void {
    db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
  },
};
