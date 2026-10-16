import { grantFor } from "../projects/checkout.ts";
import { FINISHED, taskStore, type TaskRecord } from "../tasks/store.ts";
import { worktrees } from "../tasks/worktree.ts";
import { noticeIfFinished } from "./best-of.ts";

/**
 * What mission control (module 09) does when a task finishes: its diff stats are refreshed (the run
 * loop records them after every turn, but a task can also end between turns: stopped, failed), and
 * a best-of group whose last run just ended tells its chat.
 */

async function refreshStats(task: TaskRecord): Promise<void> {
  const repo = task.task.repo;
  if (!repo?.headSha) return;
  try {
    const stats = await worktrees.stats(task.agentId, repo, grantFor(task));
    if (taskStore.get(task.id)) taskStore.patch(task.id, { stats });
  } catch {
    // The worktree is gone (discarded, cleaned up) or the folder can't be used right now: keep the last stats.
  }
}

let unsubscribe: (() => void) | null = null;

export const missionWatch = {
  start(): void {
    unsubscribe ??= taskStore.onChange((task, from) => {
      if (!FINISHED.has(task.task.status) || FINISHED.has(from)) return;
      noticeIfFinished(task);
      void refreshStats(task);
    });
  },

  stop(): void {
    unsubscribe?.();
    unsubscribe = null;
  },
};
