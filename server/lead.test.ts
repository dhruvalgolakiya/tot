// A project's Lead (roadmap module 11, lane D): made once per project; its prompt; its tools (mission_overview, and
// task_status / task_list / task_message across every task in the project); task_land and task_discard, which put a
// card in front of the user that waits as long as it takes and act only on their yes (answered here by the test, also
// after the turn), landing only the head the card showed; wakes for
// any task in the project; Home's counts; and the Lead's limits counting only work in flight. Real git and the macOS
// sandbox under a temp HOME (folder projects), fake model turns.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/lead.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serve } from "@hono/node-server";
import type { Conversation, HomeProject, Message, MessagePart, Project, SendMessageRequest } from "../shared/types.ts";

// A temp home, set before anything reads it: folder projects must be inside it (as in landing.test.ts).
const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), "..", ".scratch");
mkdirSync(SCRATCH, { recursive: true });
const HOME = realpathSync.native(mkdtempSync(join(SCRATCH, "lead-home-")));
const OUTSIDE = realpathSync.native(mkdtempSync(join(SCRATCH, "lead-outside-")));
process.env.HOME = HOME;
process.on("exit", () => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});
// A fake gh first on PATH (GitHub's status asks gh who's logged in), so the real one is never touched.
const bin = join(OUTSIDE, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test
const PORT = 30_000 + Math.floor(Math.random() * 5000);

const { HttpError } = await import("./agent/orchestrator.ts");
const { MessageBuilder } = await import("./agent/message-builder.ts");
const { makeElicitor } = await import("./agent/approvals.ts");
const { buildSystemPrompt } = await import("./agent/prompts.ts");
const { runRegistry } = await import("./agent/runs.ts");
const { computerManager } = await import("./computer/manager.ts");
const { localSandboxed } = await import("./computer/local.ts");
const { MCP_TOKEN } = await import("./config.ts");
const { agents } = await import("./data/agents.ts");
const { conversations, toPublicConversation } = await import("./data/conversations.ts");
const { messages } = await import("./data/messages.ts");
const { db } = await import("./db.ts");
const { queueHolds } = await import("./data/queue-holds.ts");
const { settings } = await import("./data/settings.ts");
const { createApp } = await import("./app.ts");
const { taskChecks } = await import("./landing/checks.ts");
const { leadNote, leadSection } = await import("./lead/prompt.ts");
const { leadWakes } = await import("./lead/wake.ts");
const { checkSpawn } = await import("./orchestration/budget.ts");
const { prepareTask } = await import("./projects/checkout.ts");
const { projects } = await import("./projects/projects.ts");
const { LEAD_NEWS } = await import("./tasks/prompt.ts");
const { runLoop } = await import("./tasks/run-loop.ts");
const { taskStore } = await import("./tasks/store.ts");
const { tasks } = await import("./tasks/tasks.ts");
const { chatWakes } = await import("./tasks/wake.ts");
type TurnOptions = import("./agent/orchestrator.ts").TurnOptions;
type TaskRecord = import("./tasks/store.ts").TaskRecord;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 300)}` : ""}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end && !condition(); ) await sleep(25);
}
const mascot = { shape: "blob" as const, color: "#60a5fa", accessory: "none" as const, eyes: "dots" as const };

settings.patch({ computer: { mode: "local" } });

// --- Fake model turns: each records what it was sent, then finishes its task if it's one ------------
const sent: { conversationId: string; text: string; preamble: string; auto: boolean }[] = [];
async function fakeSend(conversationId: string, request: SendMessageRequest, options: TurnOptions = {}) {
  if (runRegistry.activeFor(conversationId)) throw new HttpError(409, "Busy.");
  sent.push({ conversationId, text: request.text ?? "", preamble: options.preamble ?? "", auto: Boolean(options.auto) });
  const now = Date.now();
  const user: Message = { id: randomUUID(), conversationId, role: "user", parts: [{ type: "text", id: randomUUID(), text: request.text ?? "" }], status: "complete", createdAt: now };
  messages.insert(user);
  const assistant: Message = { id: randomUUID(), conversationId, role: "assistant", parts: [], status: "streaming", createdAt: now + 1 };
  messages.insert(assistant);
  const run = runRegistry.create(conversationId, assistant.id);
  const builder = new MessageBuilder(assistant, (event) => run.push(event));
  run.reply = () => builder.message;
  void (async () => {
    await sleep(20);
    builder.apply({ type: "text-delta", blockId: randomUUID(), delta: "Noted." });
    if (taskStore.get(conversationId)?.task.status === "running") tasks.finish(conversationId, "done", "Did it.");
    const final = builder.finish("complete");
    messages.save(final);
    run.push({ type: "run-end", status: "complete", message: final });
    runRegistry.finish(run);
  })();
  return { runId: run.id, userMessage: user, conversation: toPublicConversation(conversations.get(conversationId)!) };
}
runLoop.useSender(fakeSend);
tasks.start();

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

/** An MCP client on a conversation's tools, as the harness would use them. */
async function mcp(conversationId: string) {
  const client = new Client({ name: "tot-lead-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp/${conversationId}`), {
      requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: Boolean(result.isError), text: (result.content as { text?: string }[]).map((c) => c.text ?? "").join("\n") };
  };
  const tools = async () => (await client.listTools()).tools.map((tool) => tool.name);
  return { client, call, tools };
}

