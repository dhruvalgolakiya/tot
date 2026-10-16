import type { ProjectSubscriptions, PullRequestWatch, UpdateProjectSubscriptionsRequest } from "@tot/shared/types";
import { HttpError } from "../agent/orchestrator.ts";
import { db, parseJson, type Row } from "../db.ts";

/**
 * Module 12 (docs/roadmap/12-coordinator.md), lane A: what a project's Lead hears about on its own. For now that's
 * which pull requests it watches: none, the draft PRs TOT opened for the project's tasks (the default), or every
 * open PR in the project's GitHub repos. Kept as JSON on the project's row (null = the default).
 */

export const DEFAULT_SUBSCRIPTIONS: ProjectSubscriptions = { pullRequests: "tot" };

const WATCHES: readonly PullRequestWatch[] = ["off", "tot", "all"];

/** A project row's subscriptions, the default filled in. */
export function subscriptionsOf(value: unknown): ProjectSubscriptions {
  const stored = parseJson<Partial<ProjectSubscriptions>>(value, {});
  return { pullRequests: WATCHES.includes(stored.pullRequests as PullRequestWatch) ? stored.pullRequests! : DEFAULT_SUBSCRIPTIONS.pullRequests };
}

export const projectSubscriptions = {
  /** The project's subscriptions; null when there's no such project. */
  get(projectId: string): ProjectSubscriptions | null {
    const row = db.prepare(`SELECT subscriptions FROM projects WHERE id = ?`).get(projectId) as Row | undefined;
    return row ? subscriptionsOf(row.subscriptions) : null;
  },

  /** Changes what's given; the rest stays. 400 for a value that isn't one. */
  update(projectId: string, patch: UpdateProjectSubscriptionsRequest): ProjectSubscriptions {
    const current = projectSubscriptions.get(projectId);
    if (!current) throw new HttpError(404, "Project not found.");
    if (!patch || typeof patch !== "object") throw new HttpError(400, "Expected { pullRequests }.");
    const next = { ...current };
    if (patch.pullRequests !== undefined) {
      if (!WATCHES.includes(patch.pullRequests)) throw new HttpError(400, `pullRequests is one of: ${WATCHES.join(", ")}.`);
      next.pullRequests = patch.pullRequests;
    }
    db.prepare(`UPDATE projects SET subscriptions = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(next), Date.now(), projectId);
    return next;
  },
};
