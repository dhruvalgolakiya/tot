// Projects (roadmap module 06, M4): tickets and intake. Ticket links become a chat's origin and name
// its tasks' branches; Slack channels, Linear teams and a project's own GitHub issues file new chats
// (only when exactly one project matches, always with a notice); the agent files a chat that's in no
// project with chat_set_project. Fake providers, a fake Slack and a fake mail server; nothing real.
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Conversation, Message, MessagePart, Project, SendMessageRequest, SendMessageResponse } from "../shared/types.ts";
import type { MailConnection, MailTransport } from "./mail/transport.ts";

process.env.TOT_ACCESS_TOKEN = "";
const PORT = 8807;

const { sendMessage } = await import("./agent/orchestrator.ts");
const { MessageBuilder } = await import("./agent/message-builder.ts");
const { providers } = await import("./agent/providers/index.ts");
const { runRegistry } = await import("./agent/runs.ts");
const { MCP_TOKEN } = await import("./config.ts");
const { agents } = await import("./data/agents.ts");
const { conversations } = await import("./data/conversations.ts");
const { messages } = await import("./data/messages.ts");
const { personas } = await import("./data/personas.ts");
const { queueHolds } = await import("./data/queue-holds.ts");
const { settings } = await import("./data/settings.ts");
const { createApp } = await import("./app.ts");
const { mailboxes } = await import("./mail/mailbox.ts");
const { emailTasks } = await import("./mail/tasks.ts");
const { intake } = await import("./projects/intake.ts");
const { projects } = await import("./projects/projects.ts");
const { projectList } = await import("./projects/prompt.ts");
const { detectTicket } = await import("./projects/tickets.ts");
const { slack } = await import("./slack.ts");
const { runEnd } = await import("./tasks/run-loop.ts");
const { tasks } = await import("./tasks/tasks.ts");
const { planRepo } = await import("./tasks/worktree.ts");
type TurnInput = import("./agent/providers/types.ts").TurnInput;
type AgentProvider = import("./agent/providers/types.ts").AgentProvider;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 240)}` : ""}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 4000) {
  for (const end = Date.now() + ms; Date.now() < end && !condition(); ) await sleep(20);
}
const mascot = { shape: "blob" as const, color: "#60a5fa", accessory: "none" as const, eyes: "dots" as const };

settings.patch({ computer: { mode: "local" } });

// --- Fake providers: each turn is recorded, and may call TOT's tools mid-turn like a model would ----
const turns: TurnInput[] = [];
const midTurn: ((input: TurnInput) => Promise<void>)[] = [];
function fakeProvider(id: "claude" | "chatgpt", label: string, models: string[]): AgentProvider {
  return {
    id,
    label,
    status: async () => ({ id, label, installed: true, loggedIn: true, models: models.map((model) => ({ id: `${id}:${model}`, provider: id, model, label: model, available: true })) }),
    async *runTurn(input) {
      turns.push(input);
      yield { type: "session", sessionId: input.sessionId ?? `${id}-session-${randomUUID().slice(0, 8)}` };
      await midTurn.shift()?.(input);
      yield { type: "text-delta", blockId: "b1", delta: `Reply from ${label}.` };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    },
    complete: async () => "A title",
  };
}
providers.claude = fakeProvider("claude", "Claude", ["claude-opus-5-5", "claude-sonnet-5-5"]);
providers.chatgpt = fakeProvider("chatgpt", "ChatGPT", ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]);
async function turn(chatId: string, body: SendMessageRequest): Promise<TurnInput> {
  const { runId } = await sendMessage(chatId, body);
  await runEnd(runId);
  return turns.at(-1)!;
}

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

/** The agent's tools in one chat, through a real MCP client. */
async function mcp(chatId: string) {
  const client = new Client({ name: "tickets-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp/${chatId}`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: (result.content as { text?: string }[]).map((c) => c.text ?? "").join("\n"), isError: Boolean(result.isError) };
  };
  const tools = (await client.listTools()).tools.map((t) => t.name);
  return { client, call, tools };
}

type Notice = Extract<MessagePart, { type: "notice" }>;
/** The "Filed under …" notices in a chat. */
const filingNotices = (chatId: string): Notice[] =>
  messages.listByConversation(chatId).flatMap((m) => m.parts.filter((p): p is Notice => p.type === "notice" && p.text.startsWith("Filed under")));

const tot = agents.create({ name: "Tot", mascot });
// Tasks are created here, never run: a held queue starts nothing (no clone from GitHub).
queueHolds.set(tot.id, null, "test");

