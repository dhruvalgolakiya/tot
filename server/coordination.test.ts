// Coordination (roadmap module 05): chats woken when their tasks finish, with fake model turns,
// fake Slack/email threads and a real MCP client for the agent's tools.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/coordination.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ConversationOrigin, Message, SendMessageRequest } from "../shared/types.ts";

process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test
const PORT = 8791;

const { HttpError, sendMessage } = await import("./agent/orchestrator.ts");
const { limits } = await import("./agent/limits.ts");
const { lastExchange, selectContext, tokens, SWITCH_BUDGET } = await import("./agent/context-select.ts");
const { providers } = await import("./agent/providers/index.ts");
const { MessageBuilder } = await import("./agent/message-builder.ts");
const { runRegistry } = await import("./agent/runs.ts");
const { MCP_TOKEN } = await import("./config.ts");
const { agents } = await import("./data/agents.ts");
const { conversations, toPublicConversation } = await import("./data/conversations.ts");
const { messages } = await import("./data/messages.ts");
const { settings } = await import("./data/settings.ts");
const { CUT_OFF_BY_RESTART } = await import("./db.ts");
const { createApp } = await import("./app.ts");
const { missionUsage } = await import("./orchestration/budget.ts");
const { fanIn } = await import("./orchestration/fanin.ts");
const { handoffs } = await import("./orchestration/handoff.ts");
const { spawnMany } = await import("./orchestration/spawn.ts");
const { taskNotifications } = await import("./tasks/notify.ts");
const { runEnd, runLoop } = await import("./tasks/run-loop.ts");
const { taskStore } = await import("./tasks/store.ts");
const { tasks } = await import("./tasks/tasks.ts");
const { chatWakes, wakeText } = await import("./tasks/wake.ts");
type Run = import("./agent/runs.ts").Run;
type TurnOptions = import("./agent/orchestrator.ts").TurnOptions;
type TurnInput = import("./agent/providers/types.ts").TurnInput;
type AgentProvider = import("./agent/providers/types.ts").AgentProvider;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 240)}` : ""}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end && !condition(); ) await sleep(20);
}
const status = (id: string) => taskStore.get(id)?.task.status;
const mascot = { shape: "blob" as const, color: "#60a5fa", accessory: "none" as const, eyes: "dots" as const };
/** A promise and the function that settles it, for holding a fake turn open. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

settings.patch({ computer: { mode: "local" }, tasks: { perAgentLimit: 6, globalLimit: 12, maxChildren: 6, missionTokenBudget: 0 } });

// --- Fake providers behind the real turn pipeline (agent/orchestrator.ts), recording each turn's input ---
const providerTurns: { provider: "claude" | "chatgpt"; input: TurnInput }[] = [];
function fakeProvider(id: "claude" | "chatgpt", label: string, models: string[]): AgentProvider {
  return {
    id,
    label,
    status: async () => ({ id, label, installed: true, loggedIn: true, models: models.map((model) => ({ id: `${id}:${model}`, provider: id, model, label: model, available: true })) }),
    async *runTurn(input) {
      providerTurns.push({ provider: id, input });
      yield { type: "session", sessionId: input.sessionId ?? `${id}-session-${randomUUID().slice(0, 8)}` };
      yield { type: "text-delta", blockId: "b1", delta: `Reply from ${label}.` };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    },
    complete: async () => "A title",
  };
}
providers.claude = fakeProvider("claude", "Claude", ["claude-opus-5-5", "claude-sonnet-5-5"]);
providers.chatgpt = fakeProvider("chatgpt", "ChatGPT", ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]);
/** One real turn (through sendMessage) to its end; returns what the provider was given. */
async function realTurn(chatId: string, body: SendMessageRequest): Promise<TurnInput> {
  const { runId } = await sendMessage(chatId, body);
  await runEnd(runId);
  return providerTurns.at(-1)!.input;
}
/** Adds `n` alternating user / assistant messages to a chat, oldest first. */
function seed(chatId: string, n: number, text: (i: number) => string): Message[] {
  const added: Message[] = [];
  const at = Date.now() - n * 1000;
  for (let i = 0; i < n; i++) {
    const message: Message = { id: randomUUID(), conversationId: chatId, role: i % 2 ? "assistant" : "user", parts: [{ type: "text", id: randomUUID(), text: text(i) }], status: "complete", createdAt: at + i * 10 };
    messages.insert(message);
    added.push(message);
  }
  return added;
}

// --- Fake model turns: a script per conversation (chats) or per goal (tasks) ------------------
interface Turn {
  id: string;
  text: string;
  index: number;
  options: TurnOptions;
  run: Run;
  say: (text: string) => void;
  /** Ends the turn as a provider error. */
  fail: (error: string) => void;
  /** Resolves when the turn is stopped. */
  stopped: Promise<void>;
}
type Script = (turn: Turn) => Promise<void>;
const scripts = new Map<string, Script>();
const byGoal: [RegExp, Script][] = [];
const sent: { id: string; text: string; options: TurnOptions; at: number }[] = [];
const sentTo = (id: string) => sent.filter((s) => s.id === id);

async function fakeSend(conversationId: string, request: SendMessageRequest, options: TurnOptions = {}) {
  if (runRegistry.activeFor(conversationId)) throw new HttpError(409, "Busy.");
  const index = sentTo(conversationId).length;
  sent.push({ id: conversationId, text: request.text, options, at: Date.now() });
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
  const assistant: Message = { id: randomUUID(), conversationId, role: "assistant", parts: [], status: "streaming", provider: "claude", model: "claude-opus-5-5", createdAt: now + 1 };
  messages.insert(assistant);
  const run = runRegistry.create(conversationId, assistant.id);
  const builder = new MessageBuilder(assistant, (event) => run.push(event));
  run.reply = () => builder.message;
  run.addPart = (part) => {
    builder.add(part);
    messages.save(builder.message);
  };
  let failed: string | null = null;
  const turn: Turn = {
    id: conversationId,
    text: request.text,
    index,
    options,
    run,
    say: (text) => builder.apply({ type: "text-delta", blockId: randomUUID(), delta: text }),
    fail: (error) => void (failed = error),
    stopped: new Promise<void>((resolve) => run.controller.signal.addEventListener("abort", () => resolve(), { once: true })),
  };
  void (async () => {
    // Lets a test register a task's script right after creating it.
    await sleep(5);
    const goal = conversations.get(conversationId)?.task?.goal ?? "";
    const script = scripts.get(conversationId) ?? byGoal.find(([pattern]) => pattern.test(goal))?.[1] ?? (async (t: Turn) => t.say("ok"));
    try {
      await script(turn);
    } catch (err) {
      console.error("script failed:", err);
    }
    const end = run.controller.signal.aborted ? "stopped" : failed ? "error" : "complete";
    builder.apply({ type: "usage", usage: { inputTokens: 1000, outputTokens: 200 } });
    const final = builder.finish(end, failed ?? undefined);
    messages.save(final);
    run.push({ type: "run-end", status: end, message: final });
    runRegistry.finish(run);
  })();
  return { runId: run.id, userMessage: user, conversation: toPublicConversation(conversations.get(conversationId)!) };
}
runLoop.useSender(fakeSend);

// A task finishes on its first turn, after `ms`, with "<title>: result".
const finishAfter = (ms: number): Script => async (t) => {
  await sleep(ms);
  tasks.finish(t.id, "done", `${conversations.get(t.id)!.title}: result`);
  t.say("Done.");
};

// --- Fake Slack and email threads ---------------------------------------------------------
const notices: { via: string; id: string; text: string }[] = [];
const slackThreads = new Set<string>();
taskNotifications.use({
  slackThread: async (id, text) => (slackThreads.has(id) ? (notices.push({ via: "slack", id, text }), true) : false),
  emailThread: async () => false,
  slackDm: async (id, text) => (notices.push({ via: "dm", id, text }), true),
});

tasks.start();
taskNotifications.start();
fanIn.start();
chatWakes.start();
const server = serve({ fetch: createApp().fetch, port: PORT, hostname: "127.0.0.1" });
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
  const client = new Client({ name: "tot-coordination-test", version: "0.0.0" });
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

const ana = agents.create({ name: "Ana", mascot });
const chatWith = (title: string, origin?: ConversationOrigin) => conversations.create({ agentId: ana.id, modelId: "auto", title, origin });
const start = (chatId: string, title: string, goal = title) => tasks.startFromChat(chatId, { title, goal }, "agent");

// =============================================================================
// M1: wake the chat
// =============================================================================

// Two tasks finish 1 s apart (real 3 s batching): exactly one wake turn, with both results.
const batched = chatWith("Batching");
byGoal.push([/^Fix checkout/, finishAfter(10)], [/^Update docs/, finishAfter(1000)]);
const fix = start(batched.id, "Fix checkout");
const docs = start(batched.id, "Update docs");
check("the chat's turn is over; tasks run", !runRegistry.activeFor(batched.id) && sentTo(batched.id).length === 0);
await until(() => status(fix.id) === "done");
await sleep(400);
check("no wake while more results may come", sentTo(batched.id).length === 0 && conversations.get(batched.id)!.wakePending, JSON.stringify(sentTo(batched.id)));
await until(() => sentTo(batched.id).length > 0, 8000);
await until(() => !runRegistry.activeFor(batched.id));
await sleep(500);
const batchWake = sentTo(batched.id);
check("exactly one wake turn", batchWake.length === 1, String(batchWake.length));
check(
  "…an auto turn with both results",
  batchWake[0]?.options.auto === true &&
    batchWake[0].options.keepTitle === true &&
    batchWake[0].text === "2 tasks finished: “Fix checkout”, “Update docs”." &&
    batchWake[0].options.preamble!.includes("Fix checkout: result") &&
    batchWake[0].options.preamble!.includes("Update docs: result"),
  JSON.stringify(batchWake[0]?.text),
);
check("…batched: it waited for the second", batchWake[0]!.at - taskStore.get(docs.id)!.task.finishedAt! >= 2900, String(batchWake[0]!.at - taskStore.get(docs.id)!.task.finishedAt!));
check("…results read, nothing pending", conversations.get(batched.id)!.childResults.length === 0 && !conversations.get(batched.id)!.wakePending);
const divider = messages.listByConversation(batched.id).find((m) => m.role === "user" && m.auto);
check("…shown as the quiet auto divider", divider?.parts.some((p) => p.type === "text" && p.text === batchWake[0]!.text) === true);
check("wake turns count toward the mission's budget", conversations.get(batched.id)!.wakeTokens === 1200 && missionUsage(conversations.get(batched.id)!) === 1200 + 2 * 1200, String(missionUsage(conversations.get(batched.id)!)));
check("one task's text", wakeText([fix.id]) === "“Fix checkout” finished.");

// Shorter batching from here on.
chatWakes.useBatchDelay(200);

// A turn is running and the provider takes notes mid-turn: the results are steered in, no extra turn.
const steered = chatWith("Steering");
const steeredNotes: string[] = [];
const holdSteered = gate();
scripts.set(steered.id, async (t) => {
  if (t.index > 0) return t.say("An extra turn.");
  t.run.steer = async (text) => (steeredNotes.push(text), true);
  start(steered.id, "Quick lookup");
  await holdSteered.wait;
  t.say("Noted, the lookup is done.");
});
byGoal.push([/^Quick lookup/, finishAfter(10)]);
await fakeSend(steered.id, { text: "look this up quickly" });
await until(() => steeredNotes.length > 0);
check("steered into the running turn", steeredNotes.length === 1 && steeredNotes[0]!.includes("Quick lookup: result"), steeredNotes[0]);
check("…marked read", conversations.get(steered.id)!.childResults.length === 0 && !conversations.get(steered.id)!.wakePending);
holdSteered.open();
await until(() => !runRegistry.activeFor(steered.id));
await sleep(400);
check("…and no extra turn follows", sentTo(steered.id).length === 1, String(sentTo(steered.id).length));

// A turn is running and can't take notes: the wake waits for it to end, then is one auto turn.
const waiting = chatWith("Waiting");
const holdWaiting = gate();
scripts.set(waiting.id, async (t) => {
  if (t.index > 0) return t.say("The review is in: all fine.");
  start(waiting.id, "Review the plan");
  await holdWaiting.wait;
});
byGoal.push([/^Review the plan/, finishAfter(10)]);
await fakeSend(waiting.id, { text: "review the plan" });
await until(() => conversations.tasks({ parentId: waiting.id }).some((c) => c.task!.status === "done"));
await sleep(400);
check("no wake while the turn runs", sentTo(waiting.id).length === 1 && conversations.get(waiting.id)!.wakePending);
holdWaiting.open();
await until(() => sentTo(waiting.id).length === 2);
await until(() => !runRegistry.activeFor(waiting.id));
check("…then one auto turn", sentTo(waiting.id).length === 2 && sentTo(waiting.id)[1]!.options.auto === true && sentTo(waiting.id)[1]!.text === "“Review the plan” finished.");

// The agent checked both tasks with task_status before the wake: nothing is left to wake for.
const checked = chatWith("Checked");
const { client: checkedClient, call: checkedCall } = await mcp(checked.id);
byGoal.push([/^Check (A|B)$/, finishAfter(10)]);
scripts.set(checked.id, async (t) => {
  if (t.index > 0) return t.say("An extra turn.");
  const a = start(checked.id, "Check A");
  const b = start(checked.id, "Check B");
  await until(() => status(a.id) === "done" && status(b.id) === "done");
  await sleep(300);
  await checkedCall("task_status", { id: a.id });
  const r = await checkedCall("task_status", { id: b.id });
  t.say(`Both checked: ${r.text.slice(0, 40)}`);
});
await fakeSend(checked.id, { text: "check A and B" });
await until(() => !runRegistry.activeFor(checked.id));
await sleep(500);
check("task_status marks results read: no wake", sentTo(checked.id).length === 1 && conversations.get(checked.id)!.childResults.length === 0 && !conversations.get(checked.id)!.wakePending, String(sentTo(checked.id).length));
await checkedClient.close();

// Never two wake turns at once: results during a wake turn get exactly one follow-up when it ends.
const serial = chatWith("One at a time");
const holdFirstWake = gate();
let wakesRunning = 0;
let mostAtOnce = 0;
scripts.set(serial.id, async (t) => {
  wakesRunning++;
  mostAtOnce = Math.max(mostAtOnce, wakesRunning);
  if (t.index === 0) await holdFirstWake.wait;
  t.say(`Wake ${t.index + 1}.`);
  wakesRunning--;
});
byGoal.push([/^First job/, finishAfter(10)], [/^Second job/, finishAfter(10)], [/^Third job/, finishAfter(50)]);
const firstJob = start(serial.id, "First job");
await until(() => sentTo(serial.id).length === 1);
start(serial.id, "Second job");
start(serial.id, "Third job");
await until(() => conversations.tasks({ parentId: serial.id }).every((c) => c.task!.status === "done"));
await sleep(500);
check("results during a wake turn wait for it", sentTo(serial.id).length === 1 && status(firstJob.id) === "done");
holdFirstWake.open();
await until(() => sentTo(serial.id).length === 2);
await until(() => !runRegistry.activeFor(serial.id));
await sleep(500);
check(
  "…then exactly one follow-up with both",
  sentTo(serial.id).length === 2 && sentTo(serial.id)[1]!.text === "2 tasks finished: “Second job”, “Third job”.",
  JSON.stringify(sentTo(serial.id).map((s) => s.text)),
);
check("never two wake turns at once", mostAtOnce === 1);

// A wake pending when TOT stops happens once after it starts again.
const restarted = chatWith("Restart");
byGoal.push([/^Survive the restart/, finishAfter(10)]);
const survivor = start(restarted.id, "Survive the restart");
await until(() => status(survivor.id) === "done");
chatWakes.stop(); // what index.ts does on SIGTERM, before the wake's batching delay is over
await sleep(400);
check("pending across the shutdown", sentTo(restarted.id).length === 0 && conversations.get(restarted.id)!.wakePending && conversations.get(restarted.id)!.childResults.includes(survivor.id));
// Results from before wake-ups shipped are unread but were never flagged: they don't wake their chat.
const legacy = chatWith("Before wake-ups");
const oldTask = conversations.create({ agentId: ana.id, modelId: "auto", title: "Old task", kind: "task", parentId: legacy.id, task: { ...taskStore.get(survivor.id)!.task } });
conversations.update(legacy.id, { childResults: [oldTask.id] });
chatWakes.start();
await until(() => sentTo(restarted.id).length === 1);
await until(() => !runRegistry.activeFor(restarted.id));
chatWakes.stop();
chatWakes.start();
await sleep(500);
check("…happens once after startup", sentTo(restarted.id).length === 1 && sentTo(restarted.id)[0]!.text === "“Survive the restart” finished." && !conversations.get(restarted.id)!.wakePending);
check("old unread results don't wake their chat", sentTo(legacy.id).length === 0 && conversations.get(legacy.id)!.childResults.length === 1);

// A chat from Slack: the wake's reply goes to the thread, and the task's own "done" post is held back for it.
const fromSlack = chatWith("From Slack", { kind: "slack", label: "#eng", url: null });
slackThreads.add(fromSlack.id);
scripts.set(fromSlack.id, async (t) => t.say("The migration is done and the tests pass."));
byGoal.push([/^Run the migration/, finishAfter(10)]);
start(fromSlack.id, "Run the migration");
await until(() => sentTo(fromSlack.id).length === 1);
await until(() => notices.some((n) => n.id === fromSlack.id));
await sleep(200);
const slackPosts = notices.filter((n) => n.id === fromSlack.id);
check("Slack: one post, the wake's reply", slackPosts.length === 1 && slackPosts[0]!.text === "The migration is done and the tests pass.", JSON.stringify(slackPosts));

// Fan-in owns groups spawned with then: "synthesize": no wake on top of the writer turn.
const grouped = chatWith("Grouped");
byGoal.push([/^Part (one|two) of the comparison/, finishAfter(10)]);
spawnMany(grouped.id, [{ title: "Part one", goal: "Part one of the comparison" }, { title: "Part two", goal: "Part two of the comparison" }], { then: "synthesize", cards: { kind: "none" } });
await until(() => sentTo(grouped.id).length === 1);
await until(() => !runRegistry.activeFor(grouped.id));
await sleep(500);
check("synthesize groups: the writer turn only", sentTo(grouped.id).length === 1 && sentTo(grouped.id)[0]!.options.preamble!.includes("You're the writer now"), JSON.stringify(sentTo(grouped.id).map((s) => s.text)));

// Over the mission's token budget: no wake turn; the results wait for the user's next message.
settings.patch({ tasks: { missionTokenBudget: 1000 } });
const spent = chatWith("Over budget");
byGoal.push([/^Spend tokens/, finishAfter(10)]);
const spender = start(spent.id, "Spend tokens");
await until(() => status(spender.id) === "done");
await sleep(500);
check("over budget: no wake turn, results stay unread", sentTo(spent.id).length === 0 && conversations.get(spent.id)!.childResults.includes(spender.id) && !conversations.get(spent.id)!.wakePending);
settings.patch({ tasks: { missionTokenBudget: 0 } });

// Settings → Tasks: wake-ups off.
settings.patch({ tasks: { wakeChats: false } });
const quiet = chatWith("Quiet");
byGoal.push([/^Stay quiet/, finishAfter(10)]);
const quietTask = start(quiet.id, "Stay quiet");
await until(() => status(quietTask.id) === "done");
await sleep(500);
check("setting off: no wake, results wait for the next turn", sentTo(quiet.id).length === 0 && conversations.get(quiet.id)!.childResults.includes(quietTask.id) && !conversations.get(quiet.id)!.wakePending);
settings.patch({ tasks: { wakeChats: true } });

// =============================================================================
// M2: context selection on a provider switch, and chat_read paging
// =============================================================================

// The rules on their own: kept messages, newest first, whole messages in order.
const sample = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: `message ${i} ${"x".repeat(i === 20 ? 3000 : 300)}` }));
let picked = selectContext(sample, { budgetTokens: 2000, chatId: "chat-1" });
const order = [...picked.text.matchAll(/message (\d+) /g)].map((m) => Number(m[1]));
check("selection: the first user message is kept", order[0] === 0);
check("…and the latest user message and reply, newest first while they fit", order.includes(38) && order.includes(39) && order.at(-1) === 39);
check("…in their original order", order.every((n, i) => i === 0 || n > order[i - 1]!), order.join(","));
check("…whole messages only, stopping at the first that doesn't fit", !order.includes(20) && order.every((n) => n === 0 || n > 20) && !picked.text.includes("cut to fit"), order.join(","));
check("…within the budget", tokens(picked.text) <= 2000 && picked.included === order.length && picked.omitted === 40 - order.length, String(tokens(picked.text)));
check("…saying what was left out and how to read it", picked.text.includes(`${picked.omitted} earlier messages were left out`) && picked.text.includes('chat_read { chatId: "chat-1", before: "m') && picked.text.includes("left out here"));
picked = selectContext(sample.slice(0, 6), { budgetTokens: 2000, chatId: "chat-1" });
check("a short chat goes in whole", picked.included === 6 && picked.omitted === 0 && !picked.text.includes("left out"));
picked = selectContext([{ id: "a", role: "user", text: "y".repeat(40_000) }, { id: "b", role: "assistant", text: "ok" }], { budgetTokens: 1000, chatId: "chat-1" });
check("a kept message too big for the budget is cut, and says so", tokens(picked.text) <= 1000 && picked.text.includes("cut to fit") && picked.text.includes("<assistant>\nok"), String(tokens(picked.text)));

// A 300-message chat on Claude switches to ChatGPT: at most the budget goes over, with the pointer to the rest.
const long = chatWith("Long chat");
conversations.update(long.id, { provider: "claude", providerSessionId: "claude-session-long", systemPrompt: "You are TOT." });
const longHistory = seed(long.id, 300, (i) => (i === 0 ? "FIRST: plan the Q3 launch. " : `Turn ${i}: `) + "details ".repeat(60) + (i === 298 ? "LATEST-QUESTION" : i === 299 ? "LATEST-ANSWER" : ""));
let input = await realTurn(long.id, { text: "And what about pricing?", modelId: "chatgpt:gpt-6.1-sol" });
const block = /<conversation>[\s\S]*<\/conversation>(\n\[[^\]]*\])?/.exec(input.prompt)?.[0] ?? "";
check("switch: a fresh ChatGPT session, not a resume", providerTurns.at(-1)!.provider === "chatgpt" && !input.sessionId);
check("…at most the budget of earlier conversation", block.length > 0 && tokens(block) <= SWITCH_BUDGET, String(tokens(block)));
const at = (needle: string) => input.prompt.indexOf(needle);
check("…the first and latest user messages and the latest reply, in order", at("FIRST: plan") >= 0 && at("FIRST: plan") < at("LATEST-QUESTION") && at("LATEST-QUESTION") < at("LATEST-ANSWER"));
const skipped = Number(/\[(\d+) earlier messages were left out/.exec(input.prompt)?.[1] ?? 0);
check("…the omitted count and the chat_read pointer", skipped > 0 && input.prompt.includes(`chat_read { chatId: "${long.id}", before: "`), String(skipped));
check("…then the new message", at("The user's new message:") > at("</conversation>") && input.prompt.trimEnd().endsWith("And what about pricing?"));

// The model pages back through what was left out with chat_read (on this very chat).
const { client: longClient, call: longCall } = await mcp(long.id);
const before = /before: "([^"]+)"/.exec(input.prompt)![1]!;
let page = await longCall("chat_read", { chatId: long.id, before });
const gapEnd = longHistory.findIndex((m) => m.id === before);
check("chat_read reads this chat, from the pointer back", !page.isError && page.text.includes("(this chat)") && page.text.includes(`Turn ${gapEnd - 1}: `) && !page.text.includes(`Turn ${gapEnd}: `), page.text.slice(0, 160));
check("…20 messages a page, with a hint for more", page.text.includes(`messages ${gapEnd - 19}–${gapEnd} of 302`) && page.text.includes(`More before: chat_read { chatId: "${long.id}", before: "${longHistory[gapEnd - 20]!.id}" }`), page.text.slice(0, 120));
page = await longCall("chat_read", { chatId: long.id, before: longHistory[3]!.id, limit: 50 });
check("…the first page back has no hint", page.text.includes("messages 1–3 of 302") && !page.text.includes("More before"), page.text.slice(0, 120));
check("…at most 50 a page", (await longCall("chat_read", { chatId: long.id, limit: 51 })).isError);
const huge = chatWith("Huge message");
seed(huge.id, 1, () => "z".repeat(9000));
page = await longCall("chat_read", { chatId: huge.id });
check("…each message cut at 4,000 characters", page.text.includes("[cut at 4,000 characters]") && page.text.length < 4300, String(page.text.length));
const stranger = conversations.create({ agentId: agents.create({ name: "Bo", mascot }).id, modelId: "auto", title: "Not yours" });
check("…only chats of this agent", (await longCall("chat_read", { chatId: stranger.id })).isError);
await longClient.close();

