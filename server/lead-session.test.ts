// A lean, always-responsive Lead (roadmap module 12, lane C): past ~120k tokens of context its next turn starts a
// fresh provider session from the project's state (the board, signals, open cards, MEMORY.md and the Overview, its
// last few messages), built by a pure preamble builder; it never waits on tasks (`wait` is refused with a reason);
// and its prompt says what to do with each signal, the control tools, cards for landing and pushing, schedules and
// knowledge. Real turns through the orchestrator with fake providers, a real MCP client for the tools.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/lead-session.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { LeadSignal, Message, MessagePart, SendMessageRequest } from "../shared/types.ts";

// A temp home, set before anything reads it (a project's shared files live under ~/projects).
const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), "..", ".scratch");
mkdirSync(SCRATCH, { recursive: true });
const HOME = realpathSync.native(mkdtempSync(join(SCRATCH, "lead-session-home-")));
process.env.HOME = HOME;
process.on("exit", () => rmSync(HOME, { recursive: true, force: true }));
process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test
const PORT = 30_000 + Math.floor(Math.random() * 5000);

const { sendMessage } = await import("./agent/orchestrator.ts");
const { providers } = await import("./agent/providers/index.ts");
const { createApp } = await import("./app.ts");
const { MCP_TOKEN } = await import("./config.ts");
const { agents } = await import("./data/agents.ts");
const { conversations } = await import("./data/conversations.ts");
const { messages } = await import("./data/messages.ts");
const { queueHolds } = await import("./data/queue-holds.ts");
const { settings } = await import("./data/settings.ts");
const { wiki } = await import("./data/wiki.ts");
const { db } = await import("./db.ts");
const { leads } = await import("./lead/lead.ts");
const { LEAD_NO_WAIT, leadNote, leadSection } = await import("./lead/prompt.ts");
const { LEAD_FRESH_TOKENS, lastTurnContext, leadPreamble, leadSession, openCards, recentSignals } = await import("./lead/session.ts");
const { remember } = await import("./memory/memory.ts");
const { projectRepoId } = await import("./memory/repo.ts");
const { projects } = await import("./projects/projects.ts");
const { runEnd } = await import("./tasks/run-loop.ts");
const { tasks } = await import("./tasks/tasks.ts");
type LeadState = import("./lead/session.ts").LeadState;
type TurnInput = import("./agent/providers/types.ts").TurnInput;
type AgentProvider = import("./agent/providers/types.ts").AgentProvider;
type TurnOptions = import("./agent/orchestrator.ts").TurnOptions;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 300)}` : ""}`);
}
const mascot = { shape: "blob" as const, color: "#60a5fa", accessory: "none" as const, eyes: "dots" as const };
const before = (text: string, a: string, b: string) => text.includes(a) && text.includes(b) && text.indexOf(a) < text.indexOf(b);

settings.patch({ computer: { mode: "local" } });

// --- Fake providers behind the real turn pipeline, recording each turn's input ---------------------------------------
const providerTurns: TurnInput[] = [];
/** What the next turn reports: its input tokens (summed over its model calls, as providers do) and its tool calls. */
let nextUsage = { inputTokens: 9_000, tools: 0 };
function fakeProvider(id: "claude" | "chatgpt", label: string, models: string[]): AgentProvider {
  return {
    id,
    label,
    status: async () => ({ id, label, installed: true, loggedIn: true, models: models.map((model) => ({ id: `${id}:${model}`, provider: id, model, label: model, available: true })) }),
    async *runTurn(input) {
      providerTurns.push(input);
      yield { type: "session", sessionId: input.sessionId ?? `${id}-session-${randomUUID().slice(0, 8)}` };
      for (let i = 0; i < nextUsage.tools; i++) {
        const toolCallId = `tool-${randomUUID().slice(0, 8)}`;
        yield { type: "tool-start", toolCallId, name: "mission_overview", input: {} };
        yield { type: "tool-end", toolCallId, output: "The board." };
      }
      yield { type: "text-delta", blockId: "b1", delta: `Reply from ${label}.` };
      yield { type: "usage", usage: { inputTokens: nextUsage.inputTokens, outputTokens: 50 } };
      nextUsage = { inputTokens: 9_000, tools: 0 };
    },
    complete: async () => "A title",
  };
}
providers.claude = fakeProvider("claude", "Claude", ["claude-opus-5-5", "claude-sonnet-5-5"]);
providers.chatgpt = fakeProvider("chatgpt", "ChatGPT", ["gpt-6.1-sol", "gpt-6-sol"]);

