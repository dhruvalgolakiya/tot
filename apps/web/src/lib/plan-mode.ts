import { create } from "zustand";

/**
 * Plan mode, per chat: while it's on, the chat's messages ask the agent to investigate and propose a plan, changing
 * nothing (SendMessageRequest.plan). Kept on this device while TOT is open; a chat not sent yet keeps it under DRAFT
 * until its first message gives it an id. A finished plan offers "Implement this plan" until it's used or dismissed.
 */

export const DRAFT = "draft";

interface PlanModeState {
  on: ReadonlySet<string>;
  /** Plan replies whose follow-up row was dismissed. */
  dismissed: ReadonlySet<string>;
}

export const usePlanMode = create<PlanModeState>()(() => ({ on: new Set(), dismissed: new Set() }));

function toggled(set: ReadonlySet<string>, key: string, on: boolean): ReadonlySet<string> {
  if (set.has(key) === on) return set;
  const next = new Set(set);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

export function setPlanMode(key: string, on: boolean) {
  usePlanMode.setState((s) => ({ on: toggled(s.on, key, on) }));
}

/** The chat not sent yet got its id: its plan mode goes with it. */
export function adoptDraftPlanMode(conversationId: string) {
  usePlanMode.setState((s) => (s.on.has(DRAFT) ? { on: toggled(toggled(s.on, DRAFT, false), conversationId, true) } : s));
}

export function dismissPlanFollowUp(messageId: string) {
  usePlanMode.setState((s) => ({ dismissed: toggled(s.dismissed, messageId, true) }));
}

/** "/plan …" or "/default …" typed in full at the start of a message: the mode, and the rest of the message. */
export function modeCommand(text: string): { plan: boolean; rest: string } | null {
  const match = /^\/(plan|default)(?:\s+([\s\S]*))?$/i.exec(text.trimStart());
  if (!match) return null;
  return { plan: match[1]!.toLowerCase() === "plan", rest: (match[2] ?? "").trim() };
}

/** What the "Implement this plan" row sends. */
export const IMPLEMENT_PLAN = "Implement the plan above.";