// A short chat switches and goes in whole.
const short = chatWith("Short chat");
conversations.update(short.id, { provider: "claude", providerSessionId: "claude-session-short", systemPrompt: "You are TOT." });
seed(short.id, 6, (i) => `short message ${i}`);
input = await realTurn(short.id, { text: "next", modelId: "chatgpt:gpt-6.1-sol" });
check("a 6-message chat goes in whole", [0, 1, 2, 3, 4, 5].every((i) => input.prompt.includes(`short message ${i}`)) && !input.prompt.includes("left out"));
input = await realTurn(short.id, { text: "and again", modelId: "chatgpt:gpt-6.1-sol" });
check("…and the next turn resumes ChatGPT's own session", Boolean(input.sessionId) && !input.prompt.includes("<conversation>"));

// A handoff packet gets the last user message and the last reply verbatim, within 4k tokens.
byGoal.push([
  /^Carry the migration over/,
  async (t) => {
    if (t.index === 0) {
      handoffs.save(t.id, {
        goal: "Carry the migration over",
        doneSoFar: ["Wrote the schema"],
        decisions: [],
        plan: [{ text: "Write the schema", done: true }, { text: "Backfill", done: false }],
        files: [],
        tests: [],
        openQuestions: [],
        nextStep: "Backfill the rows",
      });
      runLoop.handOff(t.id, "Claude hit its usage limit");
      t.say("Schema written; next I backfill the rows.");
      return;
    }
    tasks.finish(t.id, "done", "Migrated.");
  },
]);
const migration = tasks.create({ agentId: ana.id, goal: "Carry the migration over to the new database" });
await until(() => status(migration.id) === "done");
const handedOver = sentTo(migration.id)[1]?.options.preamble ?? "";
check(
  "handoff: the packet, then the last exchange verbatim",
  handedOver.includes("<handoff>") && /<last_exchange>[\s\S]*Carry the migration over to the new database[\s\S]*Schema written; next I backfill the rows\.[\s\S]*<\/last_exchange>/.test(handedOver) && sentTo(migration.id)[1]!.options.freshSession === true,
  handedOver.slice(-300),
);
const bigReply: Message[] = [
  { id: "u1", conversationId: "x", role: "user", parts: [{ type: "text", id: "p1", text: "Do the thing" }], status: "complete", createdAt: 1 },
  { id: "u2", conversationId: "x", role: "user", parts: [{ type: "text", id: "p2", text: "Continue the task." }], status: "complete", auto: true, createdAt: 2 },
  { id: "a1", conversationId: "x", role: "assistant", parts: [{ type: "text", id: "p3", text: "w".repeat(50_000) }], status: "complete", createdAt: 3 },
];
const exchange = lastExchange(bigReply, { budgetTokens: 4000, chatId: "x" });
check("…the person's message (not TOT's own), and a huge reply cut to fit", exchange.includes("Do the thing") && !exchange.includes("Continue the task.") && tokens(exchange) <= 4000 && exchange.includes("cut to fit"), String(tokens(exchange)));

