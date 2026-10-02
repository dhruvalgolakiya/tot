// Tasks (roadmap module 01) with fake model turns, a fake Slack, fake notifiers, and real git on the local computer.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/tasks.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AppEvent, Conversation, Message, MessagePart, SendMessageRequest, TaskChanges } from "../shared/types.ts";

process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test
const PORT = 8793;

const { HttpError } = await import("./agent/orchestrator.ts");
const { MessageBuilder } = await import("./agent/message-builder.ts");
const { runRegistry } = await import("./agent/runs.ts");
const { appEvents } = await import("./app-events.ts");
const { computerManager } = await import("./computer/manager.ts");
const { MCP_TOKEN } = await import("./config.ts");
const { agents } = await import("./data/agents.ts");
const { brains } = await import("./data/brains.ts");
const { conversations, toPublicConversation } = await import("./data/conversations.ts");
const { messages } = await import("./data/messages.ts");
const { settings } = await import("./data/settings.ts");
const { db } = await import("./db.ts");
const { slack } = await import("./slack.ts");
const { createApp } = await import("./app.ts");
const { workRequest } = await import("./tasks/intake.ts");
const { taskNotifications } = await import("./tasks/notify.ts");
const { childResultsNote, continuationPreamble } = await import("./tasks/prompt.ts");
const { taskQueue } = await import("./tasks/queue.ts");
const { madeProgress, runLoop } = await import("./tasks/run-loop.ts");
const { steer } = await import("./tasks/steer.ts");
const { canMove, taskStore } = await import("./tasks/store.ts");
const { tasks } = await import("./tasks/tasks.ts");
const { planRepo, slugify } = await import("./tasks/worktree.ts");
type Run = import("./agent/runs.ts").Run;
type TurnOptions = import("./agent/orchestrator.ts").TurnOptions;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 220)}` : ""}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end && !condition(); ) await sleep(20);
}
const status = (id: string) => taskStore.get(id)?.task.status;
const mascot = { shape: "blob" as const, color: "#60a5fa", accessory: "none" as const, eyes: "dots" as const };

settings.patch({ computer: { mode: "local" }, memory: { enabled: true }, tasks: { perAgentLimit: 2, globalLimit: 4, resumeInterrupted: true } });

// --- Fake model turns ----------------------------------------------------------
// Each task can have a script; the fake turn runs it, then ends like a real one (stopped, or complete
// when it was stopped to hand over a steering note).

interface Turn {
  taskId: string;
  text: string;
  index: number;
  run: Run;
  builder: InstanceType<typeof MessageBuilder>;
  /** A tool call that takes `ms` (left running if the turn is stopped meanwhile). */
  tool: (name: string, ms?: number) => Promise<void>;
  say: (text: string) => void;
  /** Resolves when the turn is stopped. */
  stopped: Promise<void>;
}
type Script = (turn: Turn) => Promise<void | "error">;
const scripts = new Map<string, Script>();
/** Scripts for tasks the test can't name in advance (started by a tool or from Slack), by their goal. */
const byGoal: [RegExp, Script][] = [];
const sent: { conversationId: string; text: string; preamble: string; auto: boolean; fresh: boolean }[] = [];
const sentTo = (id: string) => sent.filter((s) => s.conversationId === id);

async function fakeSend(conversationId: string, request: SendMessageRequest, options: TurnOptions = {}) {
  if (runRegistry.activeFor(conversationId)) throw new HttpError(409, "Busy.");
  const index = sentTo(conversationId).length;
  sent.push({ conversationId, text: request.text, preamble: options.preamble ?? "", auto: Boolean(options.auto), fresh: Boolean(options.freshSession) });
  const now = Date.now();
  const user: Message = {
    id: randomUUID(),
    conversationId,
    role: "user",
    parts: [{ type: "text", id: randomUUID(), text: request.text }],
    status: "complete",
    ...(options.auto ? { auto: true } : {}),
    createdAt: now,
  };
  messages.insert(user);
  const assistant: Message = { id: randomUUID(), conversationId, role: "assistant", parts: [], status: "streaming", createdAt: now + 1 };
  messages.insert(assistant);
  const run = runRegistry.create(conversationId, assistant.id);
  const builder = new MessageBuilder(assistant, (event) => run.push(event));
  run.reply = () => builder.message;
  run.addPart = (part) => {
    builder.add(part);
    messages.save(builder.message);
  };
  const stopped = new Promise<void>((resolve) => run.controller.signal.addEventListener("abort", () => resolve(), { once: true }));
  const turn: Turn = {
    taskId: conversationId,
    text: request.text,
    index,
    run,
    builder,
    stopped,
    say: (text) => builder.apply({ type: "text-delta", blockId: randomUUID(), delta: text }),
    tool: async (name, ms = 10) => {
      if (run.controller.signal.aborted) return;
      const id = randomUUID();
      builder.apply({ type: "tool-start", toolCallId: id, name, input: {} });
      await Promise.race([sleep(ms), stopped]);
      if (!run.controller.signal.aborted || run.stopReason === "steer") builder.apply({ type: "tool-end", toolCallId: id, output: "ok" });
    },
  };
  void (async () => {
    let outcome: void | "error" = undefined;
    // Lets a test register a task's script right after creating it.
    await sleep(5);
    const goal = conversations.get(conversationId)?.task?.goal ?? "";
    const script = scripts.get(conversationId) ?? byGoal.find(([pattern]) => pattern.test(goal))?.[1] ?? (async (t: Turn) => t.say("ok"));
    try {
      outcome = await script(turn);
    } catch (err) {
      console.error("script failed:", err);
    }
    const end = run.controller.signal.aborted ? (run.stopReason === "steer" ? "complete" : "stopped") : outcome === "error" ? "error" : "complete";
    const final = builder.finish(end, end === "error" ? "Claude is overloaded right now." : undefined);
    messages.save(final);
    run.push({ type: "run-end", status: end, message: final });
    runRegistry.finish(run);
  })();
  return { runId: run.id, userMessage: user, conversation: toPublicConversation(conversations.get(conversationId)!) };
}
runLoop.useSender(fakeSend);

// --- Fake notifiers ------------------------------------------------------------
const notices: { via: string; id: string; text: string }[] = [];
const slackThreads = new Set<string>();
const emailThreads = new Set<string>();
taskNotifications.use({
  slackThread: async (id, text) => (slackThreads.has(id) ? (notices.push({ via: "slack", id, text }), true) : false),
  emailThread: async (id, text) => (emailThreads.has(id) ? (notices.push({ via: "email", id, text }), true) : false),
  slackDm: async (id, text) => (notices.push({ via: "dm", id, text }), true),
});

const events: AppEvent[] = [];
appEvents.subscribe((event) => events.push(event));
tasks.start();
taskNotifications.start();

const app = createApp();
const server = serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" });
async function request<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`http://127.0.0.1:${PORT}/api${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