type Card = Extract<MessagePart, { type: "approval" }>;

/** A turn running in the Lead's chat, so its tools can put a card in its reply (answered here by the test). */
function startRun(conversationId: string, waitMs?: number) {
  const assistant: Message = { id: randomUUID(), conversationId, role: "assistant", parts: [], status: "streaming", createdAt: Date.now() };
  messages.insert(assistant);
  const run = runRegistry.create(conversationId, assistant.id);
  const builder = new MessageBuilder(assistant, (event) => run.push(event));
  makeElicitor({ run, builder, agentId: conversations.get(conversationId)!.agentId, unattended: false, waitMs });
  // As the orchestrator wires a real turn.
  run.reply = () => builder.message;
  run.addPart = (part) => {
    builder.add(part);
    messages.save(builder.message);
  };
  run.replacePart = (part) => {
    builder.replace(part);
    messages.save(builder.message);
  };
  const card = () => builder.message.parts.findLast((p): p is Card => p.type === "approval" && p.status === "pending");
  const answer = async (decision: "accept" | "decline") => (await request("POST", `/runs/${run.id}/approvals/${card()!.id}`, { decision })).status;
  const end = () => {
    const final = builder.finish("complete");
    messages.save(final);
    run.push({ type: "run-end", status: "complete", message: final });
    runRegistry.finish(run);
  };
  return { run, card, answer, end };
}

// git as the user (or the test, standing in for an agent) runs it on this Mac.
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function makeRepo(path: string, files: Record<string, string>): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  git(path, "config", "user.name", "The User");
  git(path, "config", "user.email", "user@example.com");
  for (const [file, content] of Object.entries(files)) writeFileSync(join(path, file), content);
  git(path, "add", ".");
  git(path, "commit", "-qm", "init");
}
function commit(cwd: string, files: Record<string, string>, subject: string): string {
  for (const [file, content] of Object.entries(files)) writeFileSync(join(cwd, file), content);
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", subject);
  return git(cwd, "rev-parse", "HEAD");
}

const tot = agents.create({ name: "Tot", mascot });
const ivy = agents.create({ name: "Ivy", mascot });
// Tasks are created here and set up by hand (prepareTask, as the run loop does); none starts by itself.
queueHolds.set(tot.id, null, "test");
queueHolds.set(ivy.id, null, "test");
await computerManager.ensure(tot.id);

