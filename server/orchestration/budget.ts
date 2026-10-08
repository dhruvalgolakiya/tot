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

/** "17.8M", "15M", "850k", "1.5k": a token count, short. */
export function shortTokens(count: number): string {
  const short = (value: number, unit: string) => `${value >= 100 ? Math.round(value) : Number(value.toFixed(1))}${unit}`;
  if (count >= 1_000_000) return short(count / 1_000_000, "M");
  if (count >= 1000) return short(count / 1000, "k");
  return String(count);
}

/**
 * Whose budget ran out and by how much, e.g. "the tasks from this chat used 17.8M of their 15M-token budget":
 * the chat's tasks, this (top-level) task, or the tasks of the task everything started from.
 */
export function budgetUsedLine(conversation: ConversationRecord, spent: { used: number; budget: number }): string {
  const root = missionRoot(conversation);
  const amounts = `${shortTokens(spent.used)} of`;
  if (root.kind !== "task") return `the tasks from this chat used ${amounts} their ${shortTokens(spent.budget)}-token budget`;
  if (root.id === conversation.id) return `this task used ${amounts} its ${shortTokens(spent.budget)}-token budget`;
  return `the tasks from “${root.title}” used ${amounts} their ${shortTokens(spent.budget)}-token budget`;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Why a task paused for the budget: before its first turn it didn't start at all. */
export function budgetPauseText(task: ConversationRecord & { task: { turns: number } }, spent: { used: number; budget: number }): string {
  return `${task.task.turns === 0 ? "Didn't start" : "Paused"}: ${budgetUsedLine(task, spent)}. Raise it in Settings → Tasks, then resume.`;
}

/** Throws (400) when resuming the task would only pause it again: its mission is over budget. */
export function checkResume(task: ConversationRecord): void {
  const spent = overBudget(task);
  if (spent) throw new HttpError(400, `Can't resume yet: ${budgetUsedLine(task, spent)}. Raise it in Settings → Tasks first.`);
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
    throw new HttpError(400, `${capitalize(budgetUsedLine(parent, spent))}. Raise it in Settings → Tasks to start more.`);
  }
}