// --- Before there are any projects ------------------------------------------------------------
console.log("\n# No projects yet");
const early = conversations.create({ agentId: tot.id, modelId: tot.modelId });
let input = await turn(early.id, { text: "Plan my week" });
check("with no projects, a chat's prompt has no project list", !input.systemPrompt.includes("# Projects"));
const earlyTools = (await mcp(early.id)).tools;
check("…and its agent has ticket_link but not chat_set_project", earlyTools.includes("ticket_link") && !earlyTools.includes("chat_set_project"), earlyTools.join(","));

// --- Projects and their intake ------------------------------------------------------------------
const web = (await request<Project>("POST", "/projects", { kind: "github", source: "acme/web" })).data;
await request("PATCH", `/projects/${web.id}`, { intake: { slackChannels: ["#web-bugs"], linearTeams: ["ENG"] } });
const api = (await request<Project>("POST", "/projects", { kind: "github", source: "acme/api" })).data;
const launch = (await request<Project>("POST", "/projects", { kind: "none", name: "Q4 launch" })).data;
// Two projects take Linear's MOB team: its tickets don't file anything.
await request("PATCH", `/projects/${api.id}`, { intake: { linearTeams: ["MOB"] } });
await request("PATCH", `/projects/${launch.id}`, { intake: { linearTeams: ["MOB"] } });

// --- Finding tickets --------------------------------------------------------------------------------
console.log("\n# Finding tickets");
const LINEAR = "https://linear.app/acme/issue/ENG-123/checkout-is-flaky";
let found = detectTicket(`Can you fix ${LINEAR}?`);
check(
  "a Linear issue link: its key, the link, and the key as the label",
  JSON.stringify(found) === JSON.stringify({ kind: "linear", key: "ENG-123", url: LINEAR, label: "ENG-123" }),
  JSON.stringify(found),
);
found = detectTicket("See https://github.com/acme/web/issues/42 and https://github.com/acme/web/pull/43/files");
check("a GitHub issue link: owner/name#number (the first link wins)", found?.kind === "github" && found.key === "acme/web#42" && found.url === "https://github.com/acme/web/issues/42", JSON.stringify(found));
check("a GitHub pull request link too", detectTicket("Review https://github.com/acme/api/pull/7 please")?.key === "acme/api#7");
found = detectTicket("ENG-77 is back");
check("a bare key counts when a project takes its team's work", found?.kind === "linear" && found.key === "ENG-77" && found.url === null, JSON.stringify(found));
check("…and not otherwise", detectTicket("Move to UTF-8 and OPS-5, like GPT-5 said") === null);
check("a link beats a bare key written before it", detectTicket(`ENG-1 duplicates ${LINEAR}`)?.key === "ENG-123");
check("a repo link alone isn't a ticket", detectTicket("Look at https://github.com/acme/web") === null);

// --- Routing by intake only --------------------------------------------------------------------------
console.log("\n# Routing");
const names = (list: Project[]) => list.map((p) => p.name).sort().join(",");
check("a listed Slack channel routes to its project", names(intake.match({ slackChannel: "#web-bugs" })) === "web" && names(intake.match({ slackChannel: "web-bugs" })) === "web");
check("an unlisted channel routes nowhere", intake.match({ slackChannel: "#general" }).length === 0);
check("a Linear ticket routes by its team", names(intake.match({ ticket: detectTicket(LINEAR) })) === "web");
check("a GitHub issue routes to the project of its repo", names(intake.match({ ticket: detectTicket("https://github.com/acme/api/issues/9") })) === "api");
check("an issue of a repo with no project routes nowhere", intake.match({ ticket: detectTicket("https://github.com/acme/other/issues/1") }).length === 0);
check("a team two projects take matches both", names(intake.match({ ticket: detectTicket("https://linear.app/acme/issue/MOB-4") })) === "Q4 launch,api");
const mentioned = conversations.create({ agentId: tot.id, modelId: tot.modelId });
check("a project's name in the text doesn't file anything", intake.fileNew(mentioned.id, { text: "The web checkout is broken, see the api logs" }) === null && conversations.get(mentioned.id)?.projectId === null);