// =============================================================================
// M3: retry-safe task tools
// =============================================================================
const retries = chatWith("Retries");
byGoal.push([/^Retry-safe/, finishAfter(10)]);
const { client: retryClient, call: retryCall } = await mcp(retries.id);
const sessionArgs = (title: string) => ({ title, goal: `Retry-safe ${title}` });
const first = await retryCall("task_start", { ...sessionArgs("Deploy notes"), request_id: "req-deploy" });
const again = await retryCall("task_start", { ...sessionArgs("Deploy notes"), request_id: "req-deploy" });
const startedId = (text: string) => /([0-9a-f]{8}-[0-9a-f-]{27})/.exec(text)?.[1];
check("the same request_id twice: one task", conversations.tasks({ parentId: retries.id }).length === 1 && startedId(first.text) === startedId(again.text) && again.text.startsWith("Already started"), again.text);
await retryCall("task_start", { ...sessionArgs("Deploy notes"), request_id: "req-other" });
check("a different id: another task", conversations.tasks({ parentId: retries.id }).length === 2);
const fanOut = { sessions: [sessionArgs("Part A"), sessionArgs("Part B")], request_id: "req-fan" };
const firstSet = await retryCall("task_spawn_many", fanOut);
const secondSet = await retryCall("task_spawn_many", { ...fanOut, sessions: [sessionArgs("Part A"), sessionArgs("Part B"), sessionArgs("Part C")] });
const ids = (text: string) => [...text.matchAll(/- ([0-9a-f-]{36}) ·/g)].map((m) => m[1]).join(",");
check("task_spawn_many: a repeat returns the same set, in order", conversations.tasks({ parentId: retries.id }).length === 4 && ids(firstSet.text) === ids(secondSet.text) && ids(firstSet.text).split(",").length === 2 && secondSet.text.startsWith("Already started"), secondSet.text.slice(0, 200));
check("request ids are at most 100 characters", (await retryCall("task_start", { ...sessionArgs("Too long"), request_id: "x".repeat(101) })).isError && conversations.tasks({ parentId: retries.id }).length === 4);
await retryClient.close();

