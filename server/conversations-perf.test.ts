// Loading and switching chats fast: clipped tool calls (?clip=1) and the whole-part route, the slim chat list
// (?slim=1), ETags on a chat, a running chat's snapshot and ?after= on its events, and streaming saves.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/conversations-perf.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { randomUUID } from "node:crypto";
import type { Conversation, ConversationDetail, Message, MessagePart } from "../shared/types.ts";

process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test

const { createApp } = await import("./app.ts");
const { agents } = await import("./data/agents.ts");
const { conversations, toPublicConversation } = await import("./data/conversations.ts");
const { messages } = await import("./data/messages.ts");
const { CLIP_CHARS } = await import("./data/clip.ts");
const app = createApp();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 200)}` : ""}`);
}

/** From this computer (loopback), as the Mac app and the local web app call it. */
const send = (path: string, headers: Record<string, string> = {}, from = "127.0.0.1") =>
  app.request(
    `http://127.0.0.1:8787/api${path}`,
    { headers: { host: "127.0.0.1:8787", ...headers } },
    { incoming: { socket: { remoteAddress: from, remotePort: 50000, remoteFamily: "IPv4" } } },
  );
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

// --- A heavy chat: 150 tool calls with 20 KB outputs, a few long inputs, a screenshot, an exposed port ---

const agent = agents.first();
const chat = conversations.create({ agentId: agent.id, modelId: "auto", title: "Heavy chat" });
const big = (label: string, size: number) => `${label} `.repeat(Math.ceil(size / (label.length + 1))).slice(0, size);
const SCREENSHOT = "http://127.0.0.1:8787/api/agents/a/computer/screens/shot-1.png";
const PORT_URL = "https://preview-1234.example.dev/";

function toolParts(count: number): MessagePart[] {
  const parts: MessagePart[] = [];
  for (let i = 0; i < count; i++) {
    parts.push({
      type: "tool",
      id: `tool-${i}`,
      name: i % 3 === 0 ? "computer_exec" : i % 3 === 1 ? "computer_read_file" : "apps/execute",
      title: `Step ${i}`,
      input: i % 3 === 0 ? { command: `npm test -- ${i}` } : i % 3 === 1 ? { path: `/src/file-${i}.ts` } : { code: big("tools.gmail.send()", 6000) },
      output: big(`output-${i}`, 20_000),
      status: "done",
    });
  }
  return parts;
}

const userMessage: Message = {
  id: randomUUID(),
  conversationId: chat.id,
  role: "user",
  parts: [{ type: "text", id: "u1", text: "Do the heavy thing." }],
  status: "complete",
  createdAt: Date.now() - 10_000,
};
const reply: Message = {
  id: randomUUID(),
  conversationId: chat.id,
  role: "assistant",
  parts: [
    { type: "text", id: "t1", text: "Working on it." },
    ...toolParts(150),
    { type: "tool", id: "shot", name: "computer_screenshot", status: "done", input: {}, output: `${big("pixels", 3000)}\nscreenshot: ${SCREENSHOT}` },
    { type: "tool", id: "port", name: "computer_expose_port", status: "done", input: { port: 3000 }, output: `${big("log", 1990)} ${PORT_URL} more` },
    { type: "tool", id: "memo", name: "memory_save", status: "done", input: { content: big("remember", 2600) }, output: "Saved." },
    { type: "text", id: "t2", text: "Done." },
  ],
  status: "complete",
  provider: "claude",
  model: "claude-opus-5-5",
  createdAt: Date.now() - 5000,
};
messages.insert(userMessage);
messages.insert(reply);

// --- 1. Clipped tool calls ---

const oldBody = JSON.stringify({
  conversation: toPublicConversation(conversations.get(chat.id)!),
  messages: messages.listByConversation(chat.id),
  activeRunId: null,
} satisfies ConversationDetail);
let res = await send(`/conversations/${chat.id}`);
const plainText = await res.text();
check("without clip=1 the chat comes exactly as before", res.status === 200 && plainText === oldBody, `${plainText.length} vs ${oldBody.length}`);

