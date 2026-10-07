import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { HttpError, sendMessage } from "../agent/orchestrator.ts";
import { runRegistry } from "../agent/runs.ts";
import { appEvents } from "../app-events.ts";
import { agents } from "../data/agents.ts";
import { conversations, toPublicConversation } from "../data/conversations.ts";
import { messages } from "../data/messages.ts";
import { db, type Row } from "../db.ts";
import { leads } from "../lead/lead.ts";
import { runEnd } from "../tasks/run-loop.ts";
import { projects } from "./projects.ts";

/**
 * A new project's first request (roadmap module 12, lane B): "What do you want built first?" in the New project
 * dialog (CreateProjectRequest.firstMessage). It's kept (project_first_requests, so a restart loses nothing) until
 * the project is ready — at once, or for a folder on this Mac once the user allows it — then TOT opens the
 * project's Lead and sends it there as the user's own message, once. If it can't be sent (no model connected),
 * the Lead's chat says so, with the request, so nothing typed is lost.
 */

const MAX_TEXT = 8000;
/** Attempts to send while someone else keeps the Lead busy (each waits for that turn to end). */
const BUSY_RETRIES = 20;

let send = sendMessage;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Whether agents can work in the project now: a folder on this Mac needs the user's OK first. */
function ready(projectId: string): boolean {
  const project = projects.get(projectId);
  return Boolean(project && !project.archived && (project.kind !== "folder" || project.folderGranted));
}

/** The request is the user's: if it couldn't go, the Lead's chat keeps it, with why. */
function couldntSend(leadId: string, text: string, why: string): void {
  const clipped = text.length > 1000 ? `${text.slice(0, 999).trimEnd()}…` : text;
  const reason = /[.!?]$/.test(why.trim()) ? why.trim() : `${why.trim()}.`;
  messages.insert({
    id: randomUUID(),
    conversationId: leadId,
    role: "assistant",
    parts: [{ type: "notice", id: `n_${randomUUID().slice(0, 12)}`, kind: "warning", text: `Your first request wasn't sent: ${reason} It was: “${clipped}”` }],
    status: "complete",
    createdAt: Date.now(),
  });
  const record = conversations.update(leadId, {}, true);
  if (record) appEvents.publish({ type: "conversation", conversation: toPublicConversation(record) });
}

export const firstRequests = {
  /** CreateProjectRequest.firstMessage checked before the project is made: its text, or null for none (400 when it can't be). */
  clean(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw new HttpError(400, "firstMessage is text.");
    const text = value.trim();
    if (text.length > MAX_TEXT) throw new HttpError(400, `Keep what you want built first under ${MAX_TEXT} characters.`);
    return text || null;
  },

  /** Keeps it for the new project, then sends it if the project is ready already. */
  async take(projectId: string, text: string, agentId: string | null): Promise<void> {
    db.prepare(`INSERT OR REPLACE INTO project_first_requests (project_id, text, agent_id, created_at) VALUES (?, ?, ?, ?)`).run(projectId, text, agentId, Date.now());
    await firstRequests.ready(projectId);
  },

  /** The project's request still waiting (it isn't ready yet), or null. */
  pending(projectId: string): string | null {
    const row = db.prepare(`SELECT text FROM project_first_requests WHERE project_id = ?`).get(projectId) as Row | undefined;
    return row ? String(row.text) : null;
  },

  /**
   * The project may be ready now (just made, or the user allowed its folder): its waiting request, if any, goes to
   * its Lead, once. Resolves when the Lead's turn has started (or it couldn't be sent); never throws.
   */
  async ready(projectId: string): Promise<void> {
    if (!ready(projectId)) return;
    const row = db.prepare(`SELECT * FROM project_first_requests WHERE project_id = ?`).get(projectId) as Row | undefined;
    if (!row) return;
    // Claimed first, so a grant and a create at once can't send it twice.
    if (Number(db.prepare(`DELETE FROM project_first_requests WHERE project_id = ?`).run(projectId).changes) === 0) return;
    const text = String(row.text);
    const agentId = typeof row.agent_id === "string" && agents.get(row.agent_id) ? row.agent_id : null;
    let leadId: string;
    try {
      leadId = leads.open(projectId, agentId).lead.id;
    } catch (err) {
      console.warn(`[tot] couldn't open the Lead of project ${projectId} for its first request:`, errorText(err));
      return;
    }
    for (let attempt = 0; attempt < BUSY_RETRIES; attempt++) {
      // A Lead already in a turn (a project the user went on with while its folder waited): after that turn.
      const run = runRegistry.activeFor(leadId);
      if (run) {
        await runEnd(run.id);
        continue;
      }
      try {
        await send(leadId, { text });
        return;
      } catch (err) {
        // Someone started a turn there just now: try again in a moment.
        if (err instanceof HttpError && err.status === 409) {
          await sleep(500);
          continue;
        }
        return couldntSend(leadId, text, errorText(err));
      }
    }
    couldntSend(leadId, text, "the Lead stayed busy");
  },

  /** Tests: send with a fake instead of the real models. */
  useSender(fake: typeof sendMessage): void {
    send = fake;
  },
};
