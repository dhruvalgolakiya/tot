// Coordination (roadmap module 05): chats woken when their tasks finish, with fake model turns,
// fake Slack/email threads and a real MCP client for the agent's tools.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/coordination.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ConversationOrigin, Message, SendMessageRequest } from "../shared/types.ts";

process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test
const PORT = 8791;

const { HttpError } = await import("./agent/orchestrator.ts");
const { MessageBuilder } = await import("./agent/message-builder.ts");
const { runRegistry } = await import("./agent/runs.ts");
const { MCP_TOKEN } = await import("./config.ts");
const { agents } = await import("./data/agents.ts");
const { conversations, toPublicConversation } = await import("./data/conversations.ts");
const { messages } = await import("./data/messages.ts");
const { settings } = await import("./data/settings.ts");
const { createApp } = await import("./app.ts");
const { missionUsage } = await import("./orchestration/budget.ts");
const { fanIn } = await import("./orchestration/fanin.ts");
const { spawnMany } = await import("./orchestration/spawn.ts");
const { taskNotifications } = await import("./tasks/notify.ts");
const { runLoop } = await import("./tasks/run-loop.ts");
const { taskStore } = await import("./tasks/store.ts");
const { tasks } = await import("./tasks/tasks.ts");
const { chatWakes, wakeText } = await import("./tasks/wake.ts");
type Run = import("./agent/runs.ts").Run;
type TurnOptions = import("./agent/orchestrator.ts").TurnOptions;

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

// --- Fake model turns: a script per conversation (chats) or per goal (tasks) ------------------
interface Turn {
  id: string;
  text: string;
  index: number;
  options: TurnOptions;
  run: Run;
  say: (text: string) => void;
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
  const turn: Turn = {
    id: conversationId,
    text: request.text,
    index,
    options,
    run,
    say: (text) => builder.apply({ type: "text-delta", blockId: randomUUID(), delta: text }),
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
    const end = run.controller.signal.aborted ? "stopped" : "complete";
    builder.apply({ type: "usage", usage: { inputTokens: 1000, outputTokens: 200 } });
    const final = builder.finish(end);
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

server.close();
chatWakes.stop();
fanIn.stop();
await until(() => runLoop.count() === 0);
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