res = await send(`/conversations/${chat.id}?clip=1`);
const clippedText = await res.text();
const clipped = JSON.parse(clippedText) as ConversationDetail;
console.log(`      detail: ${kb(plainText.length)} whole, ${kb(clippedText.length)} with clip=1`);
check("clip=1 cuts a heavy chat to a fraction", clippedText.length * 5 < plainText.length, `${clippedText.length} vs ${plainText.length}`);
const tools = clipped.messages[1].parts.filter((p): p is Extract<MessagePart, { type: "tool" }> => p.type === "tool");
const first = tools.find((p) => p.id === "tool-0")!;
check(
  "a clipped call keeps its title, name and status, the start of its output, and its sizes",
  first.clipped === true && first.title === "Step 0" && first.name === "computer_exec" && first.status === "done" &&
    first.output!.length === CLIP_CHARS && first.outputChars === 20_000 && first.inputChars === undefined,
  JSON.stringify({ ...first, output: first.output?.length }),
);
check("a short input stays whole (titles read it)", (first.input as { command: string }).command === "npm test -- 0" && (tools[1].input as { path: string }).path === "/src/file-1.ts");
const code = tools.find((p) => p.id === "tool-2")!;
check(
  "a long input string is cut, and its size kept",
  (code.input as { code: string }).code.length === CLIP_CHARS && code.inputChars === JSON.stringify({ code: big("tools.gmail.send()", 6000) }).length,
  String(code.inputChars),
);
const shot = tools.find((p) => p.id === "shot")!;
check("a screenshot's link survives the cut", shot.clipped === true && shot.output!.endsWith(SCREENSHOT) && shot.output!.length < 3000, shot.output!.slice(-80));
const port = tools.find((p) => p.id === "port")!;
check("a link cut in half is kept whole", port.output!.endsWith(PORT_URL), port.output!.slice(-60));
const memo = tools.find((p) => p.id === "memo")!;
check("a memory step stays whole (its pill shows the whole note)", !memo.clipped && (memo.input as { content: string }).content.length === 2600);
check("text parts and user messages aren't touched", clipped.messages[0].parts[0].type === "text" && clipped.messages[1].parts[0].type === "text" && clipped.messages[1].parts.at(-1)!.type === "text");

res = await send(`/conversations/${chat.id}/messages/${reply.id}/parts/tool-0`);
const whole = (await res.json()) as MessagePart;
check("the whole-part route returns the call whole", res.status === 200 && whole.type === "tool" && whole.output!.length === 20_000 && !whole.clipped);
res = await send(`/conversations/${chat.id}/messages/${reply.id}/parts/tool-2`);
const wholeCode = (await res.json()) as Extract<MessagePart, { type: "tool" }>;
check("…with its whole input", (wholeCode.input as { code: string }).code.length === 6000);
res = await send(`/conversations/${chat.id}/messages/${reply.id}/parts/nope`);
check("an unknown part is a 404", res.status === 404);
const other = conversations.create({ agentId: agent.id, modelId: "auto" });
res = await send(`/conversations/${other.id}/messages/${reply.id}/parts/tool-0`);
check("a part is only read through its own chat", res.status === 404);
const evil = { host: "tot.evil.example" };
const refused = [(await send(`/conversations/${chat.id}?clip=1`, evil)).status, (await send(`/conversations/${chat.id}/messages/${reply.id}/parts/tool-0`, evil)).status];
check("the whole-part route is guarded like the chat (a foreign Host is refused by both)", refused.every((status) => status === 403), refused.join());

// --- 2. The slim chat list ---