// --- A first message with a ticket link ---------------------------------------------------------------
console.log("\n# First messages");
const fromLinear = conversations.create({ agentId: tot.id, modelId: tot.modelId });
input = await turn(fromLinear.id, { text: `Can you fix ${LINEAR}?` });
let chat = conversations.get(fromLinear.id)!;
check(
  "a Linear link in the first message sets the chat's origin (the chip)",
  chat.origin?.kind === "linear" && chat.origin.key === "ENG-123" && chat.origin.label === "ENG-123" && chat.origin.url === LINEAR,
  JSON.stringify(chat.origin),
);
check("…and files it in the project that takes ENG", chat.projectId === web.id);
check("its first turn already has the project section, not the list", input.systemPrompt.includes("# Project: web\n<project>") && !input.systemPrompt.includes("# Projects"), input.systemPrompt.slice(-400));
let reply = messages.listByConversation(fromLinear.id).at(-1)!;
const notice = reply.parts[0];
check(
  "the reply opens with “Filed under web”, naming the project for Move",
  notice?.type === "notice" && notice.text === "Filed under web" && notice.projectId === web.id && reply.parts.some((p) => p.type === "text"),
  JSON.stringify(reply.parts),
);
check("the chat still gets its own title", chat.title === "A title", chat.title);
let task = tasks.create({ agentId: tot.id, parentId: fromLinear.id, goal: "Fix the checkout test" });
check("a task from it works on a branch named after the ticket", task.task.repo?.branch.startsWith("tot/eng-123-fix-the-checkout-test-") === true, task.task.repo?.branch);
await turn(fromLinear.id, { text: "Also https://linear.app/acme/issue/ENG-9" });
chat = conversations.get(fromLinear.id)!;
check("a later message's link changes nothing", chat.origin?.key === "ENG-123" && filingNotices(fromLinear.id).length === 1);

const fromGitHub = conversations.create({ agentId: tot.id, modelId: tot.modelId });
await turn(fromGitHub.id, { text: "Why does https://github.com/acme/api/issues/9 happen?" });
chat = conversations.get(fromGitHub.id)!;
check("a GitHub issue link files the chat into that repo's project", chat.projectId === api.id && chat.origin?.kind === "github" && chat.origin.key === "acme/api#9", JSON.stringify(chat.origin));
task = tasks.create({ agentId: tot.id, parentId: fromGitHub.id, goal: "Fix it" });
check("…and its tasks' branches start with the issue", task.task.repo?.branch.startsWith("tot/acme-api-9-fix-it-") === true, task.task.repo?.branch);

const bare = conversations.create({ agentId: tot.id, modelId: tot.modelId });
await turn(bare.id, { text: "ENG-500 is broken again" });
chat = conversations.get(bare.id)!;
check("a bare ENG key does the same, with no link", chat.projectId === web.id && chat.origin?.key === "ENG-500" && chat.origin.url === null, JSON.stringify(chat.origin));

const ambiguous = conversations.create({ agentId: tot.id, modelId: tot.modelId });
input = await turn(ambiguous.id, { text: "Look at https://linear.app/acme/issue/MOB-4/crash" });
chat = conversations.get(ambiguous.id)!;
check("two projects matching: the origin is set, but the chat isn't filed", chat.origin?.key === "MOB-4" && chat.projectId === null && filingNotices(ambiguous.id).length === 0, JSON.stringify(chat.origin));
check("…and its agent gets the project list to ask or file", input.systemPrompt.includes("# Projects\n<projects>"));

const unknownTeam = conversations.create({ agentId: tot.id, modelId: tot.modelId });
await turn(unknownTeam.id, { text: "https://linear.app/acme/issue/OPS-1" });
chat = conversations.get(unknownTeam.id)!;
check("a ticket from a team no project takes: origin only", chat.origin?.key === "OPS-1" && chat.projectId === null);

const inProject = (await request<Conversation>("POST", "/conversations", { agentId: tot.id, projectId: launch.id })).data;
await turn(inProject.id, { text: `Is ${LINEAR} part of the launch?` });
chat = conversations.get(inProject.id)!;
check("a chat started in a project stays there (its origin is still set)", chat.projectId === launch.id && chat.origin?.key === "ENG-123" && filingNotices(inProject.id).length === 0);

