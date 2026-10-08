// Orchestration (roadmap module 02): tiers, spawning limits, handoffs, failover and fan-in,
// with fake model turns, a fake classifier, a fake handoff writer and fixture provider statuses.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/orchestration.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import type { Message, ModelOption, ProviderStatus, SendMessageRequest } from "../shared/types.ts";

process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test
const PORT = 8792;

const { HttpError } = await import("./agent/orchestrator.ts");
const { limits } = await import("./agent/limits.ts");
const { MessageBuilder } = await import("./agent/message-builder.ts");
const { resolveRoute } = await import("./agent/router.ts");
const { runRegistry } = await import("./agent/runs.ts");
const { agents } = await import("./data/agents.ts");
const { conversations, toPublicConversation } = await import("./data/conversations.ts");
const { messages } = await import("./data/messages.ts");
const { settings } = await import("./data/settings.ts");
const { createApp } = await import("./app.ts");
const { checkSpawn } = await import("./orchestration/budget.ts");
const { taskFailover } = await import("./orchestration/failover.ts");
const { fanIn } = await import("./orchestration/fanin.ts");
const { handoffs, packetFromState, validateHandoff } = await import("./orchestration/handoff.ts");
const { toResult } = await import("./orchestration/roles.ts");
const { spawnMany } = await import("./orchestration/spawn.ts");
const { statuses } = await import("./orchestration/statuses.ts");
const { defaultChatgptModel, pickTier, tierModel } = await import("./orchestration/tiers.ts");
const { taskNotifications } = await import("./tasks/notify.ts");
const { runLoop } = await import("./tasks/run-loop.ts");
const { taskStore } = await import("./tasks/store.ts");
const { tasks } = await import("./tasks/tasks.ts");
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

settings.patch({ computer: { mode: "local" }, memory: { enabled: true }, tasks: { perAgentLimit: 6, globalLimit: 12, maxChildren: 6 } });

// --- Fixture providers: both signed in, with the real model lists -----------------------
const option = (provider: "claude" | "chatgpt", model: string, label: string): ModelOption => ({ id: `${provider}:${model}`, provider, model, label, available: true });
const CLAUDE: ProviderStatus = {
  id: "claude",
  label: "Claude",
  installed: true,
  loggedIn: true,
  models: [option("claude", "claude-opus-5-5", "Claude Opus 5.5"), option("claude", "claude-sonnet-5-5", "Claude Sonnet 5.5"), option("claude", "claude-fable-5-1", "Claude Fable 5.1")],
};
const CHATGPT: ProviderStatus = {
  id: "chatgpt",
  label: "ChatGPT",
  installed: true,
  loggedIn: true,
  models: [
    option("chatgpt", "gpt-6.1-sol", "GPT-6.1 Sol"),
    option("chatgpt", "gpt-6-astra", "GPT-6 Astra"),
    option("chatgpt", "gpt-6-sol", "GPT-6 Sol"),
    option("chatgpt", "gpt-6-luna", "GPT-6 Luna"),
    option("chatgpt", "gpt-5.6-sol", "GPT-5.6 Sol"),
    option("chatgpt", "gpt-5.6-luna", "GPT-5.6 Luna"),
  ],
};
let fixture: ProviderStatus[] = [CLAUDE, CHATGPT];
statuses.use(async () => fixture);

// --- Fake model turns (like tasks.test.ts), recording each turn's options -----------------
interface Turn {
  id: string;
  text: string;
  index: number;
  options: TurnOptions;
  run: Run;
  say: (text: string) => void;
  tool: (name: string) => void;
  /** End this turn as a usage-limit failure on `provider` (what the provider stream would report). */
  limit: (provider: "claude" | "chatgpt") => void;
}
type Script = (turn: Turn) => Promise<void>;
const scripts = new Map<string, Script>();
const byGoal: [RegExp, Script][] = [];
const sent: { id: string; text: string; options: TurnOptions }[] = [];
const sentTo = (id: string) => sent.filter((s) => s.id === id);