/** One real turn (through sendMessage) to its end: what the provider was given, and the reply. */
async function turn(chatId: string, text: string, options: TurnOptions = {}): Promise<{ input: TurnInput; reply: Message }> {
  const body: SendMessageRequest = { text };
  const { runId } = await sendMessage(chatId, body, options);
  const end = await runEnd(runId);
  return { input: providerTurns.at(-1)!, reply: end!.message };
}

// =============================================================================
// The preamble: a pure builder
// =============================================================================
console.log("\n# The fresh session's preamble");
const NOW = Date.UTC(2026, 9, 7, 12, 0);
const MIN = 60_000;
let seq = 0;
function message(role: "user" | "assistant", text: string, extra: Partial<Message> = {}): Message {
  seq++;
  return { id: `m${seq}`, conversationId: "lead-1", role, parts: text ? [{ type: "text", id: `p${seq}`, text }] : [], status: "complete", createdAt: NOW - 100 * MIN + seq, ...extra };
}
const noticeOnly = (text: string): Message =>
  message("assistant", "", { parts: [{ type: "notice", id: `n${seq}`, kind: "info", text }] });
function signal(input: Partial<LeadSignal> & Pick<LeadSignal, "id" | "kind" | "title" | "at">): LeadSignal {
  return { projectId: "p1", detail: null, url: null, repoName: null, taskId: null, prNumber: null, readAt: null, ...input };
}
const state: LeadState = {
  projectName: "Shop",
  chatId: "lead-1",
  contextTokens: 134_400,
  board: "Project “Shop”. Repos:\n- web: GitHub acme/web · base: main\n\nWorking (1)\n- t1 · “Fix cart” · running · branch tot/fix-cart · started by you\n  now: fixing the lint errors",
  signals: [
    signal({ id: "s3", kind: "ci-failed", title: "Checks failed on draft PR #12 “Fix cart”", detail: "lint\ntest (unit)\nbuild", url: "https://github.com/acme/web/pull/12", repoName: "web", taskId: "t1", prNumber: 12, at: NOW - 12 * MIN }),
    signal({ id: "s2", kind: "ticket", title: "Slack #shop: “The checkout button is grey on mobile”", detail: "From Ana in #shop:\nThe checkout button is grey on mobile.", at: NOW - 3 * 60 * MIN }),
    signal({ id: "s1", kind: "ci-passed", title: "Checks passed on draft PR #11 “Add docs”", prNumber: 11, repoName: "web", at: NOW - 2 * 24 * 60 * MIN, readAt: NOW - 47 * 60 * MIN }),
  ],
  cards: [{ text: "Push 2 new commits to draft PR #12 “Fix cart”?", taskId: "t1", at: NOW - 3 * 60 * MIN }],
  memory: { repo: "projects/shop", content: "- Tests need TZ=UTC (k1a2)\n- Deploys go through Vercel (k3b4)" },
  overview: { summary: "What Shop is and where things are.", content: "Shop sells socks online.\n\n## Repos\n- web: the storefront (Next.js)" },
  history: [
    message("user", "Oldest message, which shouldn't make it"),
    message("assistant", "An old reply."),
    message("user", "Ship the cart fix, please."),
    message("assistant", "Started “Fix cart” on web; I'll propose landing it once its checks pass."),
    message("user", "“Fix cart” finished.", { auto: true }),
    message("assistant", `Proposed landing it. ${"Details of the change. ".repeat(120)}The end of a long reply.`),
    noticeOnly("Opened draft PR #12 for “Fix cart” against main, as you approved."),
  ],
  now: NOW,
};
const preamble = leadPreamble(state);
check(
  "it says why the session is fresh, how big the context was, and where older messages are",
  preamble.startsWith("[This turn starts a fresh session: your last turn ran with about 134k tokens of context") && preamble.includes(`chat_read { chatId: "lead-1" }`),
  preamble.slice(0, 200),
);
check(
  "the project's state, in order: board, signals, cards, knowledge, last messages",
  preamble.includes(`<project_state project="Shop">`) &&
    before(preamble, "<board>", "<signals>") &&
    before(preamble, "<signals>", "<cards>") &&
    before(preamble, "<cards>", "<knowledge>") &&
    before(preamble, "<knowledge>", "<last_messages>") &&
    preamble.trimEnd().endsWith("</project_state>"),
);
check("the board as mission_overview says it", preamble.includes(state.board));
check(
  "new signals are only counted: this turn's own note lists them (no doubling)",
  preamble.includes("New (2): listed in this turn's note, after this state.") && !preamble.includes("lint / test (unit) / build"),
  preamble,
);
check(
  "…then the recent ones already seen (and a PR number not in the title is named)",
  preamble.includes("Earlier, already seen (1):\n- ci-passed · 2 days ago · Checks passed on draft PR #11 “Add docs” · repo web") && !preamble.includes("PR #11 · "),
  preamble.slice(preamble.indexOf("Earlier"), preamble.indexOf("Earlier") + 200),
);
check("the cards still waiting for the user, not to be asked again", preamble.includes("Waiting for the user's answer; don't ask again:\n- Push 2 new commits to draft PR #12 “Fix cart”? (task t1, asked 3 h ago)"));
check(
  "the knowledge: the project's MEMORY.md, the Overview's summary and its start",
  preamble.includes("MEMORY.md (projects/shop):\n- Tests need TZ=UTC (k1a2)") && preamble.includes("Overview: What Shop is and where things are.\nShop sells socks online."),
);
const last = preamble.slice(preamble.indexOf("<last_messages>"));
check(
  "the last six messages, oldest first: the user's, TOT's own (a wake), replies, a notice",
  !last.includes("Oldest message") &&
    before(last, "<assistant>\nAn old reply.", "<user>\nShip the cart fix, please.") &&
    last.includes("<tot>\n“Fix cart” finished.\n</tot>") &&
    last.includes("<notice>\nOpened draft PR #12 for “Fix cart” against main, as you approved.\n</notice>"),
  last.slice(0, 400),
);
check("a long message is clipped, saying where the rest is", last.includes(`… [cut: chat_read { chatId: "lead-1" } for all of it]`) && !last.includes("The end of a long reply."));
const empty = leadPreamble({ ...state, board: "No tasks on the board.", signals: [], cards: [], memory: null, overview: null, history: [] });
check(
  "an empty project still reads cleanly",
  empty.includes("<signals>\nNone yet.\n</signals>") && empty.includes("<cards>\nNone.\n</cards>") && empty.includes("<knowledge>\nNothing yet.\n</knowledge>") && empty.includes("<last_messages>\nNone.\n</last_messages>"),
  empty,
);
const huge = leadPreamble({ ...state, board: "x".repeat(20_000), history: Array.from({ length: 12 }, (_, i) => message(i % 2 ? "assistant" : "user", `${i} ${"y".repeat(1400)}`)) });
check(
  "big boards and long chats stay bounded",
  huge.length < 18_000 && huge.includes("… (mission_overview for the rest)") && (huge.match(/<(user|assistant)>/g) ?? []).length <= 6,
  String(huge.length),
);
check("same state, same text (pure)", leadPreamble(state) === preamble);