/** A task, set up, with `work` committed in its worktree (as its agent would), finished "done". */
async function doneTask(input: { parentId?: string; projectId?: string }, goal: string, work: (worktree: string) => void): Promise<TaskRecord> {
  const created = tasks.create({ agentId: tot.id, goal, ...input });
  const repo = await prepareTask(taskStore.get(created.id)!);
  work(repo.worktree);
  taskStore.patch(created.id, { repo: { ...repo, headSha: git(repo.worktree, "rev-parse", "HEAD") } });
  taskStore.transition(created.id, "running");
  tasks.finish(created.id, "done", `Did it: ${goal.toLowerCase()}.`);
  await until(() => taskStore.get(created.id)?.task.checks != null && !taskChecks.isRunning(created.id));
  return taskStore.get(created.id)!;
}

if (!localSandboxed) {
  console.log("SKIP  the Lead's landing needs the macOS sandbox for folder projects; not here");
  server.close();
  process.exit(0);
}

// =============================================================================
// The Lead chat: made once per project
// =============================================================================
console.log("\n# The Lead is made once");
const shop = join(HOME, "code/shop");
makeRepo(shop, { "a.txt": "one\n" });
let res: { status: number; data: any } = await request<Project>("POST", "/projects", { kind: "folder", source: shop, grant: true });
const shopProject: Project = res.data;
// Ivy works in the project most, so with no agent named, the Lead is Ivy's.
conversations.create({ agentId: ivy.id, modelId: ivy.modelId, title: "Ivy's chat", projectId: shopProject.id });
conversations.create({ agentId: ivy.id, modelId: ivy.modelId, title: "Ivy's other chat", projectId: shopProject.id });
const totChat = conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Tot's chat", projectId: shopProject.id });
check("a project has no Lead before it's opened", res.status === 201 && shopProject.leadChatId === null, JSON.stringify(res.data));
const [first, second] = await Promise.all([request<Conversation>("POST", `/projects/${shopProject.id}/lead`, {}), request<Conversation>("POST", `/projects/${shopProject.id}/lead`, {})]);
const lead: Conversation = first.status === 201 ? first.data : second.data;
check(
  "POST /projects/:id/lead makes a pinned “Lead” chat in the project, the agent most active there",
  lead.lead === true && lead.pinned && lead.title === "Lead" && lead.projectId === shopProject.id && lead.agentId === ivy.id && lead.kind === "chat",
  JSON.stringify(lead),
);
check("two at once make one (201, then 200 with the same chat)", [first.status, second.status].sort().join() === "200,201" && first.data.id === second.data.id, `${first.status} ${second.status}`);
res = await request<Conversation>("POST", `/projects/${shopProject.id}/lead`, { agentId: tot.id });
check("asking again (even naming another agent) gives the same Lead", res.status === 200 && res.data.id === lead.id && res.data.agentId === ivy.id, JSON.stringify(res.data));
res = await request<Project[]>("GET", "/projects");
check("the project names its Lead (Project.leadChatId)", res.data.find((p: Project) => p.id === shopProject.id)?.leadChatId === lead.id);
check("other chats don't carry the flag", conversations.get(totChat.id)?.lead === undefined && !("lead" in toPublicConversation(conversations.get(totChat.id)!)));
res = await request("PATCH", `/conversations/${lead.id}`, { projectId: null });
check("the Lead can't be moved out of its project", res.status === 400 && conversations.get(lead.id)?.projectId === shopProject.id, JSON.stringify(res.data));
res = await request("POST", `/projects/${randomUUID()}/lead`, {});
check("an unknown project: 404", res.status === 404);
const notes = (await request<Project>("POST", "/projects", { kind: "none", name: "Notes" })).data;
await request("DELETE", `/projects/${notes.id}`);
res = await request("POST", `/projects/${notes.id}/lead`, {});
check("an archived project without a Lead doesn't get one", res.status === 400 && conversations.leadOf(notes.id) === null, JSON.stringify(res.data));