async function fakeSend(conversationId: string, request: SendMessageRequest, options: TurnOptions = {}) {
  if (runRegistry.activeFor(conversationId)) throw new HttpError(409, "Busy.");
  const index = sentTo(conversationId).length;
  sent.push({ id: conversationId, text: request.text, options });
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
  // Which provider this turn runs on: the one asked for, else Claude (as Auto would with both up).
  const provider = options.prefer ?? "claude";
  const assistant: Message = { id: randomUUID(), conversationId, role: "assistant", parts: [], status: "streaming", provider, model: provider === "claude" ? "claude-opus-5-5" : "gpt-6.1-sol", createdAt: now + 1 };
  messages.insert(assistant);
  const run = runRegistry.create(conversationId, assistant.id);
  const builder = new MessageBuilder(assistant, (event) => run.push(event));
  run.reply = () => builder.message;
  run.addPart = (part) => {
    builder.add(part);
    messages.save(builder.message);
  };
  let limited: string | null = null;
  const turn: Turn = {
    id: conversationId,
    text: request.text,
    index,
    options,
    run,
    say: (text) => builder.apply({ type: "text-delta", blockId: randomUUID(), delta: text }),
    tool: (name) => {
      const id = randomUUID();
      builder.apply({ type: "tool-start", toolCallId: id, name, input: {} });
      builder.apply({ type: "tool-end", toolCallId: id, output: "ok" });
    },
    limit: (p) => {
      limits.mark(p, `You've hit your ${p} limit · resets 7:30am (UTC)`);
      limited = "You've hit your usage limit.";
    },
  };
  void (async () => {
    await sleep(5);
    const goal = conversations.get(conversationId)?.task?.goal ?? "";
    const script = scripts.get(conversationId) ?? byGoal.find(([pattern]) => pattern.test(goal))?.[1] ?? (async (t: Turn) => t.say("ok"));
    try {
      await script(turn);
    } catch (err) {
      console.error("script failed:", err);
    }
    const end = run.controller.signal.aborted ? (run.stopReason === "steer" ? "complete" : "stopped") : limited ? "error" : "complete";
    builder.apply({ type: "usage", usage: { inputTokens: 1000, outputTokens: 200 } });
    const final = builder.finish(end, limited ?? undefined);
    messages.save(final);
    run.push({ type: "run-end", status: end, message: final });
    runRegistry.finish(run);
  })();
  return { runId: run.id, userMessage: user, conversation: toPublicConversation(conversations.get(conversationId)!) };
}
runLoop.useSender(fakeSend);

// Handoffs: a fake model that writes a good packet (or, when told, a bad one).
let writerCalls: { provider: string; model: string; prompt: string }[] = [];
let writeBadPackets = false;
handoffs.useWriter(async (prompt, provider, model) => {
  writerCalls.push({ provider, model, prompt });
  if (writeBadPackets) return '{"goal": "x"}';
  return `Here you go:\n${JSON.stringify({
    goal: "Fix the checkout bug",
    doneSoFar: ["Reproduced the 500 on an empty cart"],
    decisions: [{ decision: "Guard in total()", why: "Smallest fix" }],
    plan: [
      { text: "Reproduce", done: true },
      { text: "Fix", done: false },
    ],
    files: [{ path: "src/checkout.ts", change: "guard for empty cart" }],
    tests: [{ command: "npm test", status: "not-run" }],
    openQuestions: [],
    nextStep: "Write the guard and a test",
  })}`;
});
taskNotifications.use({ slackThread: async () => false, emailThread: async () => false, slackDm: async () => false });

tasks.start();
taskNotifications.start();
fanIn.start();
taskFailover.start();
const stopAutoHandoffs = handoffs.start();
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