/** An MCP client on the conversation's tools, as the harness would use them. */
async function mcp(conversationId: string) {
  const client = new Client({ name: "tot-tasks-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp/${conversationId}`), {
      requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: Boolean(result.isError), text: (result.content as { text?: string }[]).map((c) => c.text ?? "").join("\n") };
  };
  return { client, call };
}

/** A fake turn running in a chat, so tools can add cards to its reply. */
function chatTurn(conversationId: string) {
  const assistant: Message = { id: randomUUID(), conversationId, role: "assistant", parts: [], status: "streaming", createdAt: Date.now() };
  messages.insert(assistant);
  const run = runRegistry.create(conversationId, assistant.id);
  const builder = new MessageBuilder(assistant, (event) => run.push(event));
  run.reply = () => builder.message;
  run.addPart = (part) => {
    builder.add(part);
    messages.save(builder.message);
  };
  return {
    builder,
    end() {
      const final = builder.finish("complete");
      messages.save(final);
      run.push({ type: "run-end", status: "complete", message: final });
      runRegistry.finish(run);
    },
  };
}

// =============================================================================
// Lifecycle guards and pure helpers
// =============================================================================
check("guards: queued → running", canMove("queued", "running"));
check("guards: done can't be paused", !canMove("done", "paused"));
check("guards: needs-input → running", canMove("needs-input", "running"));
check("guards: interrupted → queued", canMove("interrupted", "queued"));
check("guards: stopped can't need input", !canMove("stopped", "needs-input"));
check("slug", slugify("Fix the flaky checkout test!!") === "fix-the-flaky-checkout-test");
const planned = planRepo("acme/web", "Fix login bug", "develop");
check(
  "repo plan",
  planned.folder === "~/repos/web" && /^tot\/fix-login-bug-[0-9a-f]{4}$/.test(planned.branch) && planned.worktree.startsWith("~/repos/web/.tot-worktrees/tot-fix-login-bug-") && planned.baseBranch === "develop",
  JSON.stringify(planned),
);
check("folder source", planRepo("~/repos/api", "x").folder === "~/repos/api" && planRepo("repos/api", "x").folder === "~/repos/api");
check(
  "progress = tools, plan, or commits",
  madeProgress({ plan: "[]", progress: null, headSha: "a" }, { plan: "[]", progress: null, headSha: "a" }, { parts: [{ type: "tool", id: "1", name: "x", status: "done" }] } as Message) &&
    madeProgress({ plan: "[]", progress: null, headSha: "a" }, { plan: '[{"text":"x","done":true}]', progress: null, headSha: "a" }, undefined) &&
    !madeProgress({ plan: "[]", progress: null, headSha: "a" }, { plan: "[]", progress: null, headSha: "a" }, { parts: [{ type: "text", id: "1", text: "hi" }] } as Message),
);

