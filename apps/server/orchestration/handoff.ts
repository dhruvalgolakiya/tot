import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { HandoffPacket, ProviderId } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { limits } from "../agent/limits.ts";
import { providers } from "../agent/providers/index.ts";
import { runRegistry } from "../agent/runs.ts";
import { appEvents } from "../app-events.ts";
import { conversations, toPublicConversation } from "../data/conversations.ts";
import { messageText, messages } from "../data/messages.ts";
import { redactGitHubTokens } from "../github.ts";
import { planPath } from "../tasks/prompt.ts";
import { runLoop } from "../tasks/run-loop.ts";
import { FINISHED, taskStore, type TaskRecord } from "../tasks/store.ts";
import { tasks } from "../tasks/tasks.ts";
import { otherProvider } from "./roles.ts";
import { statuses } from "./statuses.ts";
import { tierModel } from "./tiers.ts";

/**
 * Handoff packets: everything another session or provider needs to carry on with a task,
 * without its transcript. The model writes one (a short structured-output call on the fast
 * tier, then validated) when a task switches provider, pauses, finishes, or fails over, and
 * the agent can write its own checkpoints with handoff_write. When no model can write it, TOT
 * builds a plainer one from the task's own state. "Continue on" starts a fresh session on the
 * other provider with the packet as its only context.
 */

const PROVIDER_LABELS: Record<ProviderId, string> = { claude: "Claude", chatgpt: "ChatGPT" };
const TRANSCRIPT_CHARS = 30_000;

const PACKET = z.object({
  goal: z.string().min(1),
  doneSoFar: z.array(z.string()),
  decisions: z.array(z.object({ decision: z.string().min(1), why: z.string() })),
  plan: z.array(z.object({ text: z.string().min(1), done: z.boolean() })),
  files: z.array(z.object({ path: z.string().min(1), change: z.string() })),
  repo: z.object({ branch: z.string().min(1), headSha: z.string(), worktree: z.string().min(1) }).optional(),
  tests: z.array(z.object({ command: z.string().min(1), status: z.enum(["pass", "fail", "not-run"]), note: z.string().optional() })),
  openQuestions: z.array(z.string()),
  nextStep: z.string().min(1),
  from: z.object({ provider: z.enum(["claude", "chatgpt"]), model: z.string() }),
  createdAt: z.number(),
});

/** Checks a packet has every field, of the right shape. */
export function validateHandoff(value: unknown): { ok: true; packet: HandoffPacket } | { ok: false; error: string } {
  const parsed = PACKET.safeParse(value);
  if (parsed.success) return { ok: true, packet: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, error: `${issue?.path.join(".") || "packet"}: ${issue?.message ?? "invalid"}` };
}

/** The packet's fields TOT fills in itself rather than trusting a model with. */
function stamped(task: TaskRecord, raw: Record<string, unknown>, from: HandoffPacket["from"]): Record<string, unknown> {
  const repo = task.task.repo;
  return {
    ...raw,
    from,
    createdAt: Date.now(),
    ...(repo?.headSha ? { repo: { branch: repo.branch, headSha: repo.headSha, worktree: repo.worktree } } : { repo: undefined }),
  };
}

function lastModel(task: TaskRecord): HandoffPacket["from"] {
  const reply = messages.listByConversation(task.id).findLast((m) => m.role === "assistant" && m.provider);
  return { provider: reply?.provider ?? task.provider ?? "claude", model: reply?.model ?? "" };
}