// =============================================================================
// Tiers
// =============================================================================
const chatgptIds = CHATGPT.models.map((m) => m.model);
check(
  "ChatGPT tier defaults from its model list",
  defaultChatgptModel("deep", chatgptIds) === "gpt-6.1-sol" && defaultChatgptModel("standard", chatgptIds) === "gpt-6-sol" && defaultChatgptModel("fast", chatgptIds) === "gpt-6-luna",
  ["fast", "standard", "deep"].map((t) => defaultChatgptModel(t as never, chatgptIds)).join(","),
);
check("Claude tiers", tierModel("fast", "claude", fixture)?.model === "claude-sonnet-5-5" && tierModel("fast", "claude", fixture)?.effort === "low" && tierModel("deep", "claude", fixture)?.model === "claude-opus-5-5");
let pick = pickTier("deep", { statuses: fixture, limited: new Set(["claude"]) });
check("a provider in cooldown is avoided", pick?.provider === "chatgpt" && pick.model === "gpt-6.1-sol" && pick.note === "Claude at its usage limit", JSON.stringify(pick));
pick = pickTier("fast", { statuses: fixture, limited: new Set(), prefer: "chatgpt" });
check("a preferred provider is used", pick?.provider === "chatgpt" && pick.model === "gpt-6-luna" && !pick.note, JSON.stringify(pick));
pick = pickTier("deep", { statuses: fixture, limited: new Set(["claude", "chatgpt"]) });
check("both limited: still tries", pick?.provider === "claude");
pick = pickTier("deep", { statuses: [CLAUDE, { ...CHATGPT, loggedIn: false }], limited: new Set(), prefer: "chatgpt" });
check("preferred but not connected", pick?.provider === "claude" && pick.note === "ChatGPT not connected", JSON.stringify(pick));
settings.patch({ models: { tiers: { standard: { claude: "claude-fable-5-1", chatgpt: null }, fast: { claude: null, chatgpt: "gpt-5.6-luna" }, deep: { claude: null, chatgpt: null } } } });
check("Settings → Models picks a tier's model", tierModel("standard", "claude", fixture)?.model === "claude-fable-5-1" && tierModel("fast", "chatgpt", fixture)?.model === "gpt-5.6-luna");
settings.patch({ models: { tiers: { standard: { claude: "gone-model", chatgpt: null }, fast: { claude: null, chatgpt: null }, deep: { claude: null, chatgpt: null } } } });
check("…falling back when that model is gone", tierModel("standard", "claude", fixture)?.model === "claude-sonnet-5-5");
let route = resolveRoute("auto", "hi", { statuses: fixture, limited: new Set() });
check("router: quick ask → fast", route.ok && route.route.model === "claude-sonnet-5-5" && route.route.effort === "low" && route.route.reason === "Auto · quick ask → Sonnet 5.5", JSON.stringify(route));
route = resolveRoute("auto", "hi", { statuses: fixture, limited: new Set(), tier: "standard" });
check("router: a tier asked for", route.ok && route.route.model === "claude-sonnet-5-5" && route.route.effort === "high", JSON.stringify(route));
route = resolveRoute("auto", "refactor the billing service in our api", { statuses: fixture, limited: new Set(["claude"]) });
check("router: complex on ChatGPT when Claude is limited", route.ok && route.route.model === "gpt-6.1-sol" && /\(Claude at its usage limit\)$/.test(route.route.reason), JSON.stringify(route));
route = resolveRoute("auto", "hi", { statuses: fixture, limited: new Set(), thinkHarder: true });
check("router: think harder → deep at xhigh", route.ok && route.route.model === "claude-opus-5-5" && route.route.effort === "xhigh");
route = resolveRoute("claude:claude-sonnet-5-5", "hi", { statuses: fixture, limited: new Set(), tier: "deep" });
check("router: a picked model wins over tiers", route.ok && route.route.model === "claude-sonnet-5-5" && route.route.reason === "Picked by you");

const dana = agents.create({ name: "Dana", mascot });

// =============================================================================
// M1: an explorer child on the fast tier returns a structured result, shown as a card
// =============================================================================
const chat = conversations.create({ agentId: dana.id, modelId: "auto", title: "Checkout" });
byGoal.push([
  /^Find where the cart total/,
  async (t) => {
    t.tool("computer_exec");
    tasks.finish(
      t.id,
      "done",
      "The total is computed in src/checkout.ts:12.",
      toResult("The total is computed in src/checkout.ts:12.", { findings: ["total() in src/checkout.ts:12", "no guard for empty carts"], files_changed: [], confidence: "high", sources: ["src/checkout.ts"] }),
    );
  },
]);
const [explorer] = spawnMany(chat.id, [{ title: "Find the cart total", goal: "Find where the cart total is computed", role: "explorer", done: "File and line" }], { cards: { kind: "message", text: "Looking." } });
await until(() => status(explorer!.id) === "done");
const explorerTurn = sentTo(explorer!.id)[0];
check("explorer runs on the fast tier", explorer!.task.tier === "fast" && explorerTurn?.options.tier === "fast" && explorerTurn.options.heavy === "explorer", JSON.stringify(explorerTurn?.options));
check("its first turn is the brief", explorerTurn?.text.startsWith("Find where the cart total is computed") === true && explorerTurn.text.includes("Done means: File and line"), explorerTurn?.text);
const result = taskStore.get(explorer!.id)!.task.result;
check("structured result kept", result?.findings.length === 2 && result.confidence === "high" && result.sources[0] === "src/checkout.ts", JSON.stringify(result));
const cardMessage = messages.listByConversation(chat.id).find((m) => m.parts.some((p) => p.type === "task" && p.taskId === explorer!.id));
check("the parent shows a card, not a transcript", Boolean(cardMessage) && !messages.listByConversation(chat.id).some((m) => m.parts.some((p) => p.type === "text" && p.text.includes("computer_exec"))));
check("the depth-1 child", explorer!.task.depth === 1 && explorer!.parentId === chat.id);

