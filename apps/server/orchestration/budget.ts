import { HttpError } from "../agent/orchestrator.ts";
import { conversations, type ConversationRecord } from "../data/conversations.ts";
import { settings } from "../data/settings.ts";
import { MAX_DEPTH } from "../tasks/prompt.ts";

/**
 * Limits on spawning: tasks go at most two levels below the user's chat, and a chat or task starts
 * at most a handful of tasks (Settings → Tasks, default 6). There's no token budget: a chat's tasks
 * run until they're done.
 */

/**
 * A project's Lead (module 11) runs its project for as long as the project lasts: its limits count the work
 * still in flight (open, or finished with code not yet landed), not every task it ever started.
 */
function inFlight(task: ConversationRecord): boolean {
  if (!task.task || task.task.landing) return false;
  return !["done", "failed", "stopped"].includes(task.task.status) || Boolean(task.task.repo?.headSha);
}

/** The depth a new task under `parent` would have. */
export const childDepth = (parent: ConversationRecord): number => (parent.kind === "task" && parent.task ? parent.task.depth + 1 : 1);

/** Throws (400) when `parent` may not start `count` more tasks. */
export function checkSpawn(parent: ConversationRecord, count: number): void {
  if (childDepth(parent) > MAX_DEPTH) {
    throw new HttpError(400, `Tasks go at most ${MAX_DEPTH} levels deep; this one can't start tasks of its own. Do the work here instead.`);
  }
  const { maxChildren } = settings.get().tasks;
  const existing = conversations.tasks({ parentId: parent.id }).filter((child) => !parent.lead || inFlight(child)).length;
  if (existing + count > maxChildren) {
    throw new HttpError(400, `A chat or task can start at most ${maxChildren} tasks (it has ${existing}). Combine the work into fewer tasks.`);
  }
}