// =============================================================================
// M1: a chat starts two research tasks in parallel; cards update; results come back
// =============================================================================
const ana = agents.create({ name: "Ana", mascot });
const chat = conversations.create({ agentId: ana.id, modelId: "auto", title: "Vendors" });
const finishScript: Script = async (t) => {
  if (t.index === 0) {
    tasks.update(t.taskId, { plan: [{ text: "Find sources", done: false }, { text: "Write it up", done: false }], progress: "Searching" });
    await t.tool("web_search", 30);
    t.say("Found sources.");
    return;
  }
  tasks.update(t.taskId, { plan: [{ text: "Find sources", done: true }, { text: "Write it up", done: true }] });
  await t.tool("web_fetch", 20);
  tasks.finish(t.taskId, "done", `Report for ${conversations.get(t.taskId)!.title}: all good.`);
  t.say("Done.");
};
byGoal.push([/^Research (Linear|Height)/, finishScript]);
const parentTurn = chatTurn(chat.id);
const { client: chatClient, call: chatCall } = await mcp(chat.id);
const before = sent.length;
// The scripts are set right after task_start returns; the fake turn reads them when it starts.
let r = await chatCall("task_start", { title: "Research Linear", goal: "Research Linear for a 10-person team." });
check("task_start answers", !r.isError && /Started task [\w-]+ “Research Linear”/.test(r.text), r.text);
const linearId = /Started task ([\w-]+)/.exec(r.text)![1]!;
r = await chatCall("task_start", { title: "Research Height", goal: "Research Height for a 10-person team." });
const heightId = /Started task ([\w-]+)/.exec(r.text)![1]!;
const cards = parentTurn.builder.message.parts.filter((p): p is Extract<MessagePart, { type: "task" }> => p.type === "task");
check("two cards in the reply", cards.length === 2 && cards[0]!.taskId === linearId && cards[1]!.taskId === heightId, JSON.stringify(cards));
const linear = taskStore.get(linearId)!;
check("child task: kind, parent, agent", linear.kind === "task" && linear.parentId === chat.id && linear.agentId === ana.id && linear.task.goal.includes("Linear"));
await until(() => status(linearId) === "done" && status(heightId) === "done");
check("both run in parallel and finish", status(linearId) === "done" && status(heightId) === "done", `${status(linearId)} ${status(heightId)}`);
parentTurn.end();
const linearTurns = sentTo(linearId);
check("first turn is the goal", linearTurns[0]?.text === "Research Linear for a 10-person team." && !linearTurns[0]!.auto, JSON.stringify(linearTurns[0]));
check(
  "continuation turn carries the plan",
  linearTurns[1]?.auto === true && linearTurns[1]!.text === "Continue the task." && linearTurns[1]!.preamble.includes("[ ] Find sources") && linearTurns[1]!.preamble.includes("Latest progress: Searching"),
  linearTurns[1]?.preamble,
);
check("turns counted", taskStore.get(linearId)!.task.turns === 2 && sent.length - before === 4, String(taskStore.get(linearId)!.task.turns));
check("timestamps", Boolean(taskStore.get(linearId)!.task.startedAt && taskStore.get(linearId)!.task.finishedAt));
check("task events published", events.some((e) => e.type === "task" && e.conversation.id === linearId && e.conversation.task?.status === "running"));
const parentMessages = messages.listByConversation(chat.id);
const notes = parentMessages.filter((m) => m.parts.some((p) => p.type === "notice" && /“Research (Linear|Height)” is done: Report for/.test(p.text)));
check("results noted in the chat", notes.length === 2, JSON.stringify(parentMessages.map((m) => m.parts)));
r = await chatCall("task_list");
check("task_list", r.text.includes("Research Linear") && r.text.includes("done") && r.text.includes("result: Report for Research Linear"), r.text);
r = await chatCall("task_status", { id: "nope" });
check("task_status of a stranger", r.isError);
const note = childResultsNote(conversations.get(chat.id)!);
check("parent's model hears the results once", note.includes("Report for Research Linear") && note.includes("Report for Research Height") && conversations.get(chat.id)!.childResults.length === 0, note);
await chatClient.close();

// Inside a task: the task tools, not the chat ones.
const { client: taskClient, call: taskCall } = await mcp(linearId);
const taskTools = (await taskClient.listTools()).tools.map((t) => t.name);
check("task sees task_update/task_finish only", taskTools.includes("task_update") && taskTools.includes("task_finish") && !taskTools.includes("task_start"), taskTools.join(","));
r = await taskCall("task_finish", { outcome: "done", summary: "again" });
check("finishing twice is refused", r.isError, r.text);
await taskClient.close();

// =============================================================================
// Stalls and errors
// =============================================================================
const idle = tasks.create({ agentId: ana.id, goal: "Do nothing useful" });
scripts.set(idle.id, async (t) => t.say("Thinking about it."));
await until(() => status(idle.id) === "failed");
check("no progress twice → stalled", status(idle.id) === "failed" && /Stalled/.test(taskStore.get(idle.id)!.task.summary ?? ""), taskStore.get(idle.id)?.task.summary ?? "");
check("stall took two turns after the first", sentTo(idle.id).length === 2, String(sentTo(idle.id).length));

const flaky = tasks.create({ agentId: ana.id, goal: "Hit errors" });
scripts.set(flaky.id, async () => "error");
await until(() => status(flaky.id) === "failed");
check("repeated errors → failed", /repeated errors: Claude is overloaded/.test(taskStore.get(flaky.id)!.task.summary ?? ""), taskStore.get(flaky.id)?.task.summary ?? "");