// A reviewer goes to the other provider from its parent's.
conversations.update(chat.id, { provider: "claude" });
const [reviewer] = spawnMany(chat.id, [{ goal: "Review the checkout fix", role: "reviewer" }], { cards: { kind: "none" } });
check("reviewer on the other provider, deep tier", reviewer!.task.provider === "chatgpt" && reviewer!.task.tier === "deep");
await until(() => sentTo(reviewer!.id).length > 0);
check("…and its turns prefer that provider", sentTo(reviewer!.id)[0]?.options.prefer === "chatgpt");
await request("POST", `/tasks/${reviewer!.id}/stop`);

// =============================================================================
// Limits: depth and children per parent (no token budget)
// =============================================================================
const level1 = taskStore.get(explorer!.id)!;
const [level2] = spawnMany(level1.id, [{ goal: "A sub-task", role: "explorer" }], { cards: { kind: "none" } });
check("a task can start a task (depth 2)", level2!.task.depth === 2 && level2!.parentId === level1.id);
let refused: unknown = null;
try {
  checkSpawn(taskStore.get(level2!.id)!, 1);
} catch (err) {
  refused = err;
}
check("…but no deeper", refused instanceof HttpError && /2 levels/.test(refused.message), String(refused));
await request("POST", `/tasks/${level2!.id}/stop`);
// The chat has started two tasks so far (the explorer and the reviewer).
settings.patch({ tasks: { maxChildren: 2 } });
refused = null;
try {
  spawnMany(chat.id, [{ goal: "one more" }], { cards: { kind: "none" } });
} catch (err) {
  refused = err;
}
check("children per parent capped", refused instanceof HttpError && /at most 2 tasks/.test(refused.message), String(refused));
settings.patch({ tasks: { maxChildren: 6 } });
const unlimited = tasks.create({ agentId: dana.id, parentId: chat.id, goal: "No budget: it just runs" });
await until(() => status(unlimited.id) !== "queued");
check("no token budget: a mission's tasks keep starting", status(unlimited.id) !== "paused", status(unlimited.id));
await request("POST", `/tasks/${unlimited.id}/stop`);

// =============================================================================
// M3: handoff packets, and "Continue on" the other provider without the transcript
// =============================================================================
const goodPacket = { goal: "g", doneSoFar: [], decisions: [], plan: [], files: [], tests: [], openQuestions: [], nextStep: "n", from: { provider: "claude", model: "m" }, createdAt: 1 };
check("handoff validation: a full packet", validateHandoff(goodPacket).ok);
const missing = validateHandoff({ ...goodPacket, nextStep: undefined });
check("handoff validation: missing fields rejected", !missing.ok && /nextStep/.test(missing.ok ? "" : missing.error), JSON.stringify(missing));
check("handoff validation: wrong test status rejected", !validateHandoff({ ...goodPacket, tests: [{ command: "npm test", status: "flaky" }] }).ok);

const fixer = tasks.create({ agentId: dana.id, goal: "Fix the checkout bug" });
let continued = false;
scripts.set(fixer.id, async (t) => {
  if (t.index === 0) {
    tasks.update(t.id, { progress: "Fixing the empty-cart 500" });
    t.tool("computer_exec");
    t.say("Reproduced it.");
    while (!continued && !t.run.controller.signal.aborted) await sleep(20);
    return;
  }
  t.tool("computer_write_file");
  tasks.finish(t.id, "done", `Fixed on ${t.options.prefer}.`);
});
await until(() => runRegistry.activeFor(fixer.id) !== undefined);
writerCalls = [];
let res = await request("POST", `/tasks/${fixer.id}/continue-on`, { provider: "chatgpt" });
continued = true;
await until(() => status(fixer.id) === "done");
const switched = sentTo(fixer.id)[1];
check("Continue on ChatGPT: done there", res.status === 200 && status(fixer.id) === "done" && taskStore.get(fixer.id)!.task.summary === "Fixed on chatgpt.", `${res.status} ${status(fixer.id)} ${taskStore.get(fixer.id)?.task.summary}`);
check(
  "…in a fresh session from the packet, not the transcript",
  switched?.options.freshSession === true && switched.options.prefer === "chatgpt" && /handoff packet written by claude/.test(switched.options.preamble ?? "") && switched.options.preamble!.includes('"nextStep": "Write the guard and a test"'),
  switched?.options.preamble?.slice(0, 200),
);
check("packet written by the current provider's fast model", writerCalls[0]?.provider === "claude" && writerCalls[0].model === "claude-sonnet-5-5" && writerCalls[0].prompt.includes("Reproduced it."), JSON.stringify(writerCalls[0]?.provider));
// Finishing writes one more packet, now from ChatGPT's side.
await until(() => taskStore.get(fixer.id)!.task.handoff?.from.provider === "chatgpt");
const packet = taskStore.get(fixer.id)!.task.handoff!;
check("packets stamped by TOT (from, time)", packet.from.provider === "chatgpt" && packet.createdAt > 0 && packet.doneSoFar[0] === "Reproduced the 500 on an empty cart", JSON.stringify(packet.from));
check(
  "the switch shows as a notice",
  messages.listByConversation(fixer.id).some((m) => m.parts.some((p) => p.type === "notice" && p.text === "Continued on ChatGPT from a handoff.")),
);