// --- The project list in prompts ------------------------------------------------------------------
console.log("\n# The project list");
const loose = conversations.create({ agentId: tot.id, modelId: tot.modelId });
input = await turn(loose.id, { text: "Let's draft the launch announcement" });
check(
  "a chat in no project gets the projects, one line each, and the rule",
  input.systemPrompt.includes(
    "# Projects\n<projects>\nThis chat isn't in a project. The user's projects:\n- api: GitHub acme/api\n- Q4 launch: topic, no files\n- web: GitHub acme/web\nIf this chat is clearly about one of these, file it with chat_set_project and say so; if it's unclear, ask.\n</projects>",
  ),
  input.systemPrompt.slice(input.systemPrompt.indexOf("# Projects"), input.systemPrompt.indexOf("# Projects") + 400),
);
check("…and no project section", !input.systemPrompt.includes("# Project:"));
const webChat = (await request<Conversation>("POST", "/conversations", { agentId: tot.id, projectId: web.id })).data;
input = await turn(webChat.id, { text: "Where's the cart code?" });
check("a chat in a project gets only its own section", input.systemPrompt.includes("# Project: web") && !input.systemPrompt.includes("# Projects"));
input = await turn(early.id, { text: "And next week?" });
check("a chat from before there were projects gets the list too, without a note", input.systemPrompt.includes("# Projects\n<projects>") && !input.prompt.includes("[This chat"), input.prompt.slice(0, 200));

// --- The agent files a chat ----------------------------------------------------------------------------
console.log("\n# chat_set_project");
let tool = await mcp(loose.id);
check("a chat in no project has chat_set_project once there are projects", tool.tools.includes("chat_set_project") && tool.tools.includes("ticket_link"));
let said = "";
midTurn.push(async () => {
  said = (await tool.call("chat_set_project", { project: "q4 launch" })).text;
});
await turn(loose.id, { text: "This is for the Q4 launch" });
chat = conversations.get(loose.id)!;
check("the agent files it (by name, any case)", chat.projectId === launch.id && said.startsWith("Filed this chat under Q4 launch") && said.includes("# Project: Q4 launch"), said);
reply = messages.listByConversation(loose.id).at(-1)!;
check(
  "the notice is in the reply it was writing, naming the project",
  reply.parts[0]?.type === "notice" && reply.parts[0].text === "Filed under Q4 launch" && reply.parts[0].projectId === launch.id && filingNotices(loose.id).length === 1,
  JSON.stringify(reply.parts),
);
input = await turn(loose.id, { text: "Go on" });
check(
  "its next turn hears it's in the project, and the list makes way for the section",
  input.prompt.includes("[This chat is now in a project; this replaces any earlier project section:\n# Project: Q4 launch") &&
    input.systemPrompt.includes("# Project: Q4 launch") &&
    !input.systemPrompt.includes("# Projects"),
  input.prompt.slice(0, 200),
);
const moved = await request<Conversation>("PATCH", `/conversations/${loose.id}`, { projectId: null });
check("Move puts it back in no project", moved.status === 200 && moved.data.projectId === null && conversations.get(loose.id)?.projectId === null);
input = await turn(loose.id, { text: "Something else" });
check(
  "…its agent hears the user took it out, and gets the list back",
  input.prompt.includes("[This chat is no longer in a project: the user took it out") && input.systemPrompt.includes("# Projects\n<projects>") && !input.systemPrompt.includes("# Project:"),
  input.prompt.slice(0, 200),
);

tool = await mcp(webChat.id);
let r = await tool.call("chat_set_project", { project: "Q4 launch" });
check("the agent can't move a chat that's already in a project", r.isError && r.text === "This chat is already in web; the user can move it." && conversations.get(webChat.id)?.projectId === web.id, r.text);
tool = await mcp(early.id);
r = await tool.call("chat_set_project", { project: "billing" });
check("an unknown project is refused, with the names", r.isError && r.text.includes('There\'s no project called "billing"') && r.text.includes("Q4 launch"), r.text);
check("…and nothing is filed", conversations.get(early.id)?.projectId === null && filingNotices(early.id).length === 0);
const taskTools = (await mcp(task.id)).tools;
check("a task has neither tool (it's in its chat's project)", !taskTools.includes("chat_set_project") && !taskTools.includes("ticket_link"), taskTools.join(","));