// =============================================================================
// The rule: the context the last turn ran with
// =============================================================================
console.log("\n# When a Lead starts fresh");
const tool = (): MessagePart => ({ type: "tool", id: randomUUID(), name: "mission_overview", title: "Board", status: "done" });
const turnWith = (inputTokens: number, tools: number) => message("assistant", "ok", { usage: { inputTokens }, parts: [...Array.from({ length: tools }, tool), { type: "text", id: randomUUID(), text: "ok" }] });
check("no turn yet: nothing to go on", lastTurnContext([]) === null && lastTurnContext([message("user", "hi"), message("assistant", "hello")]) === null);
check("one model call: its input", lastTurnContext([turnWith(130_000, 0)]) === 130_000);
check("a turn's input is per model call: 600k over 5 calls (4 tool calls) is 120k", lastTurnContext([turnWith(600_000, 4)]) === 120_000);
check("notes posted after it (a card's answer) don't count as a turn", lastTurnContext([turnWith(130_000, 0), noticeOnly("Merged.")]) === 130_000);
check("the limit is ~120k", LEAD_FRESH_TOKENS === 120_000, String(LEAD_FRESH_TOKENS));

// =============================================================================
// Signals from lane A's table, read defensively
// =============================================================================
console.log("\n# Signals, read from lead_signals");
{
  const { leadSignals } = await import("./signals/store.ts");
  const added = leadSignals.add("p1", { kind: "ci-failed", title: "Checks failed on draft PR #3", detail: "lint", url: "https://example.com/3", repoName: "web", taskId: "t9", prNumber: 3 });
  leadSignals.add("p2", { kind: "pr-merged", title: "Another project's PR", detail: null, url: null, repoName: null, taskId: null, prNumber: null });
  const found = recentSignals("p1");
  check("signals come from lane A's store: this project's, newest first", found.length === 1 && found[0]!.id === added!.id && found[0]!.prNumber === 3 && found[0]!.readAt === null, JSON.stringify(found));
}