// =============================================================================
// The Lead's prompt
// =============================================================================
console.log("\n# The Lead's prompt");
const project = projects.get(shopProject.id)!;
const section = leadSection(project);
check(
  "its section: the role, the repo, the knowledge, checking before landing, and landing only with the user's OK",
  section.startsWith("# Lead of shop\n<lead>") &&
    section.includes("You're this project's Lead") &&
    section.includes(`- shop: folder ~/code/shop · base: the repo's default branch`) &&
    section.includes("Knowledge: the project's brain “shop”") &&
    section.includes("task_update_from_base") &&
    section.includes("Landing needs the user's OK, every time: task_land") &&
    !section.includes("One task per repo"),
  section,
);
const twoRepos: Project = {
  ...project,
  repos: [
    { name: "web", kind: "github", source: "acme/web", defaultBranch: "main", folderGranted: true, primary: true },
    { name: "api", kind: "folder", source: join(HOME, "code/api"), defaultBranch: null, folderGranted: false, primary: false },
  ],
};
const split = leadSection(twoRepos);
check(
  "with two repos: each listed, and one task per repo",
  split.includes("- web (primary): GitHub acme/web · base: main") && split.includes("- api: folder ~/code/api (the user hasn't allowed agents in yet)") && split.includes("One task per repo"),
  split,
);
const frozen = buildSystemPrompt({ settings: settings.get(), workspace: null, agent: { name: "Ivy", instructions: "" }, lead: section });
check("the system prompt carries it", frozen.includes(section));
const moved = leadNote({ lead: true }, twoRepos, frozen);
check(
  "the repos change: the frozen prompt's section is swapped, and the Lead hears once",
  moved.prompt !== null && moved.prompt.includes(split) && !moved.prompt.includes(section) && moved.note.includes("this replaces the earlier ones"),
);
check("…and not again", leadNote({ lead: true }, twoRepos, moved.prompt!).prompt === null);
check("a chat that isn't a Lead gets none", leadNote({}, project, frozen).prompt === null && leadNote({ lead: undefined }, project, "x").note === "");

// =============================================================================
// Its tools see every task in the project
// =============================================================================
console.log("\n# Its tools see every task in the project");
const greet = await doneTask({ parentId: totChat.id }, "Add a greeting", (wt) => commit(wt, { "hello.txt": "hello\n" }, "Add a greeting"));
const notesTask = tasks.create({ agentId: tot.id, projectId: shopProject.id, goal: "Write release notes" });
const leadTools = await mcp(lead.id);
const totTools = await mcp(totChat.id);
const names = await leadTools.tools();
check(
  "the Lead has mission_overview, task_land, task_update_from_base and task_discard",
  ["mission_overview", "task_land", "task_update_from_base", "task_discard", "task_list", "task_status", "task_message"].every((name) => names.includes(name)),
  names.join(", "),
);
const plain = await totTools.tools();
check("a plain chat in the project doesn't", !plain.some((name) => ["mission_overview", "task_land", "task_discard", "task_update_from_base"].includes(name)), plain.join(", "));
let r = await leadTools.call("task_list");
check("task_list: every task in the project, whoever started it", !r.isError && r.text.includes("Add a greeting") && r.text.includes("Write release notes"), r.text);
r = await leadTools.call("task_status", { id: greet.id });
check("task_status on another chat's task", !r.isError && r.text.includes("“Add a greeting”") && r.text.includes("result: Did it"), r.text);
r = await totTools.call("task_status", { id: notesTask.id });
check("…while a plain chat still sees only its own", r.isError && r.text.includes("was started from here"), r.text);
r = await leadTools.call("task_message", { id: notesTask.id, text: "Keep them short." });
check("task_message to a task the Lead didn't start", !r.isError && r.text.includes("Write release notes"), r.text);
r = await leadTools.call("mission_overview");
check(
  "mission_overview: the repos, what's working, what's ready to land in order, with its checks",
  r.text.includes("Project “shop”. Repos:\n- shop: folder ~/code/shop") &&
    /Working \(1\)\n- [^\n]*“Write release notes” · queued/.test(r.text) &&
    /Ready to land, in this order[^\n]*\n1\. [^\n]*“Add a greeting” · done · branch tot\/[^\n]*checks passing · from chat “Tot's chat”/.test(r.text) &&
    r.text.includes("result: Did it: add a greeting."),
  r.text,
);