// After a restart (a new process opening the same database), the id still means the same task.
const afterRestart = execFileSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--disable-warning=ExperimentalWarning",
    "-e",
    `const { taskRequests } = await import("./server/tasks/requests.ts");
     const { tasks } = taskRequests.once(${JSON.stringify(retries.id)}, "req-deploy", () => { throw new Error("started again"); });
     console.log("TASKS " + tasks.map((t) => t.id).join(","));`,
  ],
  { env: process.env, encoding: "utf8" },
);
check("…even across a restart", afterRestart.includes(`TASKS ${startedId(first.text)}`), afterRestart.trim().split("\n").at(-1));

// "Run as task" from the app: a repeated request (a double click) gets the same task back.
const clicks = chatWith("Double click");
byGoal.push([/^Retry-safe clicked/, finishAfter(10)]);
const click = { goal: "Retry-safe clicked work", requestId: "click-1" };
const [c1, c2] = await Promise.all([request("POST", `/conversations/${clicks.id}/tasks`, click), request("POST", `/conversations/${clicks.id}/tasks`, click)]);
check(
  "route: requestId twice gives one task (201, then 200)",
  [c1.status, c2.status].sort().join(",") === "200,201" && c1.data.id === c2.data.id && conversations.tasks({ parentId: clicks.id }).length === 1,
  `${c1.status} ${c2.status}`,
);
check("…and only one request shows in the chat", messages.listByConversation(clicks.id).filter((m) => m.role === "user" && !m.auto).length === 1);