// =============================================================================
// Through the real turn pipeline
// =============================================================================
console.log("\n# A Lead's turns: resumed, then fresh past the limit, then resumed again");
const ivy = agents.create({ name: "Ivy", mascot });
queueHolds.set(ivy.id, null, "test"); // tasks stay queued: none starts by itself
const shop = projects.create({ kind: "none", name: "Shop" });
const { lead } = leads.open(shop.id, ivy.id);
await remember({ repo: projectRepoId(shop.slug), text: "Tests need TZ=UTC", source: "you", actor: "you" });
wiki.update(wiki.overview(shop.brainId).id, { summary: "What Shop is and where things are.", content: "Shop sells socks online." }, "agent");
const notesTask = tasks.create({ agentId: ivy.id, projectId: shop.id, goal: "Write the release notes" });

let t = await turn(lead.id, "Plan the spring sale.");
const firstSession = conversations.get(lead.id)!.providerSessionId;
check("the first turn starts a session as usual", !t.input.sessionId && Boolean(firstSession) && !t.input.prompt.includes("<project_state"), t.input.prompt.slice(0, 120));
nextUsage = { inputTokens: 200_000, tools: 4 };
t = await turn(lead.id, "Also check the docs task.");
check("a turn that read 200k over 5 model calls (40k each) is resumed next time", t.input.sessionId === firstSession);
t = await turn(lead.id, "And the newsletter?");
check("…it is", t.input.sessionId === firstSession && !t.input.prompt.includes("<project_state"), t.input.prompt.slice(0, 120));