// =============================================================================
// task_land: the user's OK on a card, then only the reviewed head lands
// =============================================================================
console.log("\n# task_land asks first");
r = await leadTools.call("task_land", { task_id: greet.id, reason: "Adds the greeting; checks pass." });
check("no turn running to ask in: nothing lands", r.isError && r.text.includes("Couldn't ask the user") && !existsSync(join(shop, "hello.txt")), r.text);
r = await leadTools.call("task_land", { task_id: notesTask.id, reason: "Ready." });
check("a task still working: refused without asking", r.isError && r.text.includes("can't land right now, so the user wasn't asked"), r.text);
r = await leadTools.call("task_land", { task_id: randomUUID(), reason: "?" });
check("a task outside the project: refused", r.isError && r.text.includes("in this project"), r.text);

/** The Lead's card (in its reply, or saved once the turn is over) and the user's answer to it. */
const cardIn = (messageId: string, id: string) => messages.get(messageId)?.parts.find((p): p is Card => p.type === "approval" && p.id === id) ?? null;
const answerCard = (id: string, decision: "accept" | "decline") =>
  request<{ status: string; ok: boolean; text: string; error?: string }>("POST", `/lead/asks/${id}`, { decision });
const lastNote = () =>
  messages
    .listByConversation(lead.id)
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "notice")
    .at(-1) as Extract<MessagePart, { type: "notice" }> | undefined;

let turn = startRun(lead.id);
const mainBefore = git(shop, "rev-parse", "main");
r = await leadTools.call("task_land", { task_id: greet.id, reason: "Adds the greeting; checks pass." });
let card = turn.card();
check(
  "task_land returns at once: the card is up and waits for the user (no minute-long limit)",
  !r.isError && r.text.startsWith("Asked the user on a card.") && r.text.includes(greet.task.repo!.headSha!.slice(0, 7)) && card?.status === "pending" && card.lead?.action === "land" && card.lead.taskId === greet.id && card.expiresAt > Date.now() + 24 * 60 * 60_000,
  r.text,
);
check(
  "the card: what lands where, its checks, the branch and head, and the Lead's reason",
  card?.kind === "confirm" &&
    card.source === "Lead" &&
    card.message.startsWith("Merge “Add a greeting” into main? · ") &&
    card.message.includes("checks passing") &&
    card.message.includes(`${greet.task.repo!.branch} @ ${greet.task.repo!.headSha!.slice(0, 7)}`) &&
    card.message.endsWith("Adds the greeting; checks pass."),
  card?.message,
);
check("nothing lands before the OK", git(shop, "rev-parse", "main") === mainBefore && !taskStore.get(greet.id)!.task.landing);
r = await leadTools.call("task_land", { task_id: greet.id, reason: "Again." });
check("asking again for the same commit: no second card", !r.isError && r.text.includes("already") && turn.card()?.id === card!.id, r.text);
let answered = await answerCard(card!.id, "accept");
let landed = taskStore.get(greet.id)!.task.landing;
check(
  "yes: merged into the folder, as the card said",
  answered.status === 200 && answered.data.ok && answered.data.text.startsWith("Merged “Add a greeting” into main") && existsSync(join(shop, "hello.txt")) && landed?.kind === "merged" && landed.target === "main",
  JSON.stringify(answered.data),
);
check("…the card says Approved, and the chat has a note of what happened", cardIn(turn.run.messageId, card!.id)?.status === "accepted" && lastNote()?.text === answered.data.text);
answered = await answerCard(card!.id, "accept");
check("…and a card is answered once (409)", answered.status === 409, JSON.stringify(answered.data));

const shout = await doneTask({ parentId: totChat.id }, "Shout", (wt) => commit(wt, { "shout.txt": "HEY\n" }, "Shout"));
await leadTools.call("task_land", { task_id: shout.id, method: "merge", reason: "Shouts." });
card = turn.card();
answered = await answerCard(card!.id, "decline");
check(
  "no: nothing lands, the card says Denied",
  answered.status === 200 && answered.data.status === "declined" && !existsSync(join(shop, "shout.txt")) && !taskStore.get(shout.id)!.task.landing && cardIn(turn.run.messageId, card!.id)?.status === "declined",
  JSON.stringify(answered.data),
);
turn.end();

