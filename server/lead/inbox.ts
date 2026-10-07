import { randomUUID } from "node:crypto";
import type { LeadSignal, LeadSignalKind } from "../../shared/types.ts";
import { appEvents } from "../app-events.ts";
import { conversations, toPublicConversation } from "../data/conversations.ts";
import { messages } from "../data/messages.ts";
import { projects } from "../projects/projects.ts";
import { leadSignals } from "../signals/store.ts";
import { chatWakes } from "../tasks/wake.ts";

/**
 * Module 12 (docs/roadmap/12-coordinator.md): a project Lead's inbox. Lane A implements it; lane B's schedules
 * post to it. `post` stores a signal, shows it in the Lead's chat as a notice, and wakes the Lead (batched,
 * bounded). It returns the stored signal, or null when it's a duplicate or the project has no Lead yet.
 */
export type NewSignal = Omit<LeadSignal, "id" | "projectId" | "at" | "readAt">;

/** Kinds whose notice reads as a warning: something to fix. */
const WARNINGS: ReadonlySet<LeadSignalKind> = new Set(["ci-failed", "changes-requested", "pr-conflict"]);

export const leadInbox = {
  /**
   * `key` (optional) names the fact, e.g. "pr:acme/web#12:ci-failed:<sha>": the same key never stores a second
   * signal. Without one, a signal is a duplicate while an identical one is still unread (a schedule that fires
   * again before the Lead heard the last one).
   */
  post(projectId: string, signal: NewSignal, opts: { key?: string | null } = {}): LeadSignal | null {
    const project = projects.get(projectId);
    const leadId = project && !project.archived ? conversations.leadOf(project.id) : null;
    if (!project || !leadId) return null;
    const stored = leadSignals.add(project.id, signal, opts.key ?? null);
    if (!stored) return null;
    messages.insert({
      id: randomUUID(),
      conversationId: leadId,
      role: "assistant",
      parts: [{ type: "notice", id: `n_${randomUUID().slice(0, 12)}`, kind: WARNINGS.has(stored.kind) ? "warning" : "info", text: stored.title }],
      status: "complete",
      createdAt: stored.at,
    });
    const record = conversations.update(leadId, {}, true);
    if (record) appEvents.publish({ type: "conversation", conversation: toPublicConversation(record) });
    chatWakes.flagSignals(leadId);
    return stored;
  },
};