// A card waiting for the user, as task_land leaves it (lead/asks.ts).
const cardId = `a_${randomUUID().slice(0, 12)}`;
const cardMessage: Message = {
  id: randomUUID(),
  conversationId: lead.id,
  role: "assistant",
  parts: [{ type: "approval", id: cardId, source: "Lead", message: "Merge “Write the release notes” into main? · +3 −0\nreason", kind: "confirm", status: "pending", expiresAt: Date.now() + 60 * MIN, lead: { action: "land", taskId: notesTask.id } }],
  status: "complete",
  createdAt: Date.now(),
};
messages.insert(cardMessage);
db.prepare(`INSERT INTO lead_asks (id, conversation_id, message_id, task_id, action, method, head_sha, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
  cardId,
  lead.id,
  cardMessage.id,
  notesTask.id,
  "land",
  "merge",
  "abc1234",
  Date.now(),
  Date.now() + 60 * MIN,
);
check("the open cards are read from lead_asks, as their card says", openCards(lead.id)[0]?.text === "Merge “Write the release notes” into main? · +3 −0", JSON.stringify(openCards(lead.id)));

nextUsage = { inputTokens: 750_000, tools: 4 }; // 150k a call: past the limit
t = await turn(lead.id, "Where are we with the sale?");
check("the turn past the limit is resumed itself (it doesn't know yet)", t.input.sessionId === firstSession);
const big = t.reply;
t = await turn(lead.id, "Start the banner task.");
const freshSession = conversations.get(lead.id)!.providerSessionId;
check("the next turn starts a fresh session: no resume, no fork", !t.input.sessionId && !t.input.fork && freshSession !== firstSession, `${t.input.sessionId} ${freshSession}`);
check(
  "…from the project's state: the board, the card, MEMORY.md, the Overview",
  t.input.prompt.includes(`<project_state project="Shop">`) &&
    t.input.prompt.includes("“Write the release notes” · queued") &&
    t.input.prompt.includes("Merge “Write the release notes” into main? · +3 −0 (task") &&
    t.input.prompt.includes("Tests need TZ=UTC") &&
    t.input.prompt.includes("Overview: What Shop is and where things are.\nShop sells socks online."),
  t.input.prompt.slice(0, 600),
);
check(
  "…its last messages, and then the user's new one",
  t.input.prompt.includes("<user>\nWhere are we with the sale?\n</user>") && t.input.prompt.includes("<assistant>\nReply from Claude.\n</assistant>") && t.input.prompt.trimEnd().endsWith("Start the banner task."),
  t.input.prompt.slice(-300),
);
check("…and the reply tells the user, quietly", t.reply.parts[0]?.type === "notice" && t.reply.parts[0].text === "Started a fresh session from the project's state: the conversation had reached about 150k tokens.", JSON.stringify(t.reply.parts[0]));
check("…the transcript itself isn't pasted in", !t.input.prompt.includes("Plan the spring sale.") && !t.input.prompt.includes("<conversation>"));
check("the system prompt is the Lead's, as before", t.input.systemPrompt.includes("# Lead of Shop") && t.input.systemPrompt.includes("Never wait on a task"));
t = await turn(lead.id, "Thanks.");
check("the turn after resumes the new session, without the state", t.input.sessionId === freshSession && !t.input.prompt.includes("<project_state"));
check("(the big turn's reply is untouched)", messages.get(big.id)?.usage?.inputTokens === 750_000);

console.log("\n# Wakes, other chats, and a state that can't be read");
nextUsage = { inputTokens: 130_000, tools: 0 };
await turn(lead.id, "One more.");
t = await turn(lead.id, "“Write the release notes” finished.", { auto: true, keepTitle: true, preamble: "WAKE NOTE: its result." });
check("a wake turn past the limit starts fresh too, the state before the wake's own note", !t.input.sessionId && before(t.input.prompt, "<project_state", "WAKE NOTE: its result."), t.input.prompt.slice(0, 160));
nextUsage = { inputTokens: 130_000, tools: 0 };
await turn(lead.id, "Again.");
t = await turn(lead.id, "Step two.", { freshSession: true, preamble: "JOB STATE" });
check("a caller's own fresh session (a multi-step job) gets no project state", !t.input.sessionId && !t.input.prompt.includes("<project_state") && t.input.prompt.includes("JOB STATE"));

const plain = conversations.create({ agentId: ivy.id, modelId: ivy.modelId, title: "Ivy's chat", projectId: shop.id });
nextUsage = { inputTokens: 500_000, tools: 0 };
await turn(plain.id, "Big question.");
const plainSession = conversations.get(plain.id)!.providerSessionId;
t = await turn(plain.id, "Follow-up.");
check("a plain chat in the project keeps resuming (Leads only)", t.input.sessionId === plainSession && !t.input.prompt.includes("<project_state"));

nextUsage = { inputTokens: 130_000, tools: 0 };
await turn(lead.id, "Before the break.");
const leadSessionBefore = conversations.get(lead.id)!.providerSessionId;
db.exec(`ALTER TABLE lead_asks RENAME TO lead_asks_away`);
const warn = console.warn;
console.warn = () => {};
const broken = leadSession.freshStart(conversations.get(lead.id)!, messages.listByConversation(lead.id));
t = await turn(lead.id, "Still there?");
console.warn = warn;
db.exec(`ALTER TABLE lead_asks_away RENAME TO lead_asks`);
check("the state can't be read: the turn resumes as before rather than starting blind", broken === null && t.input.sessionId === leadSessionBefore && t.reply.status === "complete");

// =============================================================================
// Never blocks: wait is refused for a Lead
// =============================================================================
console.log("\n# A Lead never waits on tasks");
const app = createApp();
const server = serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" });
const client = new Client({ name: "tot-lead-session-test", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp/${lead.id}`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } }));
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  return { isError: Boolean(result.isError), text: (result.content as { text?: string }[]).map((c) => c.text ?? "").join("\n") };
};
const count = () => conversations.inProject(shop.id).filter((c) => c.kind === "task").length;
const tasksBefore = count();
const started = Date.now();
let r = await call("task_start", { title: "Banner", goal: "Make the sale banner", wait: true, wait_minutes: 1 });
check("task_start with wait: refused at once, with the reason, nothing started", r.isError && r.text === LEAD_NO_WAIT && count() === tasksBefore && Date.now() - started < 5000, r.text);
check("…and the reason says to delegate and stay free", LEAD_NO_WAIT.startsWith("Nothing was started") && LEAD_NO_WAIT.includes("without `wait`") && LEAD_NO_WAIT.includes("stay free"));
r = await call("task_spawn_many", { sessions: [{ title: "A", goal: "Do A" }, { title: "B", goal: "Do B" }], wait: true });
check("task_spawn_many with wait: refused the same way", r.isError && r.text === LEAD_NO_WAIT && count() === tasksBefore, r.text);
r = await call("task_start", { title: "Banner", goal: "Make the sale banner" });
check("without wait it starts, and the Lead hears back later", !r.isError && r.text.includes("Started task") && r.text.includes("comes back when it finishes") && count() === tasksBefore + 1, r.text);
await client.close();

