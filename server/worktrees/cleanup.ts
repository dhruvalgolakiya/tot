import { conversations } from "../data/conversations.ts";
import { settings } from "../data/settings.ts";
import { grantFor } from "../projects/checkout.ts";
import { runLoop } from "../tasks/run-loop.ts";
import { FINISHED, isTask, taskStore } from "../tasks/store.ts";
import { worktrees } from "../tasks/worktree.ts";
import { previews } from "./preview.ts";

/**
 * Worktree cleanup (module 09): the worktrees of tasks that finished (done, failed or stopped) and were
 * never landed are removed once they finished more than tasks.worktreeCleanupDays ago (14 by default;
 * 0 = never), by a daily sweep or on demand (Settings → Tasks, POST /api/worktrees/cleanup). Branches
 * always stay, so nothing is lost: the task's repo.headSha goes back to null, and picking it up again
 * makes its worktree (and runs its setup) again. Its preview stops and its ports are given back.
 */

const DAY_MS = 24 * 60 * 60_000;
/** The first sweep waits until TOT has settled after starting. */
const FIRST_SWEEP_MS = 10 * 60_000;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

let timers: NodeJS.Timeout[] = [];
let sweeping: Promise<{ removed: number }> | null = null;

async function sweep(days: number, now: number): Promise<{ removed: number }> {
  if (!days) return { removed: 0 };
  const cutoff = now - days * DAY_MS;
  let removed = 0;
  for (const record of conversations.tasks()) {
    if (!isTask(record)) continue;
    const { status, finishedAt, landing, repo } = record.task;
    if (!FINISHED.has(status) || landing || !repo?.headSha || !finishedAt || finishedAt > cutoff || runLoop.isRunning(record.id)) continue;
    try {
      await previews.stop(record.id);
      await worktrees.remove(record.agentId, repo, { grant: grantFor(record) });
      taskStore.patch(record.id, { repo: { ...repo, headSha: null }, ports: null, setup: null });
      removed++;
    } catch (err) {
      console.warn(`[tot] couldn't clean up the worktree of task ${record.id}:`, errorText(err));
    }
  }
  if (removed) console.log(`[tot] removed ${removed} old task worktree${removed === 1 ? "" : "s"} (branches kept)`);
  return { removed };
}

export const worktreeCleanup = {
  /** Removes old worktrees now; `days` overrides the setting (the "Clean up now" button sends what's on screen). */
  run({ days, now = Date.now() }: { days?: number; now?: number } = {}): Promise<{ removed: number }> {
    // One sweep at a time: the button and the timer mustn't remove the same worktree twice.
    const previous = sweeping ?? Promise.resolve({ removed: 0 });
    const next = previous.catch(() => ({ removed: 0 })).then(() => sweep(days ?? settings.get().tasks.worktreeCleanupDays, now));
    sweeping = next;
    void next
      .finally(() => {
        if (sweeping === next) sweeping = null;
      })
      .catch(() => {});
    return next;
  },

  /** The daily sweep. */
  start(): void {
    if (timers.length) return;
    const tick = () => void worktreeCleanup.run().catch((err) => console.warn("[tot] worktree cleanup failed:", errorText(err)));
    timers = [setTimeout(tick, FIRST_SWEEP_MS), setInterval(tick, DAY_MS)];
    for (const timer of timers) timer.unref();
  },

  stop(): void {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  },
};