// A card answered after the Lead's turn is over still lands: it waited for the user.
const wave = await doneTask({ parentId: totChat.id }, "Wave", (wt) => commit(wt, { "wave.txt": "o/\n" }, "Wave"));
turn = startRun(lead.id);
await leadTools.call("task_land", { task_id: wave.id, reason: "Waves." });
card = turn.card();
const waveMessage = turn.run.messageId;
turn.end();
answered = await answerCard(card!.id, "accept");
check(
  "answered after the turn ended: it lands, and the saved card says Approved",
  answered.data.ok && existsSync(join(shop, "wave.txt")) && taskStore.get(wave.id)!.task.landing?.kind === "merged" && cardIn(waveMessage, card!.id)?.status === "accepted",
  JSON.stringify(answered.data),
);

turn = startRun(lead.id);
await leadTools.call("task_land", { task_id: shout.id, reason: "Shouts." });
card = turn.card();
// The task's branch moves after the card went up (its agent committed again): the card's head is no longer the head.
commit(shout.task.repo!.worktree, { "shout.txt": "HEY!!\n" }, "Shout louder");
answered = await answerCard(card!.id, "accept");
check(
  "yes, but the branch moved since the card: nothing lands, and the note says why",
  answered.status === 200 &&
    !answered.data.ok &&
    answered.data.text.includes("didn't land") &&
    answered.data.text.includes("changed since you looked") &&
    !existsSync(join(shop, "shout.txt")) &&
    !taskStore.get(shout.id)!.task.landing &&
    lastNote()?.kind === "warning",
  JSON.stringify(answered.data),
);
await leadTools.call("task_land", { task_id: shout.id, reason: "Shouts." });
card = turn.card();
db.prepare(`UPDATE lead_asks SET expires_at = ? WHERE id = ?`).run(Date.now() - 1, card!.id);
answered = await answerCard(card!.id, "accept");
check("a card left too long expires: nothing lands (409)", answered.status === 409 && /expired/.test(answered.data.error ?? "") && !taskStore.get(shout.id)!.task.landing && turn.card()?.id !== card!.id, JSON.stringify(answered.data));
r = await leadTools.call("task_land", { task_id: shout.id, method: "pr", reason: "?" });
check("a draft PR in a folder project: refused without asking", r.isError && r.text.includes("Draft PRs are for GitHub projects") && !turn.card(), r.text);

// =============================================================================
// task_discard asks too; task_update_from_base
// =============================================================================
console.log("\n# task_discard and task_update_from_base");
r = await leadTools.call("task_discard", { task_id: shout.id, reason: "Superseded." });
card = turn.card();
check("the discard card", !r.isError && card?.lead?.action === "discard" && card.message.startsWith("Discard “Shout”?") && card.message.endsWith("Superseded."), card?.message);
answered = await answerCard(card!.id, "decline");
check("no: nothing is discarded", answered.data.status === "declined" && !taskStore.get(shout.id)!.task.landing && existsSync(shout.task.repo!.worktree), JSON.stringify(answered.data));
await leadTools.call("task_discard", { task_id: shout.id, reason: "Superseded." });
answered = await answerCard(turn.card()!.id, "accept");
check("yes: discarded, its worktree gone", answered.data.ok && answered.data.text === "Discarded “Shout”, as you approved." && taskStore.get(shout.id)!.task.landing?.kind === "discarded" && !existsSync(shout.task.repo!.worktree), JSON.stringify(answered.data));
r = await leadTools.call("task_discard", { task_id: greet.id, reason: "?" });
check("a landed task can't be discarded (and isn't asked about)", r.isError && r.text.includes("has landed already") && !turn.card(), r.text);
turn.end();