// =============================================================================
// M4: nothing ends silently
// =============================================================================

// A provider that keeps erroring: the task fails, and the agent's queue pauses instead of failing the next one too.
settings.patch({ tasks: { perAgentLimit: 1 } });
const cy = agents.create({ name: "Cy", mascot });
byGoal.push([/^Keeps erroring/, async (t) => t.fail("Claude Code crashed: socket hang up")], [/^Waits in line/, finishAfter(10)]);
const erroring = tasks.create({ agentId: cy.id, goal: "Keeps erroring on every turn" });
const waitingInLine = tasks.create({ agentId: cy.id, goal: "Waits in line behind it" });
await until(() => status(erroring.id) === "failed");
await sleep(300);
check("repeated errors: the task fails", taskStore.get(erroring.id)!.task.summary?.startsWith("Stopped after repeated errors: Claude Code crashed") === true, taskStore.get(erroring.id)!.task.summary ?? "");
check("…the next task stays queued", status(waitingInLine.id) === "queued" && sentTo(waitingInLine.id).length === 0);
const held = agents.get(cy.id)!.queueHold;
check("…and the queue shows paused, with the provider and the error", held?.provider === "claude" && held.reason === "Claude Code crashed: socket hang up", JSON.stringify(held));
const resumed = await request("POST", `/agents/${cy.id}/queue/resume`);
check("Resume clears the hold", resumed.status === 200 && resumed.data.queueHold === null && agents.get(cy.id)!.queueHold === null);
await until(() => status(waitingInLine.id) === "done");
check("…and starts the next task", status(waitingInLine.id) === "done");

