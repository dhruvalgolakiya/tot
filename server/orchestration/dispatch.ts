import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Dispatch, DispatchMode, Message, Role, SendMessageRequest, SendMessageResponse, SpawnSession, Tier } from "../../shared/types.ts";
import { limits } from "../agent/limits.ts";
import { HttpError, sendMessage } from "../agent/orchestrator.ts";
import { providers } from "../agent/providers/index.ts";
import { assessComplexity } from "../agent/router.ts";
import { runRegistry } from "../agent/runs.ts";
import { appEvents } from "../app-events.ts";
import { conversations, toPublicConversation } from "../data/conversations.ts";
import { messageText, messages } from "../data/messages.ts";
import { repoMentioned } from "../tasks/intake.ts";
import { ACTIVE } from "../tasks/store.ts";
import { taskTitle, tasks } from "../tasks/tasks.ts";
import { ROLE_NAMES } from "./roles.ts";
import { spawnMany } from "./spawn.ts";
import { statuses } from "./statuses.ts";
import { pickTier, roleTier } from "./tiers.ts";

/**
 * Deciding how to run each request: answer it inline, pass it to a task that's already on it,
 * or spawn sessions — each with a role and tier — and combine their results. Cheap first:
 * plain rules settle most messages; when they aren't sure, a classifier on the fast tier
 * decides from the text, the chat's running tasks and its last few messages. If that fails
 * or takes over 2 s, the message is answered inline. The user can always choose in the
 * composer (Auto / Inline / Task), and the decision is kept on the message for its chip.
 */

const CLASSIFIER_TIMEOUT_MS = 2000;

export interface DispatchInput {
  agentId: string;
  text: string;
  attachments: number;
  mode: DispatchMode;
  /** Tasks the chat started that are still working. */
  running: { id: string; title: string; goal: string }[];
  /** The chat's last few messages, for the classifier. */
  recent: { role: "user" | "assistant"; text: string }[];
}

type Decision = Dispatch;

const GREETING = /^(hi|hello|hey|thanks|thank you|ok|okay|cool|great|nice|perfect|got it|good (?:morning|afternoon|evening|night))\b/i;
const QUESTION = /^(what|who|when|where|why|how|is|are|was|were|can|could|would|should|does|do|did|which|will|tell me|explain|define)\b/i;
const SMALL_EDIT =
  /^(?:please\s+)?(rewrite|rephrase|reword|shorten|expand|translate|proofread|summari[sz]e|tl;?dr|fix (?:the )?(?:typos?|grammar|spelling)|make (?:it|this) (?:shorter|longer|clearer|friendlier|more|less)|format|turn (?:this|it) into)\b/i;