// A question: the task waits, and the user's reply picks it up again.
const asker = tasks.create({ agentId: ana.id, goal: "Pick a database" });
scripts.set(asker.id, async (t) => {
  if (t.index === 0) {
    tasks.update(t.taskId, { question: "Postgres or SQLite?" });
    t.say("Postgres or SQLite?");
    return;
  }
  if (t.text.includes("SQLite")) {
    tasks.finish(t.taskId, "done", "Went with SQLite.");
    return;
  }
  t.say("hm");
});
await until(() => status(asker.id) === "needs-input");
check("question → needs-input", status(asker.id) === "needs-input" && taskStore.get(asker.id)!.task.question === "Postgres or SQLite?");
await sleep(100);
check("…and the loop stops there", !runLoop.isRunning(asker.id) && sentTo(asker.id).length === 1);
const replied = await request("POST", `/conversations/${asker.id}/messages`, { text: "SQLite please" });
check("reply resumes it", replied.status === 200 && Boolean(replied.data.runId), JSON.stringify(replied.data).slice(0, 200));
await until(() => status(asker.id) === "done");
check("…and it finishes", status(asker.id) === "done" && sentTo(asker.id)[1]?.text === "SQLite please" && taskStore.get(asker.id)!.task.question === null);

// =============================================================================
// M3: the queue — limits, order, reorder, run now
// =============================================================================
settings.patch({ tasks: { perAgentLimit: 1 } });
const quinn = agents.create({ name: "Quinn", mascot });
let release = false;
const blocker = tasks.create({ agentId: quinn.id, goal: "Long job" });
scripts.set(blocker.id, async (t) => {
  await t.tool("computer_exec", 10);
  while (!release && !t.run.controller.signal.aborted) await sleep(20);
  tasks.finish(t.taskId, "done", "Long job done.");
});
const second = tasks.create({ agentId: quinn.id, goal: "Second" });
const third = tasks.create({ agentId: quinn.id, goal: "Third" });
for (const t of [second, third]) scripts.set(t.id, async (turn) => void tasks.finish(turn.taskId, "done", "ok"));
await until(() => status(blocker.id) === "running");
check("limit 1: one runs", status(blocker.id) === "running" && status(second.id) === "queued" && status(third.id) === "queued");
check("FIFO positions", taskStore.get(second.id)!.task.queuePosition === 1 && taskStore.get(third.id)!.task.queuePosition === 2);
let res = await request("PATCH", `/tasks/${third.id}`, { queuePosition: 1 });
check("reorder via PATCH", res.status === 200 && taskStore.get(third.id)!.task.queuePosition === 1 && taskStore.get(second.id)!.task.queuePosition === 2, JSON.stringify(res.data).slice(0, 120));
res = await request("POST", `/tasks/${second.id}/run-now`);
check("run now → front (no free slot)", status(second.id) === "queued" && taskStore.get(second.id)!.task.queuePosition === 1);
res = await request("GET", `/tasks?agentId=${quinn.id}`);
check("list: queued first, in order", (res.data as Conversation[]).map((c) => c.id).join(",") === [second.id, third.id, blocker.id].join(","));
res = await request("PATCH", `/tasks/${blocker.id}`, { queuePosition: 1 });
check("only queued tasks can move", res.status === 409);
release = true;
await until(() => status(second.id) === "done" && status(third.id) === "done");
check("…the rest start by themselves, one at a time", status(second.id) === "done" && status(third.id) === "done" && sentTo(second.id).length >= 1);

settings.patch({ tasks: { perAgentLimit: 2, globalLimit: 1 } });
let gate = false;
const hold = (id: string) =>
  scripts.set(id, async (t) => {
    await t.tool("computer_exec", 5);
    while (!gate && !t.run.controller.signal.aborted) await sleep(20);
    tasks.finish(t.taskId, "done", "ok");
  });
const g1 = tasks.create({ agentId: quinn.id, goal: "Global one" });
hold(g1.id);
const otherAgent = agents.create({ name: "Otto", mascot });
const g2 = tasks.create({ agentId: otherAgent.id, goal: "Global two" });
hold(g2.id);
await until(() => status(g1.id) === "running");
await sleep(80);
check("global limit across agents", status(g1.id) === "running" && status(g2.id) === "queued");
const changed = await request("PATCH", "/settings", { tasks: { globalLimit: 4 } });
await until(() => status(g2.id) === "running");
check("raising the limit starts the queued one", changed.status === 200 && status(g2.id) === "running");
gate = true;
await until(() => status(g1.id) === "done" && status(g2.id) === "done");
const badLimit = await request("PATCH", "/settings", { tasks: { perAgentLimit: 0 } });
check("limits validated", badLimit.status === 400);

// =============================================================================
// Pause, resume, stop
// =============================================================================
const pausable = tasks.create({ agentId: ana.id, goal: "Pausable" });
scripts.set(pausable.id, async (t) => {
  if (t.index === 0) {
    tasks.update(t.taskId, { plan: [{ text: "One", done: false }] });
    await t.stopped;
    return;
  }
  tasks.finish(t.taskId, "done", "Finished after resume.");
});
await until(() => runRegistry.activeFor(pausable.id) !== undefined);
res = await request("POST", `/tasks/${pausable.id}/pause`);
await until(() => !runRegistry.activeFor(pausable.id));
check("pause stops the turn", res.status === 200 && status(pausable.id) === "paused" && !runLoop.isRunning(pausable.id));
check("paused task can't be paused again", (await request("POST", `/tasks/${pausable.id}/pause`)).status === 409);
res = await request("POST", `/tasks/${pausable.id}/resume`);
await until(() => status(pausable.id) === "done");
check("resume continues from the plan", status(pausable.id) === "done" && sentTo(pausable.id)[1]?.preamble.includes("[ ] One") === true);
check("finished tasks can't be paused", (await request("POST", `/tasks/${pausable.id}/pause`)).status === 409);

