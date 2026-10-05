import { randomUUID } from "node:crypto";
import type { BestOfRequest, ProviderId } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { appEvents } from "../app-events.ts";
import { agents } from "../data/agents.ts";
import { conversations, toPublicConversation, type ConversationRecord } from "../data/conversations.ts";
import { messages } from "../data/messages.ts";
import { checkSpawn } from "../orchestration/budget.ts";
import { statuses } from "../orchestration/statuses.ts";
import { PROVIDERS, tierModel } from "../orchestration/tiers.ts";
import { cleanRequestId, taskRequests } from "../tasks/requests.ts";
import { FINISHED, type TaskRecord } from "../tasks/store.ts";
import { taskTitle, tasks } from "../tasks/tasks.ts";

/**
 * Best of N (module 09, POST /api/tasks/best-of): the same goal on several providers at once, one
 * task each with its provider pinned (and its strongest model), in its own worktree off the same
 * repo and base, all in one group with groupKind "best-of". They don't wake their chat one by one
 * (tasks/wake.ts skips them): once the last one finishes the chat gets one "Best of 2 finished"
 * notice, which opens the compare view.
 */

const LABELS: Record<ProviderId, string> = { claude: "Claude", chatgpt: "ChatGPT" };
const MAX_RUNS = 4;

function cleanProviders(value: unknown): ProviderId[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((id) => id !== "claude" && id !== "chatgpt")) throw new HttpError(400, 'Providers are "claude" and "chatgpt".');
  return value.length ? (value as ProviderId[]) : null;
}

/** "Fix cart total · Claude"; when one provider runs twice, "· Claude 1" and "· Claude 2". */
function runTitles(base: string, providers: ProviderId[]): string[] {
  return providers.map((provider, index) => {
    const twin = providers.filter((other) => other === provider).length > 1;
    const nth = providers.slice(0, index + 1).filter((other) => other === provider).length;
    return `${base} · ${LABELS[provider]}${twin ? ` ${nth}` : ""}`;
  });
}

/** "Claude and ChatGPT", "Claude twice". */
function runList(providers: ProviderId[]): string {
  const names = providers.map((provider) => LABELS[provider]);
  if (new Set(names).size === 1) return names.length === 2 ? `${names[0]} twice` : `${names[0]} ${names.length} times`;
  return names.length === 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export async function startBestOf(request: BestOfRequest): Promise<{ tasks: TaskRecord[]; repeat: boolean }> {
  const goal = typeof request.goal === "string" ? request.goal.trim() : "";
  if (!goal) throw new HttpError(400, "Say what the task should do.");
  const parent: ConversationRecord | null = request.conversationId ? conversations.get(request.conversationId) : null;
  if (request.conversationId && !parent) throw new HttpError(404, "Chat not found.");
  const agent = parent ? agents.get(parent.agentId) : request.agentId ? agents.get(request.agentId) : agents.first();
  if (!agent) throw new HttpError(404, "Agent not found.");

  // Every signed-in provider by default; two runs on the one there is when only one is.
  const signedIn = await statuses.get();
  const up = PROVIDERS.filter((provider) => signedIn.find((status) => status.id === provider)?.loggedIn);
  let providers = cleanProviders(request.providers) ?? up;
  if (!providers.length) throw new HttpError(400, "Connect Claude or ChatGPT first: best of runs on them.");
  if (providers.length === 1) providers = [providers[0]!, providers[0]!];
  if (providers.length > MAX_RUNS) throw new HttpError(400, `Best of runs at most ${MAX_RUNS} at once.`);
  if (parent) checkSpawn(parent, providers.length);

  const title = typeof request.title === "string" && request.title.trim() ? request.title.replace(/\s+/g, " ").trim().slice(0, 100) : taskTitle(goal);
  const titles = runTitles(title, providers);
  const start = () => {
    const group = randomUUID();
    return providers.map((provider, index) => {
      // Pinned: the provider's strongest model when it's signed in, else Auto with the provider preferred.
      const model = tierModel("deep", provider, signedIn);
      return tasks.create({
        agentId: agent.id,
        parentId: parent?.id ?? null,
        projectId: parent ? undefined : (request.projectId ?? null),
        modelId: model ? `${provider}:${model.model}` : "auto",
        title: titles[index],
        goal,
        provider,
        group,
        groupKind: "best-of",
      });
    });
  };
  const requestId = cleanRequestId(request.requestId);
  const started = parent ? taskRequests.once(parent.id, requestId, start) : taskRequests.onceTopLevel(agent.id, requestId, start);
  if (parent && !started.repeat && started.tasks.length) {
    const code = started.tasks[0]!.task.repo ? ", each on its own branch" : "";
    tasks.showCards(
      parent.id,
      started.tasks.map((task) => task.id),
      { userText: goal, text: `Best of ${started.tasks.length} on ${runList(providers)}${code}. Compare them when they finish.` },
    );
  }
  return started;
}

/** A best-of group's tasks: its chat's (or all top-level ones) in the group, oldest first. */
export function bestOfGroup(task: TaskRecord): TaskRecord[] {
  const group = task.task.group;
  if (!group) return [];
  const pool = task.parentId ? conversations.tasks({ parentId: task.parentId }) : conversations.tasks({ agentId: task.agentId });
  return pool.filter((member): member is TaskRecord => member.task?.group === group).reverse();
}

/** "Best of 2 finished", "Best of 2 finished · 1 didn't get there": once per group, in the chat that started it, when the last one ends. */
export function noticeIfFinished(task: TaskRecord): void {
  const group = task.task.group;
  if (task.task.groupKind !== "best-of" || !group || !task.parentId || !FINISHED.has(task.task.status)) return;
  const members = bestOfGroup(task);
  if (!members.every((member) => FINISHED.has(member.task.status))) return;
  const parent = conversations.get(task.parentId);
  if (!parent) return;
  const told = messages.listByConversation(parent.id).some((message) => message.parts.some((part) => part.type === "notice" && part.group === group));
  if (told) return;
  const failed = members.filter((member) => member.task.status !== "done").length;
  const text = `Best of ${members.length} finished${failed ? ` · ${failed} didn't get there` : ""}`;
  messages.insert({
    id: randomUUID(),
    conversationId: parent.id,
    role: "assistant",
    parts: [{ type: "notice", id: `n_${randomUUID().slice(0, 12)}`, kind: failed === members.length ? "warning" : "info", text, group }],
    status: "complete",
    createdAt: Date.now(),
  });
  const updated = conversations.update(parent.id, {}, true);
  if (updated) appEvents.publish({ type: "conversation", conversation: toPublicConversation(updated) });
}