const { ORCHESTRATION_DEFAULTS } = await import("./data/conversations.ts");
const { computers } = await import("./data/computers.ts");
computers.create({ agentId: agent.id, kind: "local", state: "running", label: "This Mac" });
const findings = Array.from({ length: 12 }, (_, i) => `Finding ${i}: ${big("detail", 300)}`);
const task = conversations.create({
  agentId: agent.id,
  modelId: "auto",
  title: "Research task",
  kind: "task",
  parentId: chat.id,
  task: {
    ...ORCHESTRATION_DEFAULTS,
    goal: "Find out",
    status: "done",
    progress: "Wrapping up",
    plan: [{ text: "Look", done: true }],
    question: null,
    repo: null,
    queuePosition: null,
    startedAt: 1,
    finishedAt: 2,
    summary: big("summary", 3000),
    turns: 3,
    usage: { inputTokens: 10, outputTokens: 20 },
    brief: { goal: "Find out what's slow", constraints: [big("constraint", 800)], context: [big("context", 800)], done: big("done", 400) },
    result: { summary: big("result", 2000), findings, filesChanged: ["a.ts", "b.ts"], openQuestions: [big("question", 600)], confidence: "high", sources: ["https://a.example", "https://b.example"] },
    handoff: {
      goal: "Find out",
      doneSoFar: [big("did", 1500)],
      decisions: [],
      plan: [],
      files: [],
      tests: [],
      openQuestions: [],
      nextStep: "Ship",
      from: { provider: "claude", model: "claude-opus-5-5" },
      createdAt: 3,
    },
  },
});
conversations.update(chat.id, { systemPrompt: big("prompt", 20_000), childResults: [big("child", 4000)], mergeNotes: [{ forkId: "f", note: big("note", 4000), at: 1 }] });

res = await send("/conversations");
const fullListText = await res.text();
const fullList = JSON.parse(fullListText) as Conversation[];
res = await send("/conversations?slim=1");
const slimText = await res.text();
const slimList = JSON.parse(slimText) as Conversation[];
console.log(`      list: ${kb(fullListText.length)} whole, ${kb(slimText.length)} with slim=1`);
check(
  "without slim=1 the list comes exactly as before",
  fullListText === JSON.stringify(conversations.list().map((c) => c)) && fullList.find((c) => c.id === task.id)!.task!.handoff !== null,
);
const slimTask = slimList.find((c) => c.id === task.id)!.task!;
const wholeTask = fullList.find((c) => c.id === task.id)!.task!;
check("slim=1 marks tasks partial", slimTask.partial === true && wholeTask.partial === undefined);
check(
  "a slim task keeps its state, brief goal, result summary, first three findings and sources",
  slimTask.status === "done" && slimTask.goal === "Find out" && slimTask.progress === "Wrapping up" && slimTask.plan.length === 1 &&
    slimTask.summary === wholeTask.summary && slimTask.brief?.goal === "Find out what's slow" &&
    slimTask.result?.summary === wholeTask.result?.summary && slimTask.result?.findings.length === 3 &&
    slimTask.result?.findings[0] === findings[0] && slimTask.result?.sources.length === 2 && slimTask.result.confidence === "high",
);
check(
  "…and drops the rest of the brief, the result and the handoff",
  slimTask.brief?.constraints.length === 0 && slimTask.brief.context.length === 0 && slimTask.result?.openQuestions.length === 0 &&
    slimTask.result.filesChanged.length === 0 && slimTask.handoff === null,
);
check("a chat that isn't a task comes the same either way", JSON.stringify(slimList.find((c) => c.id === chat.id)) === JSON.stringify(fullList.find((c) => c.id === chat.id)));
check("every chat in the list has its agent's computer", slimList.every((c) => c.computer?.label === "This Mac") && fullList.every((c) => c.computer?.label === "This Mac"));
check("slim=1 keeps the order and the agent filter", JSON.stringify(slimList.map((c) => c.id)) === JSON.stringify(fullList.map((c) => c.id)) &&
  ((await (await send(`/conversations?slim=1&agentId=${agent.id}`)).json()) as Conversation[]).length === slimList.length);
check("slim=1 cuts the list", slimText.length < fullListText.length * 0.6, `${slimText.length} vs ${fullListText.length}`);
check("the server's own record still has the prompt and notes (only the list skips them)", conversations.get(chat.id)!.systemPrompt!.length === 20_000);

// --- 3. ETags: an unchanged chat is a 304 ---