const stoppable = tasks.create({ agentId: ana.id, goal: "Stoppable" });
scripts.set(stoppable.id, async (t) => void (await t.stopped));
await until(() => runRegistry.activeFor(stoppable.id) !== undefined);
res = await request("POST", `/tasks/${stoppable.id}/stop`);
await until(() => !runLoop.isRunning(stoppable.id));
check("stop", status(stoppable.id) === "stopped" && taskStore.get(stoppable.id)!.task.summary === "Stopped by you.");

// =============================================================================
// M4: steering — the fallback path, the mid-turn path, and notes between turns
// =============================================================================
const steered = tasks.create({ agentId: ana.id, goal: "Build the API" });
scripts.set(steered.id, async (t) => {
  if (t.index === 0) {
    await t.tool("computer_exec", 50);
    await t.tool("computer_exec", 400);
    await t.tool("computer_exec", 400);
    return;
  }
  if (t.text.includes("my note")) tasks.finish(t.taskId, "done", "Used Postgres as asked.");
});
await until(() => (runRegistry.activeFor(steered.id)?.reply?.().parts.length ?? 0) >= 2);
res = await request("POST", `/conversations/${steered.id}/steer`, { text: "Use Postgres, not SQLite" });
const steerMessage = res.data as Message;
check("steer saved as a user message", res.status === 200 && steerMessage.steered === true && Boolean(steerMessage.steeredInto?.messageId), JSON.stringify(res.data).slice(0, 200));
await until(() => status(steered.id) === "done");
const steeredTurns = sentTo(steered.id);
check("fallback: stopped at the tool boundary, note sent next turn", steeredTurns[1]?.preamble.includes("Use Postgres, not SQLite") === true && steeredTurns[1]!.text.includes("my note"), steeredTurns[1]?.preamble);
const interrupted = messages.listByConversation(steered.id).find((m) => m.role === "assistant");
check(
  "…without losing work (finished tool kept, reply complete)",
  interrupted?.status === "complete" && interrupted.parts.filter((p) => p.type === "tool" && p.status === "done").length === 2,
  JSON.stringify(interrupted?.parts.map((p) => (p.type === "tool" ? p.status : p.type))),
);
check("note shows in the transcript", messages.get(steerMessage.id)?.steered === true);

const native = tasks.create({ agentId: ana.id, goal: "Native steer" });
const delivered: string[] = [];
scripts.set(native.id, async (t) => {
  if (t.index === 0) {
    t.run.steer = async (text) => (delivered.push(text), true);
    await t.tool("computer_exec", 30);
    while (!delivered.length && !t.run.controller.signal.aborted) await sleep(10);
    await t.tool("computer_exec", 30);
    tasks.finish(t.taskId, "done", `Took the note: ${delivered[0]}`);
  }
});
await until(() => runRegistry.activeFor(native.id)?.steer !== undefined);
steer(native.id, "Add rate limiting");
await until(() => status(native.id) === "done");
check("mid-turn delivery: no interruption, no extra turn", delivered[0] === "Add rate limiting" && sentTo(native.id).length === 1 && /Took the note/.test(taskStore.get(native.id)!.task.summary ?? ""));

settings.patch({ tasks: { perAgentLimit: 1 } });
const busy = tasks.create({ agentId: quinn.id, goal: "Busy" });
let busyDone = false;
scripts.set(busy.id, async (t) => {
  await t.tool("computer_exec", 5);
  while (!busyDone) await sleep(20);
  tasks.finish(t.taskId, "done", "ok");
});
const waiting = tasks.create({ agentId: quinn.id, goal: "Waiting" });
scripts.set(waiting.id, async (t) => void tasks.finish(t.taskId, "done", "ok"));
await until(() => status(busy.id) === "running");
res = await request("POST", `/conversations/${waiting.id}/messages`, { text: "Also check the docs" });
check("a message to a queued task is a note for its first turn", res.status === 200 && res.data.runId === "" && res.data.userMessage.steered === true);
busyDone = true;
await until(() => status(waiting.id) === "done");
check("…and goes with it", sentTo(waiting.id)[0]?.preamble.includes("Also check the docs") === true, sentTo(waiting.id)[0]?.preamble);
check("steering a finished task is refused", (await request("POST", `/conversations/${waiting.id}/steer`, { text: "x" })).status === 409);
settings.patch({ tasks: { perAgentLimit: 2 } });

