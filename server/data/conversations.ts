import { randomUUID } from "node:crypto";
import type { Conversation, ConversationKind, ConversationOrigin, ProviderId, TaskInfo } from "../../shared/types.ts";
import { db, parseJson, type Row } from "../db.ts";
import { getComputerSummary } from "./computers.ts";

/** Server-side view of a conversation, including provider session state. */
export interface ConversationRecord extends Conversation {
  providerSessionId: string | null;
  systemPrompt: string | null;
  /** Tasks started from this chat that finished since its model last heard about them. */
  childResults: string[];
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
    origin: parseJson<ConversationOrigin | null>(row.origin, null),
    kind: (row.kind as ConversationKind | null) ?? "chat",
    parentId: (row.parent_id as string | null) ?? null,
    task: parseJson<TaskInfo | null>(row.task, null),
    providerSessionId: (row.provider_session_id as string | null) ?? null,
    systemPrompt: (row.system_prompt as string | null) ?? null,
    childResults: parseJson<string[]>(row.child_results, []),
  };
}

export function toPublicConversation(record: ConversationRecord): Conversation {
  const { providerSessionId: _s, systemPrompt: _p, childResults: _c, ...conversation } = record;
  return conversation;
}

type ConversationPatch = Partial<{
  title: string;
  pinned: boolean;
  modelId: string;
  provider: ProviderId | null;
  providerSessionId: string | null;
  systemPrompt: string | null;
  kind: ConversationKind;
  parentId: string | null;
  task: TaskInfo | null;
  childResults: string[];
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

  /** Tasks, newest first; optionally one agent's, or those started from one chat. */
  tasks(filter: { agentId?: string; parentId?: string } = {}): ConversationRecord[] {
    const where = ["kind = 'task'"];
    const args: string[] = [];
    if (filter.agentId) {
      where.push("agent_id = ?");
      args.push(filter.agentId);
    }
    if (filter.parentId) {
      where.push("parent_id = ?");
      args.push(filter.parentId);
    }
    const rows = db.prepare(`SELECT * FROM conversations WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC`).all(...args) as Row[];
    return rows.map(toRecord);
  },

  get(id: string): ConversationRecord | null {
    const row = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  },

  create(input: {
    agentId: string;
    modelId: string;
    title?: string;
    routineId?: string;
    origin?: ConversationOrigin;
    kind?: ConversationKind;
    parentId?: string | null;
    task?: TaskInfo | null;
  }): ConversationRecord {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO conversations (id, agent_id, routine_id, title, model_id, origin, kind, parent_id, task, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.agentId,
      input.routineId ?? null,
      input.title ?? "New chat",
      input.modelId,
      input.origin ? JSON.stringify(input.origin) : null,
      input.kind ?? "chat",
      input.parentId ?? null,
      input.task ? JSON.stringify(input.task) : null,
      now,
      now,
    );
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
      kind: patch.kind,
      parent_id: patch.parentId,
      task: patch.task === undefined ? undefined : patch.task && JSON.stringify(patch.task),
      child_results: patch.childResults && JSON.stringify(patch.childResults),
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
