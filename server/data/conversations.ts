import { randomUUID } from "node:crypto";
import type { Conversation, ConversationKind, ConversationOrigin, ForkOrigin, ProviderId, TaskInfo } from "../../shared/types.ts";
import { db, parseJson, type Row } from "../db.ts";
import { getComputerSummary } from "./computers.ts";

/** Module 02's task fields, for tasks saved before they existed. */
export const ORCHESTRATION_DEFAULTS: Pick<TaskInfo, "role" | "tier" | "provider" | "depth" | "group" | "then" | "brief" | "result" | "handoff" | "resumeAt"> = {
  role: null,
  tier: null,
  provider: null,
  depth: 1,
  group: null,
  then: null,
  brief: null,
  result: null,
  handoff: null,
  resumeAt: null,
};

function toTaskInfo(value: unknown): TaskInfo | null {
  const task = parseJson<TaskInfo | null>(value, null);
  return task && { ...ORCHESTRATION_DEFAULTS, ...task };
}

/** Server-side view of a conversation, including provider session state. */
export interface ConversationRecord extends Conversation {
  providerSessionId: string | null;
  systemPrompt: string | null;
  /** Tasks started from this chat that finished since its model last heard about them. */
  childResults: string[];
  /** Results came in that the chat hasn't been woken about yet (tasks/wake.ts). */
  wakePending: boolean;
  /** Tokens the chat's wake-up turns used, counted in its mission's budget. */
  wakeTokens: number;
  /** Notes brought back from its forks, for its next turn (chats/fork.ts). */
  mergeNotes: MergeNote[];
}

export interface MergeNote {
  forkId: string;
  note: string;
  at: number;
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
    task: toTaskInfo(row.task),
    providerSessionId: (row.provider_session_id as string | null) ?? null,
    systemPrompt: (row.system_prompt as string | null) ?? null,
    childResults: parseJson<string[]>(row.child_results, []),
    forkedFrom: parseJson<ForkOrigin | null>(row.forked_from, null),
    wakePending: Boolean(row.wake_pending),
    wakeTokens: Number(row.wake_tokens ?? 0),
    mergeNotes: parseJson<MergeNote[]>(row.merge_notes, []),
    projectId: (row.project_id as string | null) ?? null,
    // Module 11: only a project's Lead carries the flag.
    ...(row.lead ? { lead: true } : {}),
  };
}

export function toPublicConversation(record: ConversationRecord): Conversation {
  const { providerSessionId: _s, systemPrompt: _p, childResults: _c, wakePending: _w, wakeTokens: _t, mergeNotes: _m, ...conversation } = record;
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
  wakePending: boolean;
  wakeTokens: number;
  mergeNotes: MergeNote[];
  projectId: string | null;
  origin: ConversationOrigin | null;
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

  /** Every chat and task in a project, any agent's, newest first. */
  inProject(projectId: string): ConversationRecord[] {
    return (db.prepare(`SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC`).all(projectId) as Row[]).map(toRecord);
  },

  /** Module 11: the id of the project's Lead chat, or null (server/lead/). */
  leadOf(projectId: string): string | null {
    const row = db.prepare(`SELECT id FROM conversations WHERE project_id = ? AND lead = 1 ORDER BY created_at LIMIT 1`).get(projectId) as Row | undefined;
    return row ? String(row.id) : null;
  },

  /** Chats forked from this one. */
  forksOf(id: string): ConversationRecord[] {
    return (db.prepare(`SELECT * FROM conversations WHERE json_extract(forked_from, '$.conversationId') = ?`).all(id) as Row[]).map(toRecord);
  },

  /** Chats with results they haven't been woken about yet. */
  wakePending(): ConversationRecord[] {
    return (db.prepare(`SELECT * FROM conversations WHERE wake_pending = 1`).all() as Row[]).map(toRecord);
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
    forkedFrom?: ForkOrigin | null;
    projectId?: string | null;
    /** Module 11: the project's Lead chat. */
    lead?: boolean;
  }): ConversationRecord {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO conversations (id, agent_id, routine_id, title, model_id, origin, kind, parent_id, task, forked_from, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.forkedFrom ? JSON.stringify(input.forkedFrom) : null,
      input.projectId ?? null,
      now,
      now,
    );
    if (input.lead) db.prepare(`UPDATE conversations SET lead = 1 WHERE id = ?`).run(id);
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
      wake_pending: patch.wakePending === undefined ? undefined : Number(patch.wakePending),
      wake_tokens: patch.wakeTokens,
      merge_notes: patch.mergeNotes && JSON.stringify(patch.mergeNotes),
      project_id: patch.projectId,
      origin: patch.origin === undefined ? undefined : patch.origin && JSON.stringify(patch.origin),
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