res = await send(`/conversations/${chat.id}?clip=1`);
const etag = res.headers.get("etag")!;
await res.arrayBuffer();
check("a chat comes with an ETag and no-cache", Boolean(etag) && res.headers.get("cache-control") === "no-cache", String(etag));
res = await send(`/conversations/${chat.id}?clip=1`, { "if-none-match": etag });
check("If-None-Match with it: 304, no body", res.status === 304 && (await res.text()) === "" && res.headers.get("etag") === etag);
res = await send(`/conversations/${chat.id}?clip=1`, { "if-none-match": `W/${etag}, "other"` });
check("a weak copy of it in a list matches too", res.status === 304);
res = await send(`/conversations/${chat.id}`, { "if-none-match": etag });
check("the whole (unclipped) chat has its own ETag", res.status === 200 && res.headers.get("etag") !== etag);
await res.arrayBuffer();

// An approval going from pending to expired keeps every length the same: the write itself must change the ETag.
const ask: Message = {
  id: randomUUID(),
  conversationId: chat.id,
  role: "assistant",
  parts: [{ type: "approval", id: "ask", source: "Apps", message: "Send it?", kind: "confirm", status: "pending", expiresAt: 1 }],
  status: "complete",
  createdAt: Date.now(),
};
messages.insert(ask);
res = await send(`/conversations/${chat.id}?clip=1`);
const withAsk = res.headers.get("etag")!;
await res.arrayBuffer();
check("a new message changes the ETag", withAsk !== etag);
messages.save({ ...ask, parts: [{ ...(ask.parts[0] as Extract<MessagePart, { type: "approval" }>), status: "expired" }] });
res = await send(`/conversations/${chat.id}?clip=1`, { "if-none-match": withAsk });
const afterExpiry = (await res.json()) as ConversationDetail;
check(
  "a same-length edit still changes it (200 with the edit)",
  res.status === 200 && res.headers.get("etag") !== withAsk && afterExpiry.messages.at(-1)!.parts[0].type === "approval" &&
    (afterExpiry.messages.at(-1)!.parts[0] as { status: string }).status === "expired",
);
const beforeRename = res.headers.get("etag")!;
conversations.update(chat.id, { title: "Renamed" });
res = await send(`/conversations/${chat.id}?clip=1`, { "if-none-match": beforeRename });
check("a change to the chat itself (its title) changes it too", res.status === 200 && ((await res.json()) as ConversationDetail).conversation.title === "Renamed");

// --- 4. A running chat: its reply as it is now, and its events from there ---

const { runRegistry } = await import("./agent/runs.ts");
const live: Message = {
  id: randomUUID(),
  conversationId: chat.id,
  role: "assistant",
  parts: [],
  status: "streaming",
  provider: "claude",
  model: "claude-opus-5-5",
  createdAt: Date.now() + 1000,
};
messages.insert(live);
const run = runRegistry.create(chat.id, live.id);
run.reply = () => live;
run.push({ type: "run-start", runId: run.id, conversationId: chat.id, messageId: live.id, provider: "claude", model: "claude-opus-5-5" });
const doneTool: MessagePart = { type: "tool", id: "live-tool", name: "computer_exec", input: { command: "ls" }, output: big("listing", 9000), status: "done" };
const runningTool: MessagePart = { type: "tool", id: "live-run", name: "computer_exec", input: { command: "npm test" }, output: big("partial", 5000), status: "running" };
live.parts.push({ type: "text", id: "live-text", text: "Looking" });
run.push({ type: "part-start", part: { type: "text", id: "live-text", text: "Looking" } });
live.parts.push(doneTool, runningTool);
run.push({ type: "part-start", part: doneTool });
run.push({ type: "part-start", part: runningTool });
// The last save is behind: the snapshot must be the reply as it is now.
res = await send(`/conversations/${chat.id}?clip=1`);
const running = (await res.json()) as ConversationDetail;
const snapshot = running.messages.find((m) => m.id === live.id)!;
check("a running chat names its run, its reply and how far the reply got", running.activeRunId === run.id && running.activeMessageId === live.id && running.activeRunSeq === 4, JSON.stringify({ seq: running.activeRunSeq }));
check("the reply comes as it is now, once", snapshot.parts.length === 3 && running.messages.filter((m) => m.id === live.id).length === 1);
const snapTools = snapshot.parts.filter((p): p is Extract<MessagePart, { type: "tool" }> => p.type === "tool");
check("its finished tool calls are clipped, the running one isn't", snapTools[0].clipped === true && !snapTools[1].clipped && snapTools[1].output!.length === 5000);
res = await send(`/conversations/${chat.id}/messages/${live.id}/parts/live-tool`);
check("a clipped call of the running reply is read whole from the run", ((await res.json()) as { output: string }).output.length === 9000);
res = await send(`/conversations/${chat.id}`);
const plainRunning = (await res.json()) as ConversationDetail;
check("without clip=1 a running chat comes as before (no snapshot fields, the stored copy)", plainRunning.activeRunId === run.id && plainRunning.activeRunSeq === undefined && plainRunning.activeMessageId === undefined && plainRunning.messages.find((m) => m.id === live.id)!.parts.length === 0);