const docs = await doneTask({ projectId: shopProject.id }, "Add docs", (wt) => commit(wt, { "docs.txt": "docs\n" }, "Add docs"));
commit(shop, { "b.txt": "the user's own change\n" }, "Unrelated change on main");
r = await leadTools.call("task_update_from_base", { task_id: docs.id });
const rebased = taskStore.get(docs.id)!.task.repo!.headSha!;
check("task_update_from_base rebases a task that fell behind", !r.isError && r.text.startsWith("Rebased “Add docs” onto") && rebased !== docs.task.repo!.headSha && r.text.includes(rebased.slice(0, 7)), r.text);
r = await leadTools.call("task_update_from_base", { task_id: docs.id });
check("…and then it's up to date", !r.isError && r.text.includes("already up to date"), r.text);

// =============================================================================
// Wakes: the Lead hears about every task in its project
// =============================================================================
console.log("\n# The Lead is woken for any task in its project");
chatWakes.useBatchDelay(150);
chatWakes.start();
leadWakes.start();
const leadTurns = () => sent.filter((s) => s.conversationId === lead.id && s.auto);
/** A task in the project, running (as if its turn started), so it can finish or ask. */
function runningTask(goal: string, input: { parentId?: string; projectId?: string }): TaskRecord {
  const created = tasks.create({ agentId: tot.id, goal, ...input });
  taskStore.transition(created.id, "running");
  return taskStore.get(created.id)!;
}
sent.length = 0;
const fromChat = runningTask("Check the docs", { parentId: totChat.id });
tasks.finish(fromChat.id, "done", "The docs are fine.");
await until(() => leadTurns().length > 0 && sent.some((s) => s.conversationId === totChat.id));
check(
  "another chat's task finishes: the Lead gets one wake turn with its result (and the chat its own)",
  leadTurns().length === 1 && leadTurns()[0]!.text === "“Check the docs” finished." && leadTurns()[0]!.preamble.includes(LEAD_NEWS) && leadTurns()[0]!.preamble.includes("The docs are fine.") && sent.some((s) => s.conversationId === totChat.id && s.auto),
  JSON.stringify(leadTurns()),
);
await until(() => !runRegistry.activeFor(lead.id) && !conversations.get(lead.id)!.wakePending);

sent.length = 0;
const a = runningTask("Translate the page", { projectId: shopProject.id });
const b = runningTask("Resize the logo", { projectId: shopProject.id });
tasks.finish(a.id, "done", "Translated.");
tasks.finish(b.id, "failed", "No logo found.");
await until(() => leadTurns().length > 0);
await sleep(400);
check("two finishing together: one wake", leadTurns().length === 1 && leadTurns()[0]!.text === "2 tasks finished: “Translate the page”, “Resize the logo”.", JSON.stringify(leadTurns()));
await until(() => !runRegistry.activeFor(lead.id) && !conversations.get(lead.id)!.wakePending);

sent.length = 0;
const asks = runningTask("Pick a locale", { projectId: shopProject.id });
tasks.update(asks.id, { question: "Which locale should the dates use?" });
await until(() => leadTurns().length > 0);
check(
  "a task needs input: the Lead hears what it asks",
  leadTurns()[0]?.text === "“Pick a locale” needs input." && leadTurns()[0]!.preamble.includes("It asks: Which locale should the dates use?"),
  JSON.stringify(leadTurns()),
);
await until(() => !runRegistry.activeFor(lead.id) && !conversations.get(lead.id)!.wakePending);

sent.length = 0;
const own = runningTask("Lead's own task", { parentId: lead.id });
tasks.finish(own.id, "done", "Done by the Lead's task.");
await until(() => leadTurns().length > 0);
await sleep(400);
check("its own task finishing: one wake, not two", leadTurns().length === 1 && leadTurns()[0]!.text === "“Lead's own task” finished.", JSON.stringify(leadTurns()));
await until(() => !runRegistry.activeFor(lead.id) && !conversations.get(lead.id)!.wakePending);