const FOLLOW_UP = /^(also|and|actually|instead|plus|oh,? and|make sure|don't|do not|tell (?:it|them)|for (?:that|the) task|in (?:that|the) task|while (?:you're|it's|they're) at it|one more thing)\b/i;
/** "Can you", "please", "hey TOT," and the like before the request itself. */
const LEAD_IN = /^(?:(?:hey|hi|ok|okay)[,!]?\s+)?(?:(?:can|could|would) you(?: please)?\s+|please\s+|i(?:'d| would) like you to\s+|i need you to\s+)?/i;
const CODE = /^(fix|implement|build|refactor|migrate|upgrade|add|update|remove|rename|port|bump|write tests? for|make (?:the )?tests? pass)\b/i;
const EXPLORE = /^(investigate|look into|find out|figure out|debug|explore|trace|find where|find why|map out)\b/i;
const REVIEW = /^(review|audit|check over)\b/i;
/** Work mentioned anywhere ("…can you take a look and fix it?"): not something to answer in passing. */
const WORK_ANYWHERE = /\b(fix|implement|build|refactor|migrate|upgrade|debug|investigate|research|compare|set up|draft|write up|go through|look into)\b/i;
const RESEARCH =
  /^(research|compare|evaluate|benchmark|survey|analy[sz]e|go through|dig into|find (?:the )?(?:best|top)|look up|write (?:a |an )?(?:report|comparison|analysis|brief|memo|overview|summary of the (?:market|landscape)))\b/i;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "compare Linear, Jira and Height for a 10-person team" → ["Linear", "Jira", "Height"] (two to six short names), else []. */
export function namedItems(request: string): string[] {
  const match = /^(?:compare|research|evaluate|benchmark)\s+(.+)$/i.exec(request);
  if (!match) return [];
  const object = match[1]!.split(/\s+(?:for|to see|to find|in terms of|on|by|from the point of view of|so that|so we|:|—|-)\s+|[.?!:;]/i)[0]!;
  const items = object
    .replace(/^(?:the\s+)?(?:tools?|options?|vendors?|apps?|products?|frameworks?|libraries?)\s+/i, "")
    .split(/\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or|vs\.?|versus|against)\s+/i)
    .map((item) => item.trim().replace(/^(?:and|or)\s+/i, ""))
    .filter(Boolean);
  const named = items.filter((item) => item.split(/\s+/).length <= 4 && item.length <= 40 && /^["'“]?[\p{Lu}\d]/u.test(item));
  return named.length >= 2 && named.length === items.length && items.length <= 6 ? named : [];
}

function session(role: Role, title: string, goal: string, repo?: string): SpawnSession {
  return { role, title: title.slice(0, 80), goal, tier: roleTier(role), ...(repo ? { repo } : {}) };
}

/** One session for a request that's clearly one piece of work. */
function singleSession(agentId: string, request: string): SpawnSession {
  const repo = repoMentioned(agentId, request);
  const role: Role = repo ? (EXPLORE.test(request) ? "explorer" : REVIEW.test(request) ? "reviewer" : "implementer") : "researcher";
  return session(role, taskTitle(request), request, repo);
}

const inline = (tier: Tier, reason: string, by: Decision["by"] = "rule"): Decision => ({ mode: "inline", tier, reason, by });
const spawn = (sessions: SpawnSession[], reason: string, by: Decision["by"] = "rule", then?: "synthesize"): Decision => ({
  mode: "spawn",
  sessions,
  ...(then ? { then } : {}),
  taskIds: [],
  reason,
  by,
});

/** The rules: a decision when they're sure, else null (ask the classifier). */
export function ruleDecision(input: DispatchInput): Decision | null {
  const text = input.text.trim();
  const request = text.replace(LEAD_IN, "");
  const complexTier: Tier = assessComplexity(text).complex ? "deep" : "fast";

  if (input.mode === "inline") return inline(complexTier, "you chose to answer here", "user");
  if (input.mode === "task") return spawn([singleSession(input.agentId, request || text)], "you chose to run it as a task", "user");
  if (!text) return inline("fast", "attachments only");
  // Files go to the chat: tasks don't take attachments yet.
  if (input.attachments) return inline(complexTier, "with attachments");

  // A follow-up for a task that's working: by its name, or the one task when it's clearly about it.
  if (input.running.length) {
    const named = input.running.find((task) =>
      task.title
        .split(/\s+/)
        .filter((word) => word.length > 3)
        .some((word) => new RegExp(`\\b${escape(word)}\\b`, "i").test(text)),
    );
    if (named && (FOLLOW_UP.test(text) || /\b(?:task|it|that one)\b/i.test(text))) {
      return { mode: "continue-task", taskId: named.id, reason: `follow-up for “${named.title}”`, by: "rule" };
    }
    if (input.running.length === 1 && FOLLOW_UP.test(text)) {
      return { mode: "continue-task", taskId: input.running[0]!.id, reason: `follow-up for “${input.running[0]!.title}”`, by: "rule" };
    }
    // A follow-up, but for which task? The classifier reads the tasks' goals.
    if (FOLLOW_UP.test(text)) return null;
  }

  if (GREETING.test(text) && text.length < 60) return inline("fast", "conversation");
  if (SMALL_EDIT.test(request)) return inline("standard", "small edit");

  const items = namedItems(request);
  if (items.length) {
    const at = request.search(/\s+(?:for|to see|to find|in terms of|on|so that|so we)\s+/i);
    const scope = at >= 0 ? ` ${request.slice(at).trim().replace(/[.?!]+$/, "")}` : "";
    return spawn(
      items.map((item) => session("researcher", `Research ${item}`, `Research ${item}${scope}. Cite every source.`)),
      `${items.length} things to compare`,
      "rule",
      "synthesize",
    );
  }

  const repo = repoMentioned(input.agentId, request);
  if (repo && (CODE.test(request) || EXPLORE.test(request) || REVIEW.test(request))) {
    return spawn([singleSession(input.agentId, request)], "work on a repo");
  }
  if (RESEARCH.test(request)) return spawn([session("researcher", taskTitle(request), request)], "research");
  if (QUESTION.test(text) && text.length < 400 && !WORK_ANYWHERE.test(text)) return inline(complexTier, "a question");
  if (text.length > 900 && (CODE.test(request) || EXPLORE.test(request))) return spawn([singleSession(input.agentId, request)], "a big job");
  if (text.length < 120 && !CODE.test(request) && !EXPLORE.test(request) && !REVIEW.test(request) && !WORK_ANYWHERE.test(text)) {
    return inline(complexTier, "short message");
  }
  return null;
}

const CLASSIFIED = z.object({
  mode: z.enum(["inline", "continue-task", "spawn"]),
  tier: z.enum(["fast", "standard", "deep"]).optional(),
  taskId: z.string().optional(),
  sessions: z
    .array(
      z.object({
        role: z.enum(ROLE_NAMES as [Role, ...Role[]]),
        title: z.string().min(1),
        goal: z.string().min(1),
        repo: z.string().optional(),
      }),
    )
    .max(6)
    .optional(),
  synthesize: z.boolean().optional(),
  reason: z.string().optional(),
});

/** Checks a classifier's answer against the chat (its running tasks) and turns it into a decision; null if unusable. */
export function parseClassified(raw: unknown, input: DispatchInput): Decision | null {
  const parsed = CLASSIFIED.safeParse(raw);
  if (!parsed.success) return null;
  const answer = parsed.data;
  const reason = answer.reason?.slice(0, 120) || "classifier";
  if (answer.mode === "continue-task") {
    const task = input.running.find((t) => t.id === answer.taskId);
    return task ? { mode: "continue-task", taskId: task.id, reason, by: "classifier" } : null;
  }
  if (answer.mode === "spawn") {
    if (!answer.sessions?.length) return null;
    const sessions = answer.sessions.map((s) => session(s.role, s.title, s.goal, s.repo || repoMentioned(input.agentId, s.goal)));
    return spawn(sessions, reason, "classifier", answer.synthesize && sessions.length > 1 ? "synthesize" : undefined);
  }
  return inline(answer.tier ?? "fast", reason, "classifier");
}

function classifierPrompt(input: DispatchInput): string {
  const running = input.running.length ? input.running.map((t) => `- ${t.id}: “${t.title}” — ${t.goal.slice(0, 200)}`).join("\n") : "(none)";
  const recent = input.recent.map((m) => `${m.role}: ${m.text.slice(0, 400)}`).join("\n") || "(none)";
  return `Decide how an AI agent should handle the user's new message in a chat. Reply with one JSON object only:
{"mode": "inline" | "continue-task" | "spawn", "tier"?: "fast" | "standard" | "deep", "taskId"?: string, "sessions"?: [{"role": ${ROLE_NAMES.map((r) => `"${r}"`).join(" | ")}, "title": string, "goal": string, "repo"?: string}], "synthesize"?: boolean, "reason": string (a few words)}
- inline: answer in the chat — questions, conversation, small edits. tier: fast for quick ones, deep for hard thinking.
- continue-task: a follow-up meant for one of the running tasks below (give its taskId).
- spawn: real work that takes more than a few minutes (a code change, research across sources, a report): one session per independent part, with a self-contained goal; synthesize: true to combine several results into one answer.

Running tasks:
${running}

Recent messages:
${recent}

New message:
${input.text.slice(0, 4000)}`;
}

type Classifier = (prompt: string, input: DispatchInput) => Promise<unknown>;

/** The real classifier: the fast tier, JSON out, within the time limit. */
const realClassifier: Classifier = async (prompt) => {
  const pick = pickTier("fast", { statuses: await statuses.get(), limited: limits.active() });
  if (!pick) return null;
  const reply = await providers[pick.provider].complete(prompt, {
    model: pick.model,
    system: "You route requests. Reply with JSON only.",
    signal: AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS),
  });
  const json = /\{[\s\S]*\}/.exec(reply)?.[0];
  return json ? JSON.parse(json) : null;
};
let classifier: Classifier = realClassifier;

/** The decision for one message: the rules, else the classifier, else inline. */
export async function decide(input: DispatchInput): Promise<Decision> {
  const ruled = ruleDecision(input);
  if (ruled) return ruled;
  const fallback = inline(assessComplexity(input.text).complex ? "deep" : "fast", "not sure; answered here");
  try {
    const answer = await Promise.race([
      classifier(classifierPrompt(input), input),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CLASSIFIER_TIMEOUT_MS).unref()),
    ]);
    return parseClassified(answer, input) ?? fallback;
  } catch {
    return fallback;
  }
}

