import { randomUUID } from "node:crypto";
import type { ProviderId, Role, Tier } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { conversations } from "../data/conversations.ts";
import type { TaskRecord } from "../tasks/store.ts";
import { tasks } from "../tasks/tasks.ts";
import { checkSpawn } from "./budget.ts";

/**
 * Starting sessions from a chat or a task, one or several at once. Each child gets a brief
 * (goal, constraints, what to read, what done means) instead of the parent's transcript, runs
 * as a task with its role's tier, and reports a structured result. Several spawned together
 * share a group; with then: "synthesize" the parent gets one writer turn with all their
 * results when the last one finishes (see fanin.ts).
 */

export interface SpawnSpec {
  title?: string;
  goal: string;
  role?: Role;
  tier?: Tier;
  provider?: ProviderId;
  repo?: string;
  baseBranch?: string;
  constraints?: string[];
  context?: string[];
  done?: string;
}

/** How the cards get into the parent: into the agent's reply (a tool), or as a message of their own. */
export type CardPlacement = { kind: "reply" } | { kind: "message"; text: string; userText?: string } | { kind: "none" };

export function spawnMany(parentId: string, specs: SpawnSpec[], opts: { then?: "synthesize"; cards: CardPlacement }): TaskRecord[] {
  const parent = conversations.get(parentId);
  if (!parent) throw new HttpError(404, "Chat not found.");
  if (!specs.length) throw new HttpError(400, "Say which tasks to start.");
  checkSpawn(parent, specs.length);
  const group = specs.length > 1 || opts.then ? randomUUID() : null;
  const started = specs.map((spec) =>
    tasks.create({
      agentId: parent.agentId,
      parentId,
      modelId: parent.modelId,
      title: spec.title,
      goal: spec.goal,
      role: spec.role,
      tier: spec.tier,
      provider: spec.provider,
      repo: spec.repo,
      baseBranch: spec.baseBranch,
      group,
      then: opts.then ?? null,
      brief: { goal: spec.goal, constraints: spec.constraints ?? [], context: spec.context ?? [], done: spec.done ?? "" },
    }),
  );
  if (opts.cards.kind === "reply") tasks.showCards(parentId, started.map((task) => task.id));
  if (opts.cards.kind === "message") tasks.showCards(parentId, started.map((task) => task.id), { text: opts.cards.text, userText: opts.cards.userText });
  return started;
}
