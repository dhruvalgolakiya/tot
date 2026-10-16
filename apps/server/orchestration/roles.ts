import type { ProviderId, Role, TaskBrief, TaskResult } from "../../shared/types.ts";

/**
 * What each kind of session is for. A role sets the session's default tier (Settings → Models)
 * and, for the reviewer, runs it on the other provider so the change gets fresh eyes. What the
 * reviewer checks belongs to the trust gates (module 03); this only decides who reviews.
 */

export const ROLES: Record<Role, { label: string; instructions: string; otherProvider?: true }> = {
  explorer: {
    label: "Explorer",
    instructions: "Read code and docs and answer where and how things work, with file paths and line numbers. Don't change files.",
  },
  planner: {
    label: "Planner",
    instructions: "Write the plan: the steps, the files involved, the risks, and how to test it. Don't change code.",
  },
  implementer: {
    label: "Implementer",
    instructions: "Make the change in your worktree, with tests, in small commits. Keep to the scope you were given.",
  },
  tester: {
    label: "Tester",
    instructions: "Write and run tests for the change. Report exactly what passes and what fails, with the commands you ran.",
  },
  reviewer: {
    label: "Reviewer",
    instructions:
      "Review the work with fresh eyes: correctness, edge cases, tests, and whether it stays in scope. Don't change code; report findings with file:line and how sure you are.",
    otherProvider: true,
  },
  researcher: {
    label: "Researcher",
    instructions: "Search and read primary sources. Every claim needs a source; never make one up. Put each source's URL in `sources`.",
  },
  writer: {
    label: "Writer",
    instructions: "Combine the results you're given into one clear, complete answer that keeps their sources.",
  },
};

export const ROLE_NAMES = Object.keys(ROLES) as Role[];

export const otherProvider = (provider: ProviderId): ProviderId => (provider === "claude" ? "chatgpt" : "claude");

/** The opening message of a child session: its brief, not the parent's transcript. */
export function renderBrief(brief: TaskBrief): string {
  const lines = [brief.goal.trim()];
  if (brief.constraints.length) lines.push(`Constraints:\n${brief.constraints.map((c) => `- ${c}`).join("\n")}`);
  if (brief.context.length) lines.push(`Read first:\n${brief.context.map((c) => `- ${c}`).join("\n")}`);
  if (brief.done.trim()) lines.push(`Done means: ${brief.done.trim()}`);
  return lines.join("\n\n");
}

const CONFIDENCE = new Set<TaskResult["confidence"]>(["low", "medium", "high"]);

/** A structured result from task_finish's arguments; missing lists are empty. */
export function toResult(summary: string, input: { findings?: string[]; files_changed?: string[]; open_questions?: string[]; confidence?: string; sources?: string[] }): TaskResult {
  const list = (items: string[] | undefined, max = 30) => (items ?? []).map((item) => item.trim().slice(0, 1000)).filter(Boolean).slice(0, max);
  return {
    summary: summary.trim().slice(0, 20_000),
    findings: list(input.findings),
    filesChanged: list(input.files_changed, 200),
    openQuestions: list(input.open_questions),
    confidence: CONFIDENCE.has(input.confidence as TaskResult["confidence"]) ? (input.confidence as TaskResult["confidence"]) : "medium",
    sources: list(input.sources, 50),
  };
}