/** What a chat looks like to the dispatcher: its running tasks and last few messages. */
export function chatContext(conversationId: string): Pick<DispatchInput, "running" | "recent"> {
  const running = conversations
    .tasks({ parentId: conversationId })
    .filter((task) => task.task && ACTIVE.has(task.task.status))
    .map((task) => ({ id: task.id, title: task.title, goal: task.task!.goal }));
  const recent = messages
    .listByConversation(conversationId)
    .filter((m) => !m.auto)
    .slice(-3)
    .map((m) => ({ role: m.role, text: messageText(m) }))
    .filter((m) => m.text);
  return { running, recent };
}

function insertUserMessage(conversationId: string, request: SendMessageRequest, dispatch: Decision): Message {
  const message: Message = {
    id: randomUUID(),
    conversationId,
    role: "user",
    parts: [{ type: "text", id: randomUUID(), text: request.text.trim() }],
    status: "complete",
    dispatch,
    createdAt: Date.now(),
  };
  messages.insert(message);
  return message;
}

function note(conversationId: string, text: string): void {
  messages.insert({
    id: randomUUID(),
    conversationId,
    role: "assistant",
    parts: [{ type: "notice", id: `n_${randomUUID().slice(0, 12)}`, kind: "route", text }],
    status: "complete",
    createdAt: Date.now() + 1,
  });
}