// =============================================================================
// M3: restarts — running tasks become interrupted and resume by themselves
// =============================================================================
const survivor = tasks.create({ agentId: ana.id, goal: "Survive a restart" });
scripts.set(survivor.id, async (t) => {
  if (t.index === 0) {
    tasks.update(t.taskId, { plan: [{ text: "Step one", done: true }, { text: "Step two", done: false }] });
    await t.stopped;
    return;
  }
  tasks.finish(t.taskId, "done", "Survived.");
});
await until(() => runRegistry.activeFor(survivor.id) !== undefined);
// What index.ts does on SIGTERM, then a fresh boot.
tasks.shutdown();
runRegistry.stopAll();
await runLoop.settled(survivor.id);
check("shutdown leaves it running in the db", status(survivor.id) === "running");
runLoop.reset();
tasks.stopListening();
tasks.start();
await until(() => status(survivor.id) === "done");
const resumedTurn = sentTo(survivor.id)[1];
check("boot: interrupted, then resumed", events.some((e) => e.type === "task" && e.conversation.id === survivor.id && e.conversation.task?.status === "interrupted") && status(survivor.id) === "done");
check("…told it restarted, plan carried", resumedTurn?.preamble.includes("TOT restarted") === true && resumedTurn.preamble.includes("[x] Step one"), resumedTurn?.preamble);

settings.patch({ tasks: { resumeInterrupted: false } });
const parked = tasks.create({ agentId: ana.id, goal: "Stay parked" });
scripts.set(parked.id, async (t) => void (await t.stopped));
await until(() => runRegistry.activeFor(parked.id) !== undefined);
tasks.shutdown();
runRegistry.stopAll();
await runLoop.settled(parked.id);
runLoop.reset();
tasks.stopListening();
tasks.start();
await sleep(100);
check("auto-resume off: stays interrupted", status(parked.id) === "interrupted");
settings.patch({ tasks: { resumeInterrupted: true } });
await request("POST", `/tasks/${parked.id}/stop`);