// =============================================================================
// The Lead's prompt (module 12)
// =============================================================================
console.log("\n# The Lead's prompt");
const section = leadSection(projects.get(shop.id)!);
check(
  "module 11's parts stay: the role, the knowledge, checking and landing with the user's OK",
  section.startsWith("# Lead of Shop\n<lead>") &&
    section.includes("You're this project's Lead") &&
    section.includes("This project has no repos (a topic project)") &&
    section.includes("Knowledge: the project's brain “Shop”") &&
    section.includes("task_update_from_base") &&
    section.includes("Landing needs the user's OK, every time: task_land") &&
    !section.includes("One task per repo"),
  section,
);
check("stay free: delegate, never wait", section.includes("Stay free: start the work") && section.includes("Never wait on a task (`wait` is refused for you)"));
check("the control tools", ["task_pause", "task_resume", "task_stop"].every((name) => section.includes(name)) && section.includes("These need no card"));
check("pushing a fix to a draft PR goes through the card too", section.includes("Pushing a fix to a task's open draft PR goes the same way: task_land on that task asks to push its new commits"));
check("nothing leaves without the OK", section.includes("Never merge, push, open or update pull requests, or post to GitHub, Slack or Linear, any other way."));
check(
  "what to do with each signal",
  [
    "- ci-failed: task_message the PR's task with the failing checks",
    "- changes-requested, review-comment, comment: hand the reviewer's points to the task",
    "- pr-conflict: task_message its task to merge its base branch in",
    "- ci-passed, pr-merged, pr-closed:",
    "- ticket: decide whether it's work for this project",
    "- schedule: one of the project's schedules",
  ].every((line) => section.includes(line)),
);
check("keeping the knowledge current, since the conversation goes on in fresh sessions", section.includes("memory_save (scope \"project\")") && section.includes("fresh session from the project's state") && section.includes("chat_read"));
const two = leadSection({
  ...projects.get(shop.id)!,
  repos: [
    { name: "web", kind: "github", source: "acme/web", defaultBranch: "main", folderGranted: true, primary: true },
    { name: "api", kind: "github", source: "acme/api", defaultBranch: "main", folderGranted: true, primary: false },
  ],
});
check("two repos: listed, one task per repo", two.includes("- web (primary): GitHub acme/web · base: main") && two.includes("One task per repo"));
const oldSection = "# Lead of Shop\n<lead>\nThe module 11 instructions.\n</lead>";
const swapped = leadNote({ lead: true }, projects.get(shop.id)!, `Base prompt.\n\n${oldSection}`);
check(
  "a Lead from before hears the new instructions once, and its prompt is swapped",
  Boolean(swapped.prompt?.includes(section)) && !swapped.prompt!.includes("module 11 instructions") && swapped.note.includes("this replaces the earlier ones"),
);
check("…not again", leadNote({ lead: true }, projects.get(shop.id)!, swapped.prompt!).prompt === null);

server.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