/** The events of a run stream: ids and types, until run-end. */
async function readEvents(response: Response): Promise<{ id: number; type: string }[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes('"run-end"')) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return text
    .split("\n\n")
    .map((block) => ({ id: Number(/^id: (\d+)/m.exec(block)?.[1] ?? 0), data: /^data: (.+)$/m.exec(block)?.[1] }))
    .filter((e) => e.id && e.data)
    .map((e) => ({ id: e.id, type: (JSON.parse(e.data!) as { type: string }).type }));
}
const streamed = send(`/runs/${run.id}/events?after=${running.activeRunSeq}`);
const delta = { type: "part-delta" as const, partId: "live-text", delta: " around" };
run.push(delta);
const final = { ...live, status: "complete" as const };
run.push({ type: "run-end", status: "complete", message: final });
runRegistry.finish(run);
const after = await readEvents(await streamed);
check("?after= starts past the snapshot", after.length === 2 && after[0].id === 5 && after[0].type === "part-delta" && after[1].type === "run-end", JSON.stringify(after));
const replay = await readEvents(await send(`/runs/${run.id}/events`));
check("without it the run replays from the start, as before", replay.length === 6 && replay[0].type === "run-start");
const both = await readEvents(await send(`/runs/${run.id}/events?after=2`, { "last-event-id": "5" }));
check("on a reconnect Last-Event-ID wins over a smaller ?after=", both.length === 1 && both[0].id === 6);
res = await send(`/runs/${run.id}/events?after=6`);
check("a finished run already delivered past ?after= is a 204", res.status === 204);

// --- 5. Streaming saves: rarer as the reply grows, only after changes, the final one always ---

const { ReplySaver, SAVE_INTERVAL_MS } = await import("./agent/reply-saver.ts");
{
  let clock = 0;
  let pending: { run: () => void; at: number } | null = null;
  const sizes: number[] = [];
  let size = 1000;
  const saver = new ReplySaver(
    () => {
      sizes.push(size);
      return size;
    },
    () => clock,
    (run, ms) => {
      pending = { run, at: clock + ms };
      return () => (pending = null);
    },
  );
  const tick = (ms: number) => {
    clock += ms;
    if (pending && pending.at <= clock) {
      const due = pending;
      pending = null;
      due.run();
    }
  };
  saver.changed();
  check("the first change is saved at once", sizes.length === 1);
  for (let i = 0; i < 50; i++) {
    tick(10);
    saver.changed();
  }
  check("changes within the interval aren't saved one by one", sizes.length === 1 && pending !== null, String(sizes.length));
  tick(SAVE_INTERVAL_MS);
  check("…but once the wait is up (a trailing save)", sizes.length === 2);
  tick(5000);
  check("no change, no save", sizes.length === 2);
  size = 1_000_000;
  saver.changed();
  check("a change after a quiet spell is saved at once", sizes.length === 3);
  check("a 1 MB reply waits 4 s between saves", saver.interval === 4000, String(saver.interval));
  tick(1500);
  saver.changed();
  tick(1500);
  check("…so a change 1.5 s later waits", sizes.length === 3);
  tick(1000);
  check("…and is saved 4 s after the last save", sizes.length === 4);
  saver.saveNow();
  check("saveNow saves at once, whatever the wait", sizes.length === 5);
  saver.changed();
  saver.stop();
  tick(10_000);
  saver.changed();
  saver.saveNow();
  check("after stop nothing is saved (the turn's final save follows)", sizes.length === 5 && pending === null);
}