writeBadPackets = true;
const written = await handoffs.write(fixer.id);
check("a model's bad packet → one from the task's state", written.goal === "Fix the checkout bug" && written.nextStep.length > 0 && writerCalls.length >= 3, JSON.stringify(written).slice(0, 150));
writeBadPackets = false;
check(
  "packet from state: a finished task's next step points at its plan file",
  packetFromState(taskStore.get(fixer.id)!).nextStep.includes(`~/tot-tasks/${fixer.id}/PLAN.md`),
  packetFromState(taskStore.get(fixer.id)!).nextStep,
);
let saved: unknown = null;
try {
  handoffs.save(fixer.id, { goal: "x" });
} catch (err) {
  saved = err;
}
check("handoff_write checks the packet", saved instanceof HttpError && /missing/.test(saved.message));
check("handoff_write keeps a good one", handoffs.save(fixer.id, { ...goodPacket, nextStep: "Ship it" }).nextStep === "Ship it");

// =============================================================================
// M4: automatic failover — switch providers (on), or pause until the reset (off)
// =============================================================================
limits.clear("claude");
limits.clear("chatgpt");
const failing = tasks.create({ agentId: dana.id, goal: "Long refactor that hits a limit" });
scripts.set(failing.id, async (t) => {
  if (t.index === 0) {
    tasks.update(t.id, { progress: "Part two" });
    t.tool("computer_exec");
    t.limit("claude");
    return;
  }
  tasks.finish(t.id, "done", `Finished on ${t.options.prefer}.`);
});
await until(() => status(failing.id) === "done");
const afterLimit = sentTo(failing.id)[1];
check("limit mid-task, switching on → carries on with ChatGPT", taskStore.get(failing.id)!.task.summary === "Finished on chatgpt." && afterLimit?.options.freshSession === true, taskStore.get(failing.id)?.task.summary ?? "");
check("…from a handoff written without the limited provider", /Claude hit its usage limit, so this continues on ChatGPT/.test(afterLimit?.options.preamble ?? "") && writerCalls.at(-1)?.provider === "chatgpt", writerCalls.at(-1)?.provider);

limits.clear("claude");
settings.patch({ tasks: { switchProviders: false } });
const waiting = tasks.create({ agentId: dana.id, goal: "Waits for the reset" });
scripts.set(waiting.id, async (t) => {
  if (t.index === 0) {
    t.tool("computer_exec");
    t.limit("claude");
    return;
  }
  tasks.finish(t.id, "done", "Done after the reset.");
});
await until(() => status(waiting.id) === "paused");
const pausedTask = taskStore.get(waiting.id)!;
check(
  "switching off → paused until the reset",
  pausedTask.task.status === "paused" && pausedTask.task.resumeAt === limits.until("claude") && /Claude is at its usage limit until/.test(pausedTask.task.progress ?? ""),
  pausedTask.task.progress ?? "",
);
// The reset comes (sooner here); a restart re-arms the timer from the saved time.
limits.clear("claude");
taskStore.patch(waiting.id, { resumeAt: Date.now() + 200 });
taskFailover.stop();
taskFailover.start();
await until(() => status(waiting.id) === "done", 4000);
check("…and resumes by itself at the reset time", status(waiting.id) === "done" && taskStore.get(waiting.id)!.task.resumeAt === null);
settings.patch({ tasks: { switchProviders: true } });