// --- ticket_link ---------------------------------------------------------------------------------------------
console.log("\n# ticket_link");
r = await tool.call("ticket_link", { url: "https://github.com/acme/web/pull/42" });
chat = conversations.get(early.id)!;
check("ticket_link sets the origin of a chat with none", !r.isError && chat.origin?.kind === "github" && chat.origin.key === "acme/web#42" && chat.origin.url === "https://github.com/acme/web/pull/42", r.text);
check("…says which project takes it, without filing the chat", r.text.includes("It's from web's intake") && chat.projectId === null, r.text);
task = tasks.create({ agentId: tot.id, parentId: early.id, goal: "Address the review", repo: "acme/web" });
check("…and tasks started afterwards are named after it", task.task.repo?.branch.startsWith("tot/acme-web-42-address-the-review-") === true, task.task.repo?.branch);
r = await tool.call("ticket_link", { url: LINEAR });
check("a chat that already has an origin keeps it", r.isError && conversations.get(early.id)?.origin?.key === "acme/web#42", r.text);
r = await (await mcp(conversations.create({ agentId: tot.id, modelId: tot.modelId }).id)).call("ticket_link", { url: "https://example.com/ticket/1" });
check("a link that isn't a ticket is refused", r.isError && r.text.includes("isn't a Linear issue link"), r.text);

// --- Branch names -----------------------------------------------------------------------------------------------
console.log("\n# Branch names");
check("no ticket: the branch is as before", /^tot\/fix-login-bug-[0-9a-f]{4}$/.test(planRepo("acme/web", "Fix login bug").branch));
check("a title that starts with the key doesn't repeat it", /^tot\/eng-123-fix-checkout-[0-9a-f]{4}$/.test(planRepo("acme/web", "ENG-123 Fix checkout", undefined, "ENG-123").branch));
const nested = tasks.create({ agentId: tot.id, parentId: task.id, goal: "Write the tests", repo: "acme/web" });
check("a task's own tasks inherit the ticket from the chat above", nested.task.repo?.branch.startsWith("tot/acme-web-42-write-the-tests-") === true, nested.task.repo?.branch);

// --- Slack intake -------------------------------------------------------------------------------------------------
console.log("\n# Slack");
const posted: { channel: string; text?: string }[] = [];
let tsCounter = 1000;
const slackApi = {
  auth: { test: async () => ({ team: "Acme", user: "tot", user_id: "UBOT" }) },
  chat: {
    postMessage: async (args: any) => (posted.push(args), { ts: `17900${String(tsCounter++).padStart(5, "0")}.000100` }),
    update: async () => ({}),
    delete: async () => ({}),
    getPermalink: async (args: any) => ({ permalink: `https://acme.slack.com/archives/${args.channel}/p${args.message_ts.replace(".", "")}` }),
  },
  conversations: {
    replies: async () => ({ messages: [] }),
    info: async (args: any) => ({ channel: { name: args.channel === "CWEB" ? "web-bugs" : "general" } }),
  },
  users: { info: async () => ({ user: { profile: { display_name: "Alice" } } }) },
};
class FakeSocket extends EventEmitter {
  async start() {
    this.emit("connected");
    return {};
  }
  async disconnect() {}
}
const socket = new FakeSocket();
/** Stands in for a turn: replies "Done" (Slack and email start their turns through it, not the models). */
const started: string[] = [];
async function fakeSend(conversationId: string, req: SendMessageRequest): Promise<SendMessageResponse> {
  started.push(conversationId);
  const assistant: Message = { id: randomUUID(), conversationId, role: "assistant", parts: [], status: "streaming", createdAt: Date.now() };
  messages.insert(assistant);
  const run = runRegistry.create(conversationId, assistant.id);
  const builder = new MessageBuilder(assistant, (event) => run.push(event));
  void (async () => {
    await sleep(20);
    builder.apply({ type: "text-delta", blockId: "b1", delta: `Done: ${req.text}` });
    const final = builder.finish("complete");
    messages.save(final);
    run.push({ type: "run-end", status: "complete", message: final });
    runRegistry.finish(run);
  })();
  return { runId: run.id, userMessage: assistant, conversation: conversations.get(conversationId) } as unknown as SendMessageResponse;
}
slack.useSender(fakeSend as typeof sendMessage);
await slack.connect({ appToken: "xapp-1-test", botToken: "xoxb-test" }, { api: slackApi, socket });
slack.patch({ allow: "UALICE", defaultAgentId: tot.id });
async function slackChat(channel: string, text: string) {
  const before = started.length;
  const repliesBefore = posted.length;
  const ts = `17901${String(tsCounter++).padStart(5, "0")}.000100`;
  socket.emit("app_mention", { ack: async () => {}, event: { channel, user: "UALICE", text: `<@UBOT> ${text}`, ts } });
  // Started, then answered (after the "Tot is thinking…" line).
  await until(() => started.length > before && posted.length > repliesBefore + 1);
  return conversations.get(started.at(-1)!)!;
}
chat = await slackChat("CWEB", "checkout returns a 500");
check("a Slack mention in #web-bugs starts its chat in web", chat.projectId === web.id && chat.origin?.kind === "slack" && chat.origin.label === "#web-bugs" && chat.agentId === tot.id, JSON.stringify(chat.origin));
check("…with the notice, first thing in the chat", filingNotices(chat.id).length === 1 && messages.listByConversation(chat.id)[0]?.parts[0]?.type === "notice");
chat = await slackChat("CGEN", "what's for lunch?");
check("a mention in another channel starts in no project", chat.projectId === null && filingNotices(chat.id).length === 0);
chat = await slackChat("CGEN", `can someone look at ${LINEAR}`);
check("…unless its ticket is a project's intake (the origin stays the Slack thread)", chat.projectId === web.id && chat.origin?.kind === "slack");
chat = await slackChat("CWEB", "this is https://github.com/acme/api/issues/12");
check("#web-bugs with an api issue: two projects match, so no filing", chat.projectId === null && filingNotices(chat.id).length === 0);