/** A plainer packet from the task's own state, when no model can write one. */
export function packetFromState(task: TaskRecord): HandoffPacket {
  const { goal, plan, progress, question, summary, repo } = task.task;
  return {
    goal: goal || task.title,
    doneSoFar: [...plan.filter((step) => step.done).map((step) => step.text), ...(summary ? [summary.slice(0, 2000)] : [])],
    decisions: [],
    plan: plan.filter((step) => step.text.trim()),
    files: [],
    ...(repo?.headSha ? { repo: { branch: repo.branch, headSha: repo.headSha, worktree: repo.worktree } } : {}),
    tests: [],
    openQuestions: question ? [question] : [],
    nextStep: plan.find((step) => !step.done)?.text || progress || `Read your plan (${planPath(task.id)}), check where things stand, then finish the goal.`,
    from: lastModel(task),
    createdAt: Date.now(),
  };
}

/** The task so far, as text for the model writing the packet (newest kept). */
function transcript(task: TaskRecord): string {
  const lines: string[] = [];
  for (const message of messages.listByConversation(task.id)) {
    const text = messageText(message);
    if (text) lines.push(`${message.role}: ${text}`);
    for (const part of message.parts) {
      if (part.type === "tool") lines.push(`[${part.title ?? part.name}${part.output ? ` → ${part.output.slice(0, 300).replace(/\s+/g, " ")}` : ""}]`);
    }
  }
  const text = redactGitHubTokens(lines.join("\n"));
  return text.length > TRANSCRIPT_CHARS ? `…\n${text.slice(-TRANSCRIPT_CHARS)}` : text;
}

function writerPrompt(task: TaskRecord, problem?: string): string {
  const { goal, plan, progress, question, summary, repo } = task.task;
  return `Write a handoff packet for this task: everything another model needs to carry on with it without the transcript. Reply with one JSON object and nothing else (no prose, no code fence), with exactly these fields:
{"goal": string, "doneSoFar": string[], "decisions": [{"decision": string, "why": string}], "plan": [{"text": string, "done": boolean}], "files": [{"path": string, "change": string}], "tests": [{"command": string, "status": "pass" | "fail" | "not-run", "note"?: string}], "openQuestions": string[], "nextStep": string}
Be concise and factual: only what the transcript shows. "files" lists files changed and how; "nextStep" is the one thing to do next.${problem ? `\nYour last packet was rejected (${problem}); fix that.` : ""}

<task>
${JSON.stringify({ title: task.title, goal, plan, progress, question, summary, branch: repo?.branch, worktree: repo?.worktree }, null, 1)}
</task>

<transcript>
${transcript(task)}
</transcript>`;
}

type Writer = (prompt: string, provider: ProviderId, model: string) => Promise<string>;
/** How a packet is written; tests swap in a fake. */
let writer: Writer = (prompt, provider, model) =>
  providers[provider].complete(prompt, { model, system: "You write handoff packets: JSON only.", signal: AbortSignal.timeout(90_000) });

/** The provider (and its fast-tier model) to write with: the task's current one, else the other; never `avoid`. */
async function pickWriter(task: TaskRecord, avoid?: ProviderId): Promise<{ provider: ProviderId; model: string } | null> {
  const signedIn = await statuses.get();
  const limited = limits.active();
  const current = lastModel(task).provider;
  for (const provider of [current, otherProvider(current)]) {
    if (provider === avoid || limited.has(provider)) continue;
    const fast = tierModel("fast", provider, signedIn);
    if (fast) return { provider, model: fast.model };
  }
  return null;
}

async function modelPacket(task: TaskRecord, avoid?: ProviderId): Promise<HandoffPacket | null> {
  const pick = await pickWriter(task, avoid);
  if (!pick) return null;
  let problem: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: unknown;
    try {
      const reply = await writer(writerPrompt(task, problem), pick.provider, pick.model);
      const json = /\{[\s\S]*\}/.exec(reply)?.[0];
      raw = json ? JSON.parse(json) : null;
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (!raw || typeof raw !== "object") {
      problem = "it wasn't a JSON object";
      continue;
    }
    const checked = validateHandoff(stamped(task, raw as Record<string, unknown>, lastModel(task)));
    if (checked.ok) return checked.packet;
    problem = checked.error;
  }
  console.warn(`[tot] the handoff for task ${task.id} couldn't be written by a model (${problem}); using the task's own state.`);
  return null;
}

