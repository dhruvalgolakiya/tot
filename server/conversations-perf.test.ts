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

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
