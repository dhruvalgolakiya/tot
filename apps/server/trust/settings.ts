import type { ProviderId, WorkflowSettings } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { db, parseJson, type Row } from "../db.ts";

/**
 * Settings → Workflows: whether plans wait for the user's OK, who reviews, how many fix rounds
 * before asking, and which built-in playbooks are off. Kept under their own key in the settings
 * table rather than in Settings, since they're this module's alone.
 */

interface Stored extends WorkflowSettings {
  /** Built-in playbooks the user turned off (custom ones keep their own flag). */
  disabledPlaybooks: string[];
}

const DEFAULTS: Stored = { requirePlanApproval: true, reviewer: "other", maxFixRounds: 3, disabledPlaybooks: [] };
const REVIEWERS: WorkflowSettings["reviewer"][] = ["other", "claude", "chatgpt"];

function read(): Stored {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'workflows'`).get() as Row | undefined;
  return { ...DEFAULTS, ...parseJson<Partial<Stored>>(row?.value, {}) };
}

function write(next: Stored): void {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('workflows', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(next));
}

const visible = ({ requirePlanApproval, reviewer, maxFixRounds }: Stored): WorkflowSettings => ({ requirePlanApproval, reviewer, maxFixRounds });

export const workflows = {
  get(): WorkflowSettings {
    return visible(read());
  },

  patch(patch: Partial<WorkflowSettings>): WorkflowSettings {
    const next = read();
    if (patch.requirePlanApproval !== undefined) {
      if (typeof patch.requirePlanApproval !== "boolean") throw new HttpError(400, "requirePlanApproval must be true or false.");
      next.requirePlanApproval = patch.requirePlanApproval;
    }
    if (patch.reviewer !== undefined) {
      if (!REVIEWERS.includes(patch.reviewer)) throw new HttpError(400, "The reviewer is other, claude or chatgpt.");
      next.reviewer = patch.reviewer;
    }
    if (patch.maxFixRounds !== undefined) {
      if (!Number.isInteger(patch.maxFixRounds) || patch.maxFixRounds < 1 || patch.maxFixRounds > 10) {
        throw new HttpError(400, "Max fix rounds must be a whole number from 1 to 10.");
      }
      next.maxFixRounds = patch.maxFixRounds;
    }
    write(next);
    return visible(next);
  },

  /** The provider that should review work written by `implementedBy` (undefined: no preference). */
  reviewerFor(implementedBy?: ProviderId): ProviderId | undefined {
    const { reviewer } = read();
    if (reviewer !== "other") return reviewer;
    return implementedBy ? (implementedBy === "claude" ? "chatgpt" : "claude") : undefined;
  },

  builtInEnabled(id: string): boolean {
    return !read().disabledPlaybooks.includes(id);
  },

  setBuiltInEnabled(id: string, enabled: boolean): void {
    const next = read();
    next.disabledPlaybooks = enabled ? next.disabledPlaybooks.filter((other) => other !== id) : [...new Set([...next.disabledPlaybooks, id])];
    write(next);
  },
};