// A real turn through a fake provider: many quick events, a pause with a tool running, then the end.
{
  const { settings } = await import("./data/settings.ts");
  const { providers } = await import("./agent/providers/index.ts");
  const { sendMessage } = await import("./agent/orchestrator.ts");
  const { runEnd } = await import("./tasks/run-loop.ts");
  settings.patch({ computer: { mode: "local" }, memory: { enabled: false } });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let midTurn: Message | null = null;
  let replyId = "";
  providers.claude = {
    id: "claude",
    label: "Claude",
    status: async () => ({ id: "claude", label: "Claude", installed: true, loggedIn: true, models: [{ id: "claude:claude-opus-5-5", provider: "claude", model: "claude-opus-5-5", label: "Opus", available: true }] }),
    async *runTurn(input) {
      yield { type: "session", sessionId: input.sessionId ?? "s-1" };
      for (let i = 0; i < 200; i++) yield { type: "text-delta", blockId: "b1", delta: `word${i} ` };
      yield { type: "tool-start", toolCallId: "c1", name: "computer_exec", input: { command: "npm test" } };
      // A long-running tool: the trailing save lands while nothing else happens.
      await sleep(SAVE_INTERVAL_MS + 400);
      midTurn = messages.get(replyId);
      yield { type: "tool-end", toolCallId: "c1", output: "ok" };
      yield { type: "text-delta", blockId: "b2", delta: "Done." };
    },
    complete: async () => "A title",
  } as typeof providers.claude;
  const turnChat = conversations.create({ agentId: agent.id, modelId: "auto" });
  const realSave = messages.save;
  let saves = 0;
  messages.save = (message: Message) => {
    if (message.conversationId === turnChat.id) saves++;
    return realSave(message);
  };
  const started = await sendMessage(turnChat.id, { text: "Go" });
  replyId = runRegistry.get(started.runId)!.messageId;
  const ended = await runEnd(started.runId);
  messages.save = realSave;
  const saved = messages.get(replyId)!;
  const mid = midTurn as Message | null;
  check(
    "a turn of 200+ quick events is saved a handful of times",
    saves >= 3 && saves <= 6 && ended?.status === "complete",
    `${saves} saves, ${ended?.status}`,
  );
  check(
    "the quiet spell's changes were saved before the turn ended (trailing save)",
    mid?.parts.some((p) => p.type === "tool" && p.status === "running") === true && mid.parts.some((p) => p.type === "text" && p.text.includes("word199")),
    JSON.stringify(mid?.parts.map((p) => p.type)),
  );
  check(
    "the final save always runs, whole",
    saved.status === "complete" && saved.parts.some((p) => p.type === "text" && p.text === "Done.") && saved.parts.some((p) => p.type === "tool" && p.status === "done" && p.output === "ok"),
  );
}

// --- 6. SQLite settings ---

const { db, statement } = await import("./db.ts");
const pragma = (name: string) => Object.values(db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];
check(
  "WAL with synchronous NORMAL, a 32 MB cache, a memory map, temp in memory, a capped WAL",
  pragma("journal_mode") === "wal" && pragma("synchronous") === 1 && pragma("cache_size") === -32000 && pragma("mmap_size") === 268435456 &&
    pragma("temp_store") === 2 && pragma("journal_size_limit") === 67108864,
  JSON.stringify(["journal_mode", "synchronous", "cache_size", "mmap_size", "temp_store", "journal_size_limit"].map(pragma)),
);
const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM conversations ORDER BY updated_at DESC`).all() as { detail: string }[]).map((r) => r.detail).join(" ");
check("the chat list reads an index on updated_at, not a sort", plan.includes("conversations_by_updated") && !plan.includes("TEMP B-TREE"), plan);
check("a hot statement is prepared once", statement("SELECT * FROM messages WHERE id = ?") === statement("SELECT * FROM messages WHERE id = ?"));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