function reply(conversationId: string, userMessage: Message): SendMessageResponse {
  const conversation = conversations.update(conversationId, {}, true)!;
  appEvents.publish({ type: "conversation", conversation: toPublicConversation(conversation) });
  return { runId: "", userMessage: messages.get(userMessage.id) ?? userMessage, conversation: toPublicConversation(conversation) };
}

/** A sentence for the chat when tasks start. */
export function spawnedText(count: number, synthesize: boolean): string {
  if (count === 1) return "On it: I started a task for this. It reports back here when it's done.";
  return `I started ${count} tasks for this${synthesize ? ", and I'll combine their results here when they're all done" : "; each reports back here"}.`;
}

/** How turns start; tests swap in a fake. */
let send = sendMessage;

export const dispatcher = {
  decide,

  /**
   * A message in a chat, as the composer sends it: decided (rules, then the classifier), then
   * answered inline, passed to the task it's for, or turned into tasks whose cards show here.
   * Inline and continue-task replies carry the decision for the message's chip.
   */
  async handle(conversationId: string, request: SendMessageRequest): Promise<SendMessageResponse> {
    const conversation = conversations.get(conversationId);
    if (!conversation) throw new HttpError(404, "Chat not found.");
    // Busy chats answer 409 as before; the decision waits for a free turn.
    if (runRegistry.activeFor(conversationId)) return send(conversationId, request);
    // A message with chats attached asks about them: answered here, unless the user said otherwise (module 05).
    if (request.contextChats?.length && (request.mode ?? "auto") === "auto") return send(conversationId, request);
    const decision = await decide({
      agentId: conversation.agentId,
      text: request.text ?? "",
      attachments: request.attachments?.length ?? 0,
      mode: request.mode ?? "auto",
      ...chatContext(conversationId),
    });

    if (decision.mode === "inline") return send(conversationId, request, { tier: decision.tier, dispatch: decision });

    const userMessage = insertUserMessage(conversationId, request, decision);
    if (decision.mode === "continue-task") {
      const task = conversations.get(decision.taskId);
      await tasks.message(decision.taskId, { text: request.text });
      note(conversationId, `Passed to “${task?.title ?? "the task"}”.`);
      return reply(conversationId, userMessage);
    }
    const started = spawnMany(conversationId, decision.sessions, {
      then: decision.then,
      cards: { kind: "message", text: spawnedText(decision.sessions.length, decision.then === "synthesize") },
    });
    messages.setDispatch(userMessage.id, { ...decision, taskIds: started.map((task) => task.id) });
    return reply(conversationId, userMessage);
  },

  /** Tests: a fake classifier (and turn starter). */
  useClassifier(fake: Classifier | null): void {
    classifier = fake ?? realClassifier;
  },
  useSender(fake: typeof sendMessage): void {
    send = fake;
  },
};
