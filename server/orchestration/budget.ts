import { HttpError } from "../agent/orchestrator.ts";
import { conversations, type ConversationRecord } from "../data/conversations.ts";
import { settings } from "../data/settings.ts";
import { MAX_DEPTH } from "../tasks/prompt.ts";

/**
 * Limits on spawning: tasks go at most two levels below the user's chat, a chat or task starts
 * at most a handful of tasks (Settings → Tasks, default 6), and a mission — a chat (or a
 * top-level task) with everything below it — has a token budget.
 */

/** The top of a task's mission: the chat (or top-level task) everything started from. */
export function missionRoot(conversation: ConversationRecord): ConversationRecord {
  let current = conversation;
  for (let hops = 0; current.parentId && hops < 10; hops++) {
    const parent = conversations.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

/**
 * A project's Lead (module 11) runs its project for as long as the project lasts: its limits count the work
 * still in flight (open, or finished with code not yet landed), not every task it ever started.
 */
function inFlight(task: ConversationRecord): boolean {
  if (!task.task || task.task.landing) return false;
  return !["done", "failed", "stopped"].includes(task.task.status) || Boolean(task.task.repo?.headSha);
}

/** Tokens used by every task under a mission's root (and the root: its own turns when it's a task, its wake-ups when it's a chat). */
export function missionUsage(root: ConversationRecord): number {
  let total = (root.task ? root.task.usage.inputTokens + root.task.usage.outputTokens : 0) + (root.lead ? 0 : root.wakeTokens);
  const queue = [root.id];
  for (let i = 0; i < queue.length && i < 200; i++) {
    for (const child of conversations.tasks({ parentId: queue[i] })) {
      if (root.lead && queue[i] === root.id && !inFlight(child)) continue;
      if (child.task) total += child.task.usage.inputTokens + child.task.usage.outputTokens;
      queue.push(child.id);
    }
  }
  return total;
}

/** Whether a mission has used up its budget (Settings → Tasks; 0 = no limit). */
export function overBudget(conversation: ConversationRecord): { used: number; budget: number } | null {
  const budget = settings.get().tasks.missionTokenBudget;
  if (!budget) return null;
  const used = missionUsage(missionRoot(conversation));
  return used >= budget ? { used, budget } : null;
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
  const spent = overBudget(parent);
  if (spent) {
    throw new HttpError(400, `This work has used its token budget (${Math.round(spent.used / 1000)}k of ${Math.round(spent.budget / 1000)}k tokens). Raise it in Settings → Tasks to start more.`);
  }
}