limits.clear("claude");
limits.mark("chatgpt", "limit");
const noEscape = tasks.create({ agentId: dana.id, goal: "Both limited" });
scripts.set(noEscape.id, async (t) => {
  t.tool("computer_exec");
  t.limit("claude");
});
await until(() => status(noEscape.id) === "paused");
check("both providers limited → pause", status(noEscape.id) === "paused" && sentTo(noEscape.id).length === 1);
limits.clear("claude");
limits.clear("chatgpt");
await request("POST", `/tasks/${noEscape.id}/stop`);

// =============================================================================
// M5: fan-out and fan-in — "Compare Linear, Jira and Height for a 10-person team"
// =============================================================================
const compareChat = conversations.create({ agentId: dana.id, modelId: "auto", title: "Trackers" });
const finishOrder: string[] = [];
const researcher = (name: string, delay: number): [RegExp, Script] => [
  new RegExp(`^Research ${name}`),
  async (t) => {
    await sleep(delay);
    t.tool("web_search");
    finishOrder.push(name);
    tasks.finish(
      t.id,
      "done",
      `${name} suits a 10-person team.`,
      toResult(`${name} suits a 10-person team.`, { findings: [`${name}: good fit`], sources: [`https://${name.toLowerCase()}.example/pricing`], confidence: "medium" }),
    );
  },
];
byGoal.push(researcher("Linear", 300), researcher("Jira", 50), researcher("Height", 150));
let writerTurns = 0;
scripts.set(compareChat.id, async (t) => {
  writerTurns++;
  t.say("Linear fits best; Jira is heavier; Height is lighter. Sources: linear.example, jira.example, height.example.");
});
// What the chat's model does with task_spawn_many: three researchers, combined by one writer turn.
spawnMany(
  compareChat.id,
  ["Linear", "Jira", "Height"].map((name) => ({ title: `Research ${name}`, goal: `Research ${name} for a 10-person team`, role: "researcher" as const })),
  { then: "synthesize", cards: { kind: "reply" } },
);
const children = conversations.tasks({ parentId: compareChat.id });
check("three research tasks, one group", children.length === 3 && new Set(children.map((c) => c.task!.group)).size === 1 && children.every((c) => c.task!.role === "researcher"));
await until(() => writerTurns === 1 && !runRegistry.activeFor(compareChat.id), 6000);
await sleep(200);
const writerTurn = sentTo(compareChat.id).at(-1);
check("fan-in waits for the last one", finishOrder.join(",") === "Jira,Height,Linear" && writerTurns === 1, finishOrder.join(","));
check(
  "one writer turn with all three results (structured, with sources)",
  writerTurn?.options.auto === true &&
    writerTurn.options.tier === "standard" &&
    ["Linear", "Jira", "Height"].every((name) => writerTurn.options.preamble!.includes(`https://${name.toLowerCase()}.example/pricing`)),
  writerTurn?.options.preamble?.slice(0, 200),
);
const combined = messages.listByConversation(compareChat.id).findLast((m) => m.role === "assistant");
check("the parent gets one combined answer", combined?.parts.some((p) => p.type === "text" && p.text.startsWith("Linear fits best")) === true);
check("results aren't repeated on the chat's next turn", conversations.get(compareChat.id)!.childResults.length === 0, JSON.stringify(conversations.get(compareChat.id)!.childResults));
check("the group is combined once", conversations.tasks({ parentId: compareChat.id }).every((c) => c.task!.then === null));

// A task that fans out waits for its children, then hears their results on its next turn.
const lead = tasks.create({ agentId: dana.id, goal: "Lead a two-part job" });
byGoal.push([
  /^Part (A|B) of the job/,
  async (t) => {
    t.tool("computer_exec");
    tasks.finish(t.id, "done", `${t.text.slice(0, 6)} finished.`);
  },
]);
scripts.set(lead.id, async (t) => {
  if (t.index === 0) {
    spawnMany(t.id, [{ goal: "Part A of the job" }, { goal: "Part B of the job" }], { cards: { kind: "reply" } });
    t.tool("task_spawn_many");
    return;
  }
  tasks.finish(t.id, "done", "Both parts done.");
});
await until(() => status(lead.id) === "done", 6000);
const leadChildren = conversations.tasks({ parentId: lead.id });
check("a task waits for its own tasks", status(lead.id) === "done" && leadChildren.every((c) => c.task!.status === "done" && c.task!.depth === 2) && sentTo(lead.id).length === 2);


server.close();
stopAutoHandoffs();
fanIn.stop();
taskFailover.stop();
await until(() => runLoop.count() === 0);
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