// =============================================================================
// M2: coding tasks — two at once on one repo, each on its own branch and worktree
// =============================================================================
const coder = agents.create({ name: "Coder", mascot });
const computer = await computerManager.ensure(coder.id);
const sh = async (command: string, cwd?: string) => {
  const result = await computer.backend.exec(computer.externalId, command, { cwd, timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(`${command}: ${result.stderr}`);
  return result.stdout.trim();
};
await sh(
  "git init -q -b main repos/demo && cd repos/demo && git config user.email t@example.com && git config user.name Test && echo hello > README.md && git add . && git commit -qm init",
);
const mainSha = await sh("git rev-parse main", "repos/demo");
const edit = (file: string, commit: boolean): Script => async (t) => {
  const repo = taskStore.get(t.taskId)!.task.repo!;
  const cwd = repo.worktree.replace(/^~\//, "");
  await sh(`echo change > ${file}${commit ? ` && git add ${file} && git -c user.email=t@example.com -c user.name=T commit -qm 'add ${file}'` : ""}`, cwd);
  await t.tool("computer_exec", 5);
  tasks.finish(t.taskId, "done", `Added ${file}.`);
};
const codeA = tasks.create({ agentId: coder.id, goal: "Add a.txt", repo: "~/repos/demo" });
scripts.set(codeA.id, edit("a.txt", true));
const codeB = tasks.create({ agentId: coder.id, goal: "Add b.txt", repo: "~/repos/demo" });
scripts.set(codeB.id, edit("b.txt", false));
await until(() => status(codeA.id) === "done" && status(codeB.id) === "done", 20_000);
const repoA = taskStore.get(codeA.id)!.task.repo!;
const repoB = taskStore.get(codeB.id)!.task.repo!;
check("both coding tasks done", status(codeA.id) === "done" && status(codeB.id) === "done", `${status(codeA.id)} ${status(codeB.id)} ${taskStore.get(codeA.id)?.task.summary}`);
check("own branches and worktrees", repoA.branch !== repoB.branch && repoA.worktree !== repoB.worktree && repoA.baseBranch === "main" && Boolean(repoA.headSha && repoB.headSha));
check("main untouched", (await sh("git rev-parse main", "repos/demo")) === mainSha && (await sh("git status --porcelain", "repos/demo")) === "", await sh("git status --porcelain", "repos/demo"));
check("committed work on its branch", (await sh(`git log --format=%s ${repoA.branch} -1`, "repos/demo")) === "add a.txt");
let changes = (await request("GET", `/tasks/${codeA.id}/changes`)).data as TaskChanges;
check("diff A: only a.txt", changes.files.map((f) => `${f.path}:${f.status}:+${f.additions}`).join(",") === "a.txt:added:+1" && changes.patch.includes("+change"), JSON.stringify(changes.files));
changes = (await request("GET", `/tasks/${codeB.id}/changes`)).data as TaskChanges;
check("diff B: only b.txt (uncommitted, untracked)", changes.files.map((f) => `${f.path}:${f.status}`).join(",") === "b.txt:added" && changes.patch.includes("b/b.txt"), JSON.stringify(changes));

// The task's tools start in its worktree.
const { client: codeClient, call: codeCall } = await mcp(codeB.id);
r = await codeCall("computer_exec", { command: "git branch --show-current && ls" });
check("computer_exec starts in the worktree", r.text.includes(repoB.branch) && r.text.includes("b.txt"), r.text);
r = await codeCall("computer_read_file", { path: "b.txt" });
check("relative files resolve in the worktree", r.text.trim().endsWith("change"), r.text);
await codeClient.close();

res = await request("DELETE", `/conversations/${codeA.id}?deleteBranch=1`);
check("delete A: worktree and unpushed branch gone", res.status === 200 && !(await sh(`git branch --list ${repoA.branch}`, "repos/demo")) && !(await sh("ls .tot-worktrees", "repos/demo")).includes(repoA.worktree.split("/").pop()!));
res = await request("DELETE", `/conversations/${codeB.id}`);
check("delete B: branch kept", Boolean(await sh(`git branch --list ${repoB.branch}`, "repos/demo")) && !conversations.get(codeB.id));

// =============================================================================
// Chats ↔ tasks from the API: Run as task, Make this a task
// =============================================================================
const plain = conversations.create({ agentId: ana.id, modelId: "auto", title: "Landing page ideas" });
res = await request("POST", `/conversations/${plain.id}/tasks`, { goal: "Draft three landing page headlines" });
const fromChat = res.data as Conversation;
scripts.set(fromChat.id, async (t) => void tasks.finish(t.taskId, "done", "Three headlines."));
const plainMessages = messages.listByConversation(plain.id);
check(
  "Run as task: request and card in the chat",
  res.status === 201 && plainMessages[0]?.role === "user" && plainMessages[1]?.parts[0]?.type === "task" && fromChat.parentId === plain.id,
  JSON.stringify(plainMessages.map((m) => m.parts.map((p) => p.type))),
);
await until(() => status(fromChat.id) === "done");

const convertMe = conversations.create({ agentId: ana.id, modelId: "auto", title: "Fix the docs" });
conversations.update(convertMe.id, { systemPrompt: "old prompt" });
messages.insert({ id: randomUUID(), conversationId: convertMe.id, role: "user", parts: [{ type: "text", id: "x", text: "The docs are wrong" }], status: "complete", createdAt: Date.now() });
scripts.set(convertMe.id, async (t) => void tasks.finish(t.taskId, "done", "Docs fixed."));
res = await request("POST", `/conversations/${convertMe.id}/convert`, { goal: "Fix the docs" });
await until(() => status(convertMe.id) === "done");
const converted = conversations.get(convertMe.id)!;
check("Make this a task", res.status === 200 && converted.kind === "task" && converted.systemPrompt === null && sentTo(convertMe.id)[0]?.preamble.includes("This chat is now a task") === true, sentTo(convertMe.id)[0]?.preamble);
check("converting twice is refused", (await request("POST", `/conversations/${convertMe.id}/convert`, {})).status === 400);
res = await request("POST", `/tasks/${convertMe.id}/to-chat`);
check("back to a chat", res.status === 200 && conversations.get(convertMe.id)!.kind === "chat" && conversations.get(convertMe.id)!.task === null);
check("unknown task 404", (await request("POST", "/tasks/nope/pause")).status === 404);
check(
  "prompt sections",
  continuationPreamble({ ...taskStore.get(fromChat.id)!.task, plan: [] }, { turn: 3, notes: ["n1"], restarted: false, fresh: true, lastReply: "I did X" }).includes("fresh session") &&
    continuationPreamble(taskStore.get(fromChat.id)!.task, { turn: 3, notes: ["n1"], restarted: false, fresh: false, lastReply: "" }).includes("“n1”"),
);

// =============================================================================
// M5: notifications and intake
// =============================================================================
const notifyMe = tasks.create({ agentId: ana.id, goal: "Notify by Slack thread" });
slackThreads.add(notifyMe.id);
scripts.set(notifyMe.id, async (t) => void tasks.finish(t.taskId, "done", "The answer is 42."));
await until(() => notices.some((n) => n.id === notifyMe.id));
check("Slack-origin result goes to its thread", notices.some((n) => n.via === "slack" && n.id === notifyMe.id && n.text.includes("The answer is 42.")), JSON.stringify(notices));

const emailParent = conversations.create({ agentId: ana.id, modelId: "auto", title: "Emailed" });
emailThreads.add(emailParent.id);
const emailChild = tasks.startFromChat(emailParent.id, { goal: "Child of an emailed chat" }, "user");
scripts.set(emailChild.id, async (t) => void tasks.finish(t.taskId, "failed", "Couldn't reach the site."));
await until(() => notices.some((n) => n.id === emailParent.id));
check("a child of an emailed chat replies in that email thread", notices.some((n) => n.via === "email" && n.text.includes("failed") && n.text.includes("Couldn't reach the site.")), JSON.stringify(notices.at(-1)));

settings.patch({ tasks: { notifySlackUserId: "UALICE" } });
const dmMe = tasks.create({ agentId: ana.id, goal: "Tell me by DM" });
scripts.set(dmMe.id, async (t) => {
  tasks.update(t.taskId, { question: "Which region?" });
});
await until(() => notices.some((n) => n.via === "dm"));
check("otherwise a Slack DM (needs input too)", notices.some((n) => n.via === "dm" && n.id === "UALICE" && n.text.includes("Which region?")), JSON.stringify(notices.at(-1)));
settings.patch({ tasks: { notifySlackUserId: null } });
await request("POST", `/tasks/${dmMe.id}/stop`);

// Intake rule.
const intakeAgent = agents.create({ name: "Intake", mascot });
const intakeComputer = await computerManager.ensure(intakeAgent.id);
await intakeComputer.backend.exec(
  intakeComputer.externalId,
  "git init -q -b main repos/tot && cd repos/tot && git config user.email t@example.com && git config user.name T && echo x > x && git add . && git commit -qm init",
  { timeoutMs: 30_000 },
);
brains.create({ name: "tot", kind: "repo", source: "~/repos/tot", agentId: intakeAgent.id });
check("intake: work on a known repo", workRequest(intakeAgent.id, "fix the flaky test in tot")?.repo === "~/repos/tot");
check("intake: a job without a repo", workRequest(intakeAgent.id, "Research these 5 vendors and write a comparison")?.repo === undefined && workRequest(intakeAgent.id, "research these 5 vendors") !== null);
check("intake: questions stay chats", workRequest(intakeAgent.id, "what's the weather in Paris?") === null && workRequest(intakeAgent.id, "add a footer") === null);
check("intake: GitHub URLs count", workRequest(intakeAgent.id, "update the readme in https://github.com/acme/site.")?.repo === "https://github.com/acme/site");

// Slack end to end: "@TOT fix the flaky test in tot" → a queued coding task → the result in the thread.
const posted: { channel: string; thread_ts?: string; blocks?: any[] }[] = [];
const fakeApi = {
  auth: { test: async () => ({ team: "Acme", user: "tot", user_id: "UBOT" }) },
  chat: {
    postMessage: async (args: any) => (posted.push(args), { ts: `1790${String(posted.length).padStart(6, "0")}.000100` }),
    update: async () => ({}),
    delete: async () => ({}),
    getPermalink: async (args: any) => ({ permalink: `https://acme.slack.com/archives/${args.channel}/p1` }),
  },
  conversations: { replies: async () => ({ messages: [] }), info: async () => ({ channel: { name: "eng" } }) },
  users: { info: async () => ({ user: { profile: { display_name: "Alice" } } }) },
};
class FakeSocket extends EventEmitter {
  async start() {
    return {};
  }
  async disconnect() {}
}
const socket = new FakeSocket();
await slack.connect({ appToken: "xapp-1-test", botToken: "xoxb-test" }, { api: fakeApi, socket });
slack.patch({ allow: "UALICE", defaultAgentId: intakeAgent.id });
taskNotifications.use({
  slackThread: (id, text) => slack.postToThread(id, text),
  emailThread: async () => false,
  slackDm: async () => false,
});
const said = (text: string) => posted.some((p) => JSON.stringify(p.blocks ?? []).includes(text));
byGoal.push([
  /flaky test/,
  async (t) => {
    await t.tool("computer_exec", 5);
    tasks.finish(t.taskId, "done", "Fixed the race in checkout.test.ts.");
  },
]);
socket.emit("app_mention", { ack: async () => {}, event: { channel: "CENG", user: "UALICE", text: "<@UBOT> fix the flaky test in tot", ts: "1790000100.000100" } });
await until(() => said("Started a task"));
const slackTask = conversations.tasks({ agentId: intakeAgent.id })[0];
check("Slack: work lands as a coding task", Boolean(slackTask) && slackTask!.task?.repo?.source === "~/repos/tot" && slackTask!.origin?.kind === "slack" && slackTask!.origin.label === "#eng", JSON.stringify(slackTask?.task));
check("Slack: acknowledged in the thread", said("Started a task: *fix the flaky test in tot*"), JSON.stringify(posted.at(-1)?.blocks));
await until(() => said("Fixed the race in checkout.test.ts."), 15_000);
check("Slack: the result is posted in the thread", posted.some((p) => p.thread_ts === "1790000100.000100" && JSON.stringify(p.blocks).includes("Fixed the race")), JSON.stringify(posted.at(-1)));
socket.emit("app_mention", { ack: async () => {}, event: { channel: "CENG", user: "UALICE", text: "<@UBOT> also add a regression test", ts: "1790000100.000300", thread_ts: "1790000100.000100" } });
await until(() => said("Picked the task up again"));
check("Slack: a follow-up picks the task up again", said("Picked the task up again") && sentTo(slackTask!.id).at(-1)?.text.includes("also add a regression test") === true);
await until(() => status(slackTask!.id) === "done" || status(slackTask!.id) === "failed");
await slack.disconnect();

// =============================================================================
// Approvals mirror into status
// =============================================================================
const approval = tasks.create({ agentId: ana.id, goal: "Needs an OK" });
scripts.set(approval.id, async (t) => {
  appEvents.publish({ type: "approval", agentId: ana.id, conversationId: t.taskId, runId: t.run.id, partId: "p", message: "Send it?", pending: true });
  await sleep(50);
  appEvents.publish({ type: "approval", agentId: ana.id, conversationId: t.taskId, runId: t.run.id, partId: "p", message: "Send it?", pending: false });
  tasks.finish(t.taskId, "done", "Sent.");
});
await until(() => status(approval.id) === "done");
check(
  "pending approval → needs-input → running",
  events.some((e) => e.type === "task" && e.conversation.id === approval.id && e.conversation.task?.status === "needs-input") && status(approval.id) === "done",
);

server.close();
await until(() => runLoop.count() === 0);
const leftover = db.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE kind = 'task' AND json_extract(task, '$.status') = 'running'`).get() as { n: number };
check("nothing left running", leftover.n === 0 && runLoop.count() === 0, String(leftover.n));
taskQueue.stop();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