// A usage limit never holds the queue (failover switches provider or waits for the reset).
const dee = agents.create({ name: "Dee", mascot });
limits.mark("claude", "You've hit your Claude limit · resets 7:30am (UTC)");
byGoal.push([/^Hits the limit/, async (t) => t.fail("You've hit your usage limit.")], [/^After the limit/, finishAfter(10)]);
const limited = tasks.create({ agentId: dee.id, goal: "Hits the limit every turn" });
const afterLimit = tasks.create({ agentId: dee.id, goal: "After the limit, still runs" });
await until(() => status(afterLimit.id) === "done");
check("a usage limit doesn't hold the queue", status(limited.id) === "failed" && status(afterLimit.id) === "done" && agents.get(dee.id)!.queueHold === null);
limits.clear("claude");
settings.patch({ tasks: { perAgentLimit: 6 } });

// A stopped task: its chat gets a notice, and the stop is in the next turn's results (here, the wake).
const stopChat = chatWith("Stopping");
byGoal.push([/^Runs until stopped/, async (t) => void (await t.stopped)]);
const longRunning = start(stopChat.id, "Runs until stopped");
await until(() => runRegistry.activeFor(longRunning.id) !== undefined);
await request("POST", `/tasks/${longRunning.id}/stop`);
await until(() => sentTo(stopChat.id).length === 1);
await until(() => !runRegistry.activeFor(stopChat.id));
const stopNotice = messages.listByConversation(stopChat.id).flatMap((m) => m.parts).find((p) => p.type === "notice");
check("stopped: the chat gets a notice", stopNotice?.type === "notice" && stopNotice.text === "“Runs until stopped” was stopped." && stopNotice.kind === "warning", JSON.stringify(stopNotice));
const stopWake = sentTo(stopChat.id)[0]!;
check("…and its next turn hears it, with no result", stopWake.options.preamble!.includes('"status": "stopped"') && stopWake.options.preamble!.includes("there's no result") && !stopWake.options.preamble!.includes("summary"), stopWake.options.preamble);