sent.length = 0;
const parentTask = runningTask("Big job", { projectId: shopProject.id });
const subTask = runningTask("Small part", { parentId: parentTask.id });
tasks.finish(subTask.id, "done", "Part done.");
await sleep(500);
check("a task's own sub-task finishing: not the Lead's news (its parent task takes it)", leadTurns().length === 0, JSON.stringify(leadTurns()));
settings.patch({ tasks: { wakeChats: false } });
const quiet = runningTask("Quiet one", { projectId: shopProject.id });
tasks.finish(quiet.id, "done", "Shh.");
await sleep(500);
check("wakes off (Settings → Tasks): no wake, the news waits for its next turn", leadTurns().length === 0 && conversations.get(lead.id)!.childResults.includes(quiet.id));
settings.patch({ tasks: { wakeChats: true } });

// =============================================================================
// Home
// =============================================================================
console.log("\n# Home");
const lab = join(HOME, "code/lab");
makeRepo(lab, { "x.txt": "x\n" });
const labProject: Project = (await request<Project>("POST", "/projects", { kind: "folder", source: lab, grant: true })).data;
const labChat = conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Lab", projectId: labProject.id });
await doneTask({ parentId: labChat.id }, "Ready one", (wt) => commit(wt, { "r.txt": "r\n" }, "Ready one"));
const failed = runningTask("Broken one", { parentId: labChat.id });
tasks.finish(failed.id, "failed", "It broke.");
runningTask("Busy one", { parentId: labChat.id });
tasks.create({ agentId: tot.id, parentId: labChat.id, goal: "Waiting one" });
res = await request<HomeProject[]>("GET", "/home");
const labRow = (res.data as HomeProject[]).find((row) => row.project.id === labProject.id);
const shopRow = (res.data as HomeProject[]).find((row) => row.project.id === shopProject.id);
check(
  "GET /home: a project's needs you, working and ready to land, its last activity, no Lead yet",
  labRow?.needsYou === 1 && labRow.working === 2 && labRow.readyToLand === 1 && labRow.leadChatId === null && (labRow.lastActivityAt ?? 0) > 0,
  JSON.stringify(labRow && { ...labRow, project: undefined }),
);
check("…and its Lead once it has one", shopRow?.leadChatId === lead.id, JSON.stringify(shopRow && { ...shopRow, project: undefined }));
check("archived projects aren't on Home", !(res.data as HomeProject[]).some((row) => row.project.id === notes.id));
check("the most recently active first", (res.data as HomeProject[])[0]?.project.id === labProject.id, (res.data as HomeProject[]).map((row) => row.project.name).join(", "));

// =============================================================================
// The Lead's limits count the work in flight
// =============================================================================
console.log("\n# The Lead's limits");
settings.patch({ tasks: { maxChildren: 2 } });
const leadRecord = conversations.get(lead.id)!;
for (const goal of ["Old one", "Older one"]) {
  const old = tasks.create({ agentId: tot.id, parentId: lead.id, goal });
  taskStore.transition(old.id, "stopped");
  taskStore.patch(old.id, { landing: { kind: "discarded", at: Date.now(), target: null, sha: null, pr: null } });
}
let refused = "";
try {
  checkSpawn(conversations.get(lead.id)!, 1);
} catch (err) {
  refused = err instanceof Error ? err.message : String(err);
}
check("the Lead may start more once earlier tasks landed or were discarded", refused === "", refused);
for (const goal of ["Gone one", "Gone two"]) {
  const old = tasks.create({ agentId: tot.id, parentId: totChat.id, goal });
  taskStore.transition(old.id, "stopped");
  taskStore.patch(old.id, { landing: { kind: "discarded", at: Date.now(), target: null, sha: null, pr: null } });
}
refused = "";
try {
  checkSpawn(conversations.get(totChat.id)!, 1);
} catch (err) {
  refused = err instanceof Error ? err.message : String(err);
}
check("…while a plain chat still counts every task it started", refused.includes("at most 2 tasks"), refused || "(not refused)");
check("(the Lead record is still the Lead)", leadRecord.lead === true);

await leadTools.client.close();
await totTools.client.close();
chatWakes.stop();
leadWakes.stop();
server.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