/** Tasks a handoff is being written for by "Continue on", so the pause it causes doesn't write another. */
const switching = new Set<string>();

export const handoffs = {
  /** Writes the task's packet now (by a model, else from its state) and keeps it on the task. */
  async write(taskId: string, opts: { avoid?: ProviderId } = {}): Promise<HandoffPacket> {
    const task = taskStore.require(taskId);
    const packet = (await modelPacket(task, opts.avoid)) ?? packetFromState(task);
    taskStore.patch(taskId, { handoff: packet });
    return packet;
  },

  /** The agent's own checkpoint (handoff_write): checked like any other packet. */
  save(taskId: string, raw: Record<string, unknown>): HandoffPacket {
    const task = taskStore.require(taskId);
    const checked = validateHandoff(stamped(task, raw, lastModel(task)));
    if (!checked.ok) throw new HttpError(400, `The handoff is missing something: ${checked.error}`);
    taskStore.patch(taskId, { handoff: checked.packet });
    return checked.packet;
  },

  /** Packets written when a task pauses or finishes, unless a provider switch is writing one already. */
  start(): () => void {
    return taskStore.onChange((task) => {
      const { status, turns } = task.task;
      if (switching.has(task.id) || !turns || (status !== "paused" && !FINISHED.has(status))) return;
      void handoffs.write(task.id).catch((err) => console.warn(`[tot] couldn't write the handoff for task ${task.id}:`, err instanceof Error ? err.message : err));
    });
  },

  /** Tests: write packets with a fake model (or none, to use the task's state). */
  useWriter(fake: Writer): void {
    writer = fake;
  },
};

function notice(taskId: string, text: string): void {
  messages.insert({
    id: randomUUID(),
    conversationId: taskId,
    role: "assistant",
    parts: [{ type: "notice", id: `n_${randomUUID().slice(0, 12)}`, kind: "route", text }],
    status: "complete",
    createdAt: Date.now(),
  });
  const record = conversations.update(taskId, {}, true);
  if (record) appEvents.publish({ type: "conversation", conversation: toPublicConversation(record) });
}

/**
 * Moves a task to `provider` mid-flight: writes the packet (never with `avoid`, a provider at its
 * limit), points the task at the new provider, and makes its next turn a fresh session that
 * starts from the packet. The running loop simply carries on.
 */
export async function switchProvider(taskId: string, provider: ProviderId, why: string, avoid?: ProviderId): Promise<HandoffPacket> {
  switching.add(taskId);
  try {
    const packet = await handoffs.write(taskId, { avoid });
    taskStore.patch(taskId, { provider });
    // A model the user pinned belongs to the old provider; the task's tier picks one on the new one.
    conversations.update(taskId, { modelId: "auto" });
    runLoop.handOff(taskId, why);
    notice(taskId, `${why}.`);
    return packet;
  } finally {
    switching.delete(taskId);
  }
}

/** "Continue on ChatGPT / Claude": stops the turn in flight, then carries on there from a fresh handoff. */
export async function continueOn(taskId: string, provider: ProviderId): Promise<TaskRecord> {
  const task = taskStore.require(taskId);
  const { status } = task.task;
  const working = status === "running" || status === "needs-input" || status === "queued";
  switching.add(taskId);
  try {
    if (working) {
      tasks.pause(taskId);
      runRegistry.activeFor(taskId)?.stop();
      await runLoop.settled(taskId);
    }
    await switchProvider(taskId, provider, `Continued on ${PROVIDER_LABELS[provider]} from a handoff`);
  } finally {
    switching.delete(taskId);
  }
  // A finished task picks up there with the user's next message; anything else resumes now.
  const now = taskStore.require(taskId);
  if (!FINISHED.has(now.task.status)) tasks.resume(taskId, { front: true });
  return taskStore.require(taskId);
}