// Deleting a task isn't news to its chat.
const deleteChat = chatWith("Deleting");
const doomed = start(deleteChat.id, "Runs until stopped, then deleted");
await until(() => runRegistry.activeFor(doomed.id) !== undefined);
await request("DELETE", `/conversations/${doomed.id}`);
await sleep(400);
check("a deleted task: no notice, no wake", !messages.listByConversation(deleteChat.id).some((m) => m.parts.some((p) => p.type === "notice")) && sentTo(deleteChat.id).length === 0);

// Cut off by a restart, with auto-resume off: the chat hears it's waiting to be resumed.
settings.patch({ tasks: { resumeInterrupted: false } });
const cutChat = chatWith("Restart cut-off");
const cut = start(cutChat.id, "Runs until stopped across a restart");
await until(() => runRegistry.activeFor(cut.id) !== undefined);
// What index.ts does on SIGTERM, then a fresh boot.
tasks.shutdown();
chatWakes.stop();
runRegistry.stopAll();
await runLoop.settled(cut.id);
runLoop.reset();
tasks.stopListening();
chatWakes.start();
tasks.start();
await until(() => sentTo(cutChat.id).length === 1);
await until(() => !runRegistry.activeFor(cutChat.id));
const cutNotice = messages.listByConversation(cutChat.id).flatMap((m) => m.parts).find((p) => p.type === "notice");
check(
  "interrupted, not resuming: the chat gets a notice",
  status(cut.id) === "interrupted" && cutNotice?.type === "notice" && cutNotice.text === "“Runs until stopped across a restart” was cut off when TOT restarted and is waiting for you to resume it.",
  JSON.stringify(cutNotice),
);
check("…and its next turn hears it", sentTo(cutChat.id)[0]!.options.preamble!.includes('"status": "interrupted"'));
settings.patch({ tasks: { resumeInterrupted: true } });
await request("POST", `/tasks/${cut.id}/stop`);