// --- Email intake ---------------------------------------------------------------------------------------------------
console.log("\n# Email");
const GMAIL_PASS = "mx.google.com; dkim=pass header.i=@acme.com header.s=s1 header.b=Ab12; spf=pass smtp.mailfrom=dhruval@acme.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=acme.com";
const inbox: { uid: number; source: Buffer; seen: boolean }[] = [];
const news = new EventEmitter();
class FakeConnection implements MailConnection {
  async read(folder: "inbox" | "sent", want: { newest: number } | { fromUid: number }) {
    const box = folder === "inbox" ? inbox : [];
    const list = "newest" in want ? box.slice(-want.newest) : box.filter((m) => m.uid >= want.fromUid);
    return { validity: "1", uidNext: box.length + 1, mail: list.map((m) => ({ ...m })) };
  }
  async seen(_folder: "inbox" | "sent", uids: number[]) {
    return new Map(inbox.filter((m) => uids.includes(m.uid)).map((m) => [m.uid, m.seen] as const));
  }
  async markSeen() {}
  async send() {}
  on(event: "news" | "close", listener: () => void) {
    if (event === "news") news.on("news", listener);
  }
  async close() {}
}
const transport: MailTransport = { connect: async () => new FakeConnection() };
mailboxes.useTransport(transport);
const persona = personas.create({ name: "Tot", email: "tot.agent@gmail.com" });
await mailboxes.connect(persona.id, { password: "abcdefghijklmnop" });
personas.update(persona.id, { allowedSenders: ["dhruval@acme.com"], defaultAgentId: tot.id });
emailTasks.useSender(fakeSend as typeof sendMessage);
emailTasks.start();
async function emailChat(subject: string, text: string) {
  const before = started.length;
  const raw = [
    `Authentication-Results: ${GMAIL_PASS}`,
    "From: Dhruval <dhruval@acme.com>",
    "To: Tot <tot.agent@gmail.com>",
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <m.${randomUUID().slice(0, 8)}@acme.com>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
  ].join("\r\n");
  inbox.push({ uid: inbox.length + 1, source: Buffer.from(raw), seen: false });
  news.emit("news");
  await until(() => started.length > before);
  return conversations.get(started.at(-1)!);
}
let emailed = await emailChat("Crash on login", "Please fix https://github.com/acme/api/issues/31 today.");
check("an emailed task about an api issue starts its chat in api", emailed?.projectId === api.id && emailed.origin?.kind === "email" && filingNotices(emailed.id).length === 1, JSON.stringify(emailed?.origin));
emailed = await emailChat("ENG-321: the cart is empty", "Can you take this one?");
check("a bare ENG key in the subject files it in web", emailed?.projectId === web.id, String(emailed?.projectId));
emailed = await emailChat("Lunch", "Where shall we go?");
check("an email about nothing in particular starts in no project", Boolean(emailed) && emailed!.projectId === null);
emailTasks.stop();

// --- At most 20 projects in the list ---------------------------------------------------------------------------------
console.log("\n# Many projects");
for (let n = 1; n <= 20; n++) projects.create({ kind: "none", name: `Topic ${String(n).padStart(2, "0")}` });
const list = projectList() ?? "";
check(
  "the list shows 20 projects and says how many more",
  list.split("\n").filter((line) => line.startsWith("- ") && !line.startsWith("- …")).length === 20 && list.includes("- … and 3 more"),
  list,
);

server.close();
await slack.stop();
await mailboxes.stopAll();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
