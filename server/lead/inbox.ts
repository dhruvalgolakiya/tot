import type { LeadSignal } from "../../shared/types.ts";

/**
 * Module 12 (docs/roadmap/12-coordinator.md): a project Lead's inbox. Lane A implements it; lane B's schedules
 * post to it. `post` stores a signal, shows it in the Lead's chat as a notice, and wakes the Lead (batched,
 * bounded). It returns the stored signal, or null when it's a duplicate or the project has no Lead yet.
 */
export type NewSignal = Omit<LeadSignal, "id" | "projectId" | "at" | "readAt">;

export const leadInbox = {
  post(_projectId: string, _signal: NewSignal): LeadSignal | null {
    return null;
  },
};
