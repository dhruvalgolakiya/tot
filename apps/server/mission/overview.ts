import type { MissionOverlap, MissionOverview } from "@tot/shared/types";
import { conversations } from "../data/conversations.ts";
import { FINISHED, isTask, toPublic, type TaskRecord } from "../tasks/store.ts";

/**
 * Mission control's board (module 09, GET /api/mission): every task that's open, finished but not
 * landed yet, or landed in the last day. Unlanded tasks on the same repo folder that change the
 * same files overlap (they'd conflict when both land; a best-of run's alternatives don't count);
 * finished ones come in a land order, fewest overlaps first, then the smallest change. Computed
 * from the tasks' own `stats`, so it's cheap.
 */

const DAY_MS = 24 * 60 * 60_000;

export interface MissionFilter {
  projectId?: string | null;
  agentId?: string | null;
  /** One group (a best-of run, or tasks split from one job): all of them, whatever the board would show. */
  group?: string | null;
}

/** Has a branch with something on it to land (or discard). */
const hasCode = (task: TaskRecord) => Boolean(task.task.repo?.headSha);
const unlanded = (task: TaskRecord) => !task.task.landing;

/** Whether the board shows the task: open; or finished with code and not landed; or landed (or finished without code) in the last day. */
export function onBoard(task: TaskRecord, now = Date.now()): boolean {
  const { status, landing, finishedAt } = task.task;
  if (landing) return now - landing.at < DAY_MS;
  if (!FINISHED.has(status)) return true;
  if (hasCode(task)) return true;
  return now - (finishedAt ?? task.updatedAt) < DAY_MS;
}

/** Runs of one best-of group are alternatives (only one lands): they don't count as overlapping each other. */
const alternatives = (a: TaskRecord, b: TaskRecord) => a.task.groupKind === "best-of" && Boolean(a.task.group) && a.task.group === b.task.group;

/** For each unlanded task with stats: the other unlanded tasks on the same repo folder that change some of the same paths. */
export function findOverlaps(tasks: TaskRecord[]): Map<string, MissionOverlap[]> {
  const byFolder = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    const folder = task.task.repo?.folder;
    if (!folder || !unlanded(task) || !task.task.stats?.paths.length) continue;
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), task]);
  }
  const overlaps = new Map<string, MissionOverlap[]>();
  for (const group of byFolder.values()) {
    for (const task of group) {
      const mine = new Set(task.task.stats!.paths);
      const found = group
        .filter((other) => other.id !== task.id && !alternatives(task, other))
        .map((other) => ({ taskId: other.id, paths: other.task.stats!.paths.filter((path) => mine.has(path)) }))
        .filter((overlap) => overlap.paths.length > 0);
      if (found.length) overlaps.set(task.id, found);
    }
  }
  return overlaps;
}

/** Finished, unlanded tasks with code (done or stopped; failed ones need the user first), in the order to land them. */
export function landOrder(tasks: TaskRecord[], overlaps: Map<string, MissionOverlap[]>): string[] {
  const size = (task: TaskRecord) => (task.task.stats ? task.task.stats.added + task.task.stats.removed : 0);
  const shared = (task: TaskRecord) => (overlaps.get(task.id) ?? []).reduce((sum, overlap) => sum + overlap.paths.length, 0);
  return tasks
    .filter((task) => unlanded(task) && hasCode(task) && (task.task.status === "done" || task.task.status === "stopped"))
    .sort(
      (a, b) =>
        (overlaps.get(a.id)?.length ?? 0) - (overlaps.get(b.id)?.length ?? 0) ||
        shared(a) - shared(b) ||
        size(a) - size(b) ||
        (a.task.finishedAt ?? 0) - (b.task.finishedAt ?? 0),
    )
    .map((task) => task.id);
}

export function missionOverview(filter: MissionFilter = {}, now = Date.now()): MissionOverview {
  const all = conversations.tasks().filter(isTask);
  // Overlaps count every unlanded task, also those outside the filter (another agent's, another group's).
  const overlaps = findOverlaps(all);
  const shown = all
    .filter((task) => (filter.group ? task.task.group === filter.group : onBoard(task, now)))
    .filter((task) => !filter.projectId || task.projectId === filter.projectId)
    .filter((task) => !filter.agentId || task.agentId === filter.agentId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    tasks: shown.map((task) => ({ conversation: toPublic(task), overlaps: overlaps.get(task.id) ?? [] })),
    landOrder: landOrder(shown, overlaps),
  };
}