// A chat's reply cut off by a restart: marked so on startup, and its next turn hears it once.
await until(() => runLoop.count() === 0 && !runRegistry.activeFor(cutChat.id) && !runRegistry.activeFor(stopChat.id));
await sleep(400);
const cutReply = chatWith("Reply cut off");
seed(cutReply.id, 1, () => "Write me a long report");
const streaming: Message = { id: randomUUID(), conversationId: cutReply.id, role: "assistant", parts: [{ type: "text", id: randomUUID(), text: "Here's the first half of the rep" }], status: "streaming", createdAt: Date.now() };
messages.insert(streaming);
// Opening the database again is what a restart does to a reply that was still streaming.
execFileSync(process.execPath, ["--import", "tsx", "--disable-warning=ExperimentalWarning", "-e", `await import("./server/db.ts");`], { env: process.env });
const marked = messages.get(streaming.id)!;
check("startup marks a cut-off reply, saying why", marked.status === "stopped" && marked.error === CUT_OFF_BY_RESTART, `${marked.status} ${marked.error}`);
input = await realTurn(cutReply.id, { text: "where were we?" });
check("…the chat's next turn is told once", input.prompt.startsWith("[TOT restarted during your last reply, so it was cut off. Check where things stand before you carry on.]"), input.prompt.slice(0, 120));
input = await realTurn(cutReply.id, { text: "and now?" });
check("…and not again", !input.prompt.includes("TOT restarted"));

server.close();
chatWakes.stop();
fanIn.stop();
await until(() => runLoop.count() === 0);
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
