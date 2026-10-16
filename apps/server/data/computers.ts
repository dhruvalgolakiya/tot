import { randomUUID } from "node:crypto";
import type { ComputerKind, ComputerState, ComputerSummary } from "@tot/shared/types";
import { db, parseJson, statement, type Row } from "../db.ts";

/** Each agent owns at most one computer, shared by all of its chats. */
export interface ComputerRecord extends ComputerSummary {
  agentId: string;
  createdAt: number;
}

function toRecord(row: Row): ComputerRecord {
  const kind = row.kind as ComputerKind;
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    kind,
    state: row.state as ComputerState,
    label: String(row.label),
    externalId: (row.external_id as string | null) ?? undefined,
    desktopUrl: (row.desktop_url as string | null) ?? undefined,
    workspacePath: (row.workspace_path as string | null) ?? undefined,
    exposedUrls: parseJson(row.exposed_urls, []),
    gui: kind === "boat",
    screenshotUrl: (row.screenshot_url as string | null) ?? undefined,
    error: (row.error as string | null) ?? undefined,
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at == null ? undefined : Number(row.last_used_at),
  };
}

export function toSummary(record: ComputerRecord): ComputerSummary {
  const { agentId: _a, createdAt: _t, ...summary } = record;
  return summary;
}

type ComputerPatch = Partial<Omit<ComputerRecord, "id" | "agentId" | "createdAt" | "gui">>;

export const computers = {
  getByAgent(agentId: string): ComputerRecord | null {
    const row = statement(`SELECT * FROM computers WHERE agent_id = ?`).get(agentId) as Row | undefined;
    return row ? toRecord(row) : null;
  },

  list(): ComputerRecord[] {
    return (db.prepare(`SELECT * FROM computers`).all() as Row[]).map(toRecord);
  },

  create(input: { agentId: string; kind: ComputerKind; state: ComputerState; label: string }): ComputerRecord {
    db.prepare(
      `INSERT INTO computers (id, agent_id, kind, state, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), input.agentId, input.kind, input.state, input.label, Date.now(), Date.now());
    return computers.getByAgent(input.agentId)!;
  },

  update(agentId: string, patch: ComputerPatch): ComputerRecord | null {
    const columns: Record<string, unknown> = {
      kind: patch.kind,
      state: patch.state,
      label: patch.label,
      external_id: patch.externalId,
      desktop_url: patch.desktopUrl,
      workspace_path: patch.workspacePath,
      exposed_urls: patch.exposedUrls && JSON.stringify(patch.exposedUrls),
      screenshot_url: patch.screenshotUrl,
      error: "error" in patch ? (patch.error ?? null) : undefined,
      last_used_at: patch.lastUsedAt,
    };
    const entries = Object.entries(columns).filter(([, v]) => v !== undefined);
    if (entries.length) {
      db.prepare(`UPDATE computers SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE agent_id = ?`).run(
        ...(entries.map(([, v]) => v) as (string | number | null)[]),
        agentId,
      );
    }
    return computers.getByAgent(agentId);
  },

  delete(agentId: string): void {
    db.prepare(`DELETE FROM computers WHERE agent_id = ?`).run(agentId);
  },
};

export function getComputerSummary(agentId: string): ComputerSummary | null {
  const record = computers.getByAgent(agentId);
  return record ? toSummary(record) : null;
}
