// The Coordinator's controls (roadmap module 12, lane B): a project's schedules (routines with a project) post a
// "schedule" signal to its Lead instead of starting chats, skip a slot while their last wake still runs, open the Lead
// when there's none, and stay off agents' routine lists; the schedules routes; a new project's first request goes to
// its Lead (a folder's once it's allowed); task_stop / task_pause / task_resume for any task in the project; and
// task_land on a draft PR's task with new commits asks on a card to push them, pushing exactly the reviewed head on
// yes (a local bare repo as GitHub's git, a fake GitHub API). leadInbox.post (lane A) is replaced by a spy; real git
// and the macOS sandbox under a temp HOME; fake model turns.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/lead-controls.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Conversation, LeadSignal, Message, MessagePart, Project, Routine, SendMessageRequest } from "../shared/types.ts";

// A temp home, set before anything reads it: folder projects must be inside it (as in landing.test.ts).
const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), "..", ".scratch");
mkdirSync(SCRATCH, { recursive: true });
const HOME = realpathSync.native(mkdtempSync(join(SCRATCH, "controls-home-")));
const OUTSIDE = realpathSync.native(mkdtempSync(join(SCRATCH, "controls-outside-")));
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
const PORT = 31_000 + Math.floor(Math.random() * 4000);
const GITHUB_PORT = 36_000 + Math.floor(Math.random() * 4000);
process.env.TOT_GITHUB_API_URL = `http://127.0.0.1:${GITHUB_PORT}`;
process.env.TOT_GITHUB_WEB_URL = `http://127.0.0.1:${GITHUB_PORT}`;
process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test

// --- A fake GitHub: who the token is, and the pull requests opened ------------------------------
const TOKEN = "ghp_controlstoken0123456789";
const pulls: { repo: string; body: Record<string, unknown> }[] = [];
const fake = new Hono()
  .get("/user", (c) => {
    if (c.req.header("authorization") !== `Bearer ${TOKEN}`) return c.json({ message: "Bad credentials" }, 401);
    c.header("x-oauth-scopes", "repo, read:org");
    return c.json({ login: "octocat", name: "The Octocat", avatar_url: "https://avatars.example/octocat", id: 583231 });
  })
  .post("/repos/:owner/:repo/pulls", async (c) => {
    const repo = `${c.req.param("owner")}/${c.req.param("repo")}`;
    pulls.push({ repo, body: await c.req.json() });
    return c.json({ number: 11 + pulls.length, html_url: `https://github.com/${repo}/pull/${11 + pulls.length}` }, 201);
  });
const fakeServer = serve({ fetch: fake.fetch, port: GITHUB_PORT, hostname: "127.0.0.1" });

const { HttpError } = await import("./agent/orchestrator.ts");
const { MessageBuilder } = await import("./agent/message-builder.ts");
const { runRegistry } = await import("./agent/runs.ts");
const { scheduler } = await import("./agent/scheduler.ts");
const { computerManager } = await import("./computer/manager.ts");
const { localSandboxed } = await import("./computer/local.ts");
const { MCP_TOKEN } = await import("./config.ts");
const { agents } = await import("./data/agents.ts");
const { conversations, toPublicConversation } = await import("./data/conversations.ts");
const { messages } = await import("./data/messages.ts");
const { queueHolds } = await import("./data/queue-holds.ts");
const { routines } = await import("./data/routines.ts");
const { settings } = await import("./data/settings.ts");
const { db } = await import("./db.ts");
const { github } = await import("./github.ts");
const { createApp } = await import("./app.ts");
const { taskChecks } = await import("./landing/checks.ts");
const { leadInbox } = await import("./lead/inbox.ts");
const { leadWakes } = await import("./lead/wake.ts");
const { prepareTask } = await import("./projects/checkout.ts");
const { firstRequests } = await import("./projects/first-request.ts");
const { runLoop } = await import("./tasks/run-loop.ts");
const { taskStore } = await import("./tasks/store.ts");
const { tasks } = await import("./tasks/tasks.ts");
const { chatWakes } = await import("./tasks/wake.ts");
type TurnOptions = import("./agent/orchestrator.ts").TurnOptions;
type NewSignal = import("./lead/inbox.ts").NewSignal;

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
const sent: { conversationId: string; text: string; auto: boolean }[] = [];
async function fakeSend(conversationId: string, request: SendMessageRequest, options: TurnOptions = {}) {
  if (runRegistry.activeFor(conversationId)) throw new HttpError(409, "Busy.");
  sent.push({ conversationId, text: request.text ?? "", auto: Boolean(options.auto) });
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
    builder.apply({ type: "text-delta", blockId: randomUUID(), delta: "On it." });
    if (taskStore.get(conversationId)?.task.status === "running") tasks.finish(conversationId, "done", "Did it.");
    const final = builder.finish("complete");
    messages.save(final);
    run.push({ type: "run-end", status: "complete", message: final });
    runRegistry.finish(run);
  })();
  return { runId: run.id, userMessage: user, conversation: toPublicConversation(conversations.get(conversationId)!) };
}
runLoop.useSender(fakeSend);
firstRequests.useSender(fakeSend);
tasks.start();

// --- Lane A's inbox, spied on: what schedules post to the Lead ---------------------------------------
const posted: { projectId: string; signal: NewSignal }[] = [];
leadInbox.post = (projectId: string, signal: NewSignal): LeadSignal => {
  posted.push({ projectId, signal });
  return { ...signal, id: randomUUID(), projectId, at: Date.now(), readAt: null };
};

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
  const client = new Client({ name: "tot-controls-test", version: "0.0.0" });
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

/** A turn running in a chat (its tools can put a card in its reply), ended by the test. */
function startRun(conversationId: string) {
  const assistant: Message = { id: randomUUID(), conversationId, role: "assistant", parts: [], status: "streaming", createdAt: Date.now() };
  messages.insert(assistant);
  const run = runRegistry.create(conversationId, assistant.id);
  const builder = new MessageBuilder(assistant, (event) => run.push(event));
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
  const end = () => {
    const final = builder.finish("complete");
    messages.save(final);
    run.push({ type: "run-end", status: "complete", message: final });
    runRegistry.finish(run);
  };
  return { run, card, end };
}

const notices = (conversationId: string) =>
  messages
    .listByConversation(conversationId)
    .flatMap((m) => m.parts)
    .filter((p): p is Extract<MessagePart, { type: "notice" }> => p.type === "notice");

// git as the user (or the test, standing in for an agent) runs it.
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function makeRepo(path: string, files: Record<string, string>): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
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
// Tasks are created here and set up by hand; none starts by itself.
queueHolds.set(tot.id, null, "test");
queueHolds.set(ivy.id, null, "test");

// =============================================================================
// A project's schedules: the routes, and agents' lists leave them out
// =============================================================================
console.log("\n# Schedules: the routes");
let res: { status: number; data: any } = await request<Project>("POST", "/projects", { kind: "none", name: "Launch" });
const launch: Project = res.data;
const launchLead: Conversation = (await request<Conversation>("POST", `/projects/${launch.id}/lead`, { agentId: ivy.id })).data;
const weekdays = { kind: "daily", time: "09:00", days: [1, 2, 3, 4, 5] };
res = await request<Routine>("POST", `/projects/${launch.id}/schedules`, { name: "What's stuck?", prompt: "Look at the board: what's stuck, what needs me?", schedule: weekdays });
const stuck: Routine = res.data;
check(
  "POST /projects/:id/schedules: a routine of the project, with its Lead's agent",
  res.status === 201 && stuck.projectId === launch.id && stuck.agentId === ivy.id && stuck.enabled && (stuck.nextRunAt ?? 0) > Date.now() && stuck.lastConversationId === null,
  JSON.stringify(res.data),
);
res = await request<Routine[]>("GET", `/projects/${launch.id}/schedules`);
check("GET lists it", res.status === 200 && res.data.length === 1 && res.data[0].id === stuck.id, JSON.stringify(res.data));
res = await request<Routine[]>("GET", `/agents/${ivy.id}/routines`);
check("…and the agent's routines leave it out (so do its counts)", res.status === 200 && res.data.length === 0 && agents.get(ivy.id)!.counts.routines === 0, JSON.stringify(res.data));
res = await request<Routine>("POST", `/agents/${ivy.id}/routines`, { name: "Own", prompt: "Mine.", schedule: weekdays, projectId: launch.id });
check("an agent's routine can't be made a project's through the agent's route", res.status === 201 && res.data.projectId === null && routines.forProject(launch.id).length === 1, JSON.stringify(res.data));
await request("DELETE", `/routines/${res.data.id}`);
res = await request("POST", `/projects/${launch.id}/schedules`, { name: "", prompt: "x", schedule: weekdays });
check("a bad schedule: 400 with the reason", res.status === 400 && /names/.test(res.data.error), JSON.stringify(res.data));
res = await request("POST", `/projects/${launch.id}/schedules`, { name: "Fast", prompt: "x", schedule: { kind: "interval", everyMinutes: 5 } });
check("…an interval under 15 minutes too", res.status === 400 && /Intervals/.test(res.data.error), JSON.stringify(res.data));
res = await request("GET", `/projects/${randomUUID()}/schedules`);
check("an unknown project: 404", res.status === 404);
res = await request<Routine>("PATCH", `/projects/${launch.id}/schedules/${stuck.id}`, { name: "Standup", enabled: false });
check("PATCH renames and pauses it (no next run)", res.status === 200 && res.data.name === "Standup" && !res.data.enabled && res.data.nextRunAt === null && res.data.projectId === launch.id, JSON.stringify(res.data));
res = await request<Routine>("PATCH", `/projects/${launch.id}/schedules/${stuck.id}`, { enabled: true });
check("…and resumes it", res.data.enabled && (res.data.nextRunAt ?? 0) > Date.now(), JSON.stringify(res.data));
const other: Project = (await request<Project>("POST", "/projects", { kind: "none", name: "Other" })).data;
res = await request("PATCH", `/projects/${other.id}/schedules/${stuck.id}`, { name: "Hijack" });
const res2 = await request("DELETE", `/projects/${other.id}/schedules/${stuck.id}`);
check("another project's schedule isn't found there (404), and isn't changed", res.status === 404 && res2.status === 404 && routines.get(stuck.id)?.name === "Standup");

const ivyChat = conversations.create({ agentId: ivy.id, modelId: ivy.modelId, title: "Ivy's chat" });
const ivyTools = await mcp(ivyChat.id);
let r = await ivyTools.call("routine_list");
check("routine_list in the agent's chat leaves it out", !r.isError && r.text === "You have no routines yet.", r.text);
r = await ivyTools.call("routine_delete", { id: stuck.id });
check("…and routine_delete can't delete it", r.isError && routines.get(stuck.id) !== null, r.text);
await ivyTools.client.close();

// =============================================================================
// Running: a "schedule" signal to the Lead, never a new chat
// =============================================================================
console.log("\n# Schedules: running in the Lead");
const due = (id: string) => db.prepare(`UPDATE routines SET next_run_at = ? WHERE id = ?`).run(Date.now() - 1000, id);
const routineChats = () => (db.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE routine_id IS NOT NULL`).get() as { n: number }).n;
const chatsBefore = conversations.list().length;
due(stuck.id);
scheduler.tick();
let ran = routines.get(stuck.id)!;
check(
  "due: the Lead gets a “schedule” signal with its name and prompt",
  posted.length === 1 &&
    posted[0]!.projectId === launch.id &&
    posted[0]!.signal.kind === "schedule" &&
    posted[0]!.signal.title === "Scheduled “Standup” (every weekday at 09:00)" &&
    posted[0]!.signal.detail === "Look at the board: what's stuck, what needs me?" &&
    posted[0]!.signal.taskId === null,
  JSON.stringify(posted),
);
check(
  "…no new chat; it ran in the Lead, and moves to its next time",
  routineChats() === 0 && conversations.list().length === chatsBefore && ran.lastConversationId === launchLead.id && ran.lastRunAt !== null && (ran.nextRunAt ?? 0) > Date.now(),
  JSON.stringify(ran),
);

// The wake it caused (a turn in the Lead begun after it ran) is still going at its next slot: skipped.
const wakeTurn = startRun(launchLead.id);
due(stuck.id);
scheduler.tick();
const skipped = routines.get(stuck.id)!;
check("while its last wake still runs, the next slot is skipped (and its last run's time kept)", posted.length === 1 && (skipped.nextRunAt ?? 0) > Date.now() && skipped.lastRunAt === ran.lastRunAt, JSON.stringify(skipped));
wakeTurn.end();
// A turn begun before the schedule last ran (the user's own) doesn't hold it back: the Lead hears it then or after.
const userTurn = startRun(launchLead.id);
await sleep(5);
res = await request<{ conversationId: string; runId: string }>("POST", `/routines/${stuck.id}/run`, {});
check("Run now (POST /routines/:id/run) posts too, and answers with the Lead", res.status === 200 && res.data.conversationId === launchLead.id && posted.length === 2, JSON.stringify(res.data));
due(stuck.id);
scheduler.tick();
check("…and a turn that began before it ran doesn't skip the next slot", posted.length === 3, `${posted.length} posted`);
userTurn.end();

// A schedule whose project has no Lead (yet, or any more): the Lead is opened, with the schedule's agent.
const quiet: Project = (await request<Project>("POST", "/projects", { kind: "none", name: "Quiet" })).data;
const orphan = routines.create(tot.id, { name: "Weekly", prompt: "Summarize the week.", schedule: { kind: "daily", time: "17:00", days: [5] }, projectId: quiet.id });
due(orphan.id);
scheduler.tick();
const quietLead = conversations.leadOf(quiet.id);
check(
  "a project without a Lead: its Lead is opened (with the schedule's agent), and gets the signal",
  quietLead !== null && conversations.get(quietLead)!.agentId === tot.id && posted.at(-1)?.projectId === quiet.id && routines.get(orphan.id)!.lastConversationId === quietLead,
  JSON.stringify(posted.at(-1)),
);
await request("DELETE", `/projects/${quiet.id}`);
const before = posted.length;
due(orphan.id);
scheduler.tick();
check("an archived project's schedule: skipped quietly", posted.length === before && (routines.get(orphan.id)!.nextRunAt ?? 0) > Date.now());
res = await request("POST", `/projects/${quiet.id}/schedules`, { name: "No", prompt: "x", schedule: weekdays });
check("…and none can be added to it (400)", res.status === 400, JSON.stringify(res.data));
res = await request("DELETE", `/projects/${launch.id}/schedules/${stuck.id}`);
check("DELETE removes it", res.status === 200 && routines.get(stuck.id) === null && routines.forProject(launch.id).length === 0);

// =============================================================================
// The first request: sent to the new project's Lead once the project is ready
// =============================================================================
console.log("\n# The first request");
const leadTurns = (leadId: string | null) => sent.filter((s) => s.conversationId === leadId);
res = await request<Project>("POST", "/projects", { kind: "none", name: "Docs", firstMessage: "  Write the README  ", agentId: tot.id });
const docs: Project = res.data;
check(
  "POST /projects with firstMessage: its Lead is opened (the agent named) and sent it as the user's own message",
  res.status === 201 &&
    docs.leadChatId !== null &&
    conversations.get(docs.leadChatId!)?.agentId === tot.id &&
    leadTurns(docs.leadChatId!).length === 1 &&
    leadTurns(docs.leadChatId!)[0]!.text === "Write the README" &&
    !leadTurns(docs.leadChatId!)[0]!.auto &&
    firstRequests.pending(docs.id) === null,
  JSON.stringify({ project: res.data, sent }),
);
await until(() => !runRegistry.activeFor(docs.leadChatId!));
res = await request("POST", "/projects", { kind: "none", name: "Too long", firstMessage: "x".repeat(9000) });
check("too long: 400, and no project is made", res.status === 400 && !(await request<Project[]>("GET", "/projects")).data.some((p: Project) => p.name === "Too long"), JSON.stringify(res.data));
res = await request<Project>("POST", "/projects", { kind: "none", name: "Blank", firstMessage: "   " });
check("blank: nothing sent, no Lead opened", res.status === 201 && res.data.leadChatId === null, JSON.stringify(res.data));

const site = join(HOME, "code/site");
makeRepo(site, { "index.html": "<h1>site</h1>\n" });
const sentBefore = sent.length;
res = await request<Project>("POST", "/projects", { kind: "folder", source: site, firstMessage: "Fix the footer", agentId: ivy.id });
const siteProject: Project = res.data;
check(
  "a folder not allowed yet: it waits (no Lead, nothing sent)",
  res.status === 201 && siteProject.leadChatId === null && sent.length === sentBefore && firstRequests.pending(siteProject.id) === "Fix the footer",
  JSON.stringify(res.data),
);
res = await request<Project>("POST", `/projects/${siteProject.id}/grant`, {});
await until(() => conversations.leadOf(siteProject.id) !== null && leadTurns(conversations.leadOf(siteProject.id)).length > 0);
const siteLead = conversations.leadOf(siteProject.id);
check(
  "…allowed: its Lead (the agent named) gets it, once",
  res.status === 200 && siteLead !== null && conversations.get(siteLead)!.agentId === ivy.id && leadTurns(siteLead).length === 1 && leadTurns(siteLead)[0]!.text === "Fix the footer" && firstRequests.pending(siteProject.id) === null,
  JSON.stringify(sent.slice(sentBefore)),
);
await until(() => !runRegistry.activeFor(siteLead!));
await request(`POST`, `/projects/${siteProject.id}/grant`, {});
await sleep(100);
check("…allowing it again sends nothing more", leadTurns(siteLead).length === 1);

firstRequests.useSender(async () => {
  throw new HttpError(400, "Connect ChatGPT or Claude in Settings first.");
});
res = await request<Project>("POST", "/projects", { kind: "none", name: "Offline", firstMessage: "Plan the offsite" });
const offline: Project = res.data;
const warning = offline.leadChatId ? notices(offline.leadChatId).at(-1) : undefined;
check(
  "can't be sent (no model): the project is made, and the Lead's chat keeps the request with why",
  res.status === 201 &&
    warning?.kind === "warning" &&
    warning.text === "Your first request wasn't sent: Connect ChatGPT or Claude in Settings first. It was: “Plan the offsite”",
  JSON.stringify({ project: res.data, warning }),
);
firstRequests.useSender(fakeSend);

// =============================================================================
// Pushing a fix to an open draft PR, through the Lead's card
// =============================================================================
if (!localSandboxed) {
  console.log("SKIP  pushing to a draft PR needs the macOS sandbox for the agent's computer; not here");
} else {
  console.log("\n# Pushing review fixes to a draft PR");
  const pc = await computerManager.ensure(tot.id);
  const workspace = realpathSync(pc.backend.home(pc.externalId));
  /** A path on the agent's computer ("~/projects/…") as a path here. */
  const local = (path: string) => (path.startsWith("~/") ? join(workspace, path.slice(2)) : path);
  // github.com/acme/web is a bare repo in the computer's home, and git is told to fetch and push that URL there.
  const bare = join(workspace, "remotes/web.git");
  const seed = join(OUTSIDE, "web-seed");
  makeRepo(seed, { "README.md": "web\n" });
  execFileSync("git", ["clone", "-q", "--bare", seed, bare], { env: GIT_ENV });
  execFileSync("git", ["config", "--file", join(workspace, ".gitconfig"), `url.${bare}.insteadOf`, "https://github.com/acme/web.git"], { env: GIT_ENV });
  await github.connect({ method: "token", token: TOKEN });
  await github.setAllowWrites(true);
  const web: Project = (await request<Project>("POST", "/projects", { kind: "github", source: "acme/web" })).data;
  const webLead: Conversation = (await request<Conversation>("POST", `/projects/${web.id}/lead`, { agentId: tot.id })).data;
  const webTools = await mcp(webLead.id);

  const created = tasks.create({ agentId: tot.id, projectId: web.id, goal: "Fix the footer" });
  const prepared = await prepareTask(taskStore.get(created.id)!);
  const worktree = local(prepared.worktree);
  const first = commit(worktree, { "footer.txt": "footer\n" }, "Fix the footer");
  taskStore.patch(created.id, { repo: { ...prepared, headSha: first } });
  taskStore.transition(created.id, "running");
  tasks.finish(created.id, "done", "Fixed the footer.");
  await until(() => taskStore.get(created.id)?.task.checks != null && !taskChecks.isRunning(created.id));
  const branch = prepared.branch;
  const onGitHub = () => git(bare, "rev-parse", branch);
  const setHead = (sha: string) => taskStore.patch(created.id, { repo: { ...taskStore.get(created.id)!.task.repo!, headSha: sha } });
  const answer = (id: string, decision: "accept" | "decline") => request<{ status: string; ok: boolean; text: string; error?: string }>("POST", `/lead/asks/${id}`, { decision });

  let turn = startRun(webLead.id);
  r = await webTools.call("task_land", { task_id: created.id, reason: "Fixes the footer." });
  let card = turn.card();
  let answered = await answer(card!.id, "accept");
  const opened = taskStore.get(created.id)!.task.landing;
  check(
    "first, it lands as a draft PR through the Lead's card",
    card?.message.startsWith("Open a draft PR for “Fix the footer” against main?") === true && answered.data.ok && opened?.kind === "pr" && opened.pr?.number === 12 && opened.sha === first && onGitHub() === first,
    JSON.stringify(answered.data),
  );
  r = await webTools.call("task_land", { task_id: created.id, reason: "Again." });
  check("nothing new on the branch: not asked (nothing to push)", r.isError && r.text.includes("Nothing new since draft PR #12 was pushed") && !turn.card(), r.text);

  // Review fixes: two commits on the branch, the task done again.
  commit(worktree, { "footer.txt": "footer, renamed\n" }, "Rename the footer class");
  const second = commit(worktree, { "footer.css": ".footer {}\n" }, "Style the footer");
  setHead(second);
  r = await webTools.call("task_land", { task_id: created.id, reason: "Addresses the review." });
  card = turn.card();
  check(
    "task_land on a draft PR with new commits: a card asks to push them",
    !r.isError &&
      r.text.startsWith("Asked the user on a card to push 2 new commits to draft PR #12.") &&
      card?.lead?.action === "push" &&
      card.lead.taskId === created.id &&
      card.message.startsWith("Push 2 new commits to draft PR #12?") &&
      card.message.includes(`${branch} @ ${second.slice(0, 7)} (“Fix the footer”)`) &&
      card.message.includes("- Style the footer\n- Rename the footer class") &&
      card.message.endsWith("Addresses the review."),
    `${r.text} ⏎ ${card?.message}`,
  );
  r = await webTools.call("task_land", { task_id: created.id, reason: "Again." });
  check("asking again for the same commit: no second card", !r.isError && r.text.includes("already") && turn.card()?.id === card!.id, r.text);
  answered = await answer(card!.id, "decline");
  check(
    "no: nothing is pushed",
    answered.data.status === "declined" && answered.data.text === "You said no: nothing was pushed to “Fix the footer”'s draft PR." && onGitHub() === first && taskStore.get(created.id)!.task.landing?.sha === first,
    JSON.stringify(answered.data),
  );

  await webTools.call("task_land", { task_id: created.id, reason: "Addresses the review." });
  card = turn.card();
  // The branch moves after the card went up: the card's head isn't the head any more.
  const third = commit(worktree, { "footer.txt": "footer, final\n" }, "Polish the footer");
  answered = await answer(card!.id, "accept");
  check(
    "yes, but the branch moved since the card: nothing is pushed, and the note says why",
    answered.status === 200 && !answered.data.ok && answered.data.text.includes("changed since you looked") && onGitHub() === first && notices(webLead.id).at(-1)?.kind === "warning",
    JSON.stringify(answered.data),
  );

  setHead(third);
  const landedAt = taskStore.get(created.id)!.task.landing!.at;
  await webTools.call("task_land", { task_id: created.id, reason: "Addresses the review." });
  card = turn.card();
  check("…asked again, at the new head", card?.message.startsWith("Push 3 new commits to draft PR #12?") === true, card?.message);
  answered = await answer(card!.id, "accept");
  const pushed = taskStore.get(created.id)!.task.landing;
  check(
    "yes: exactly the reviewed head goes to the PR's branch, no new PR, the landing keeps its PR and time",
    answered.data.ok &&
      answered.data.text === "Pushed 3 new commits to draft PR #12 for “Fix the footer”, as you approved." &&
      onGitHub() === third &&
      pulls.length === 1 &&
      pushed?.kind === "pr" &&
      pushed.pr?.number === 12 &&
      pushed.sha === third &&
      pushed.at === landedAt &&
      notices(webLead.id).at(-1)?.text === answered.data.text,
    JSON.stringify({ answer: answered.data, pushed }),
  );
  check("…and main on GitHub is untouched", git(bare, "rev-parse", "main") === git(seed, "rev-parse", "main"));

  const fourth = commit(worktree, { "notes.txt": "notes\n" }, "Add notes");
  setHead(fourth);
  await github.setAllowWrites(false);
  r = await webTools.call("task_land", { task_id: created.id, reason: "More." });
  check("GitHub writes off: not asked", r.isError && r.text.includes("Turn on GitHub writes") && !turn.card(), r.text);
  await github.setAllowWrites(true);
  taskStore.transition(created.id, "running");
  r = await webTools.call("task_land", { task_id: created.id, reason: "More." });
  check("a task that's working again: not asked yet", r.isError && r.text.includes("Wait for the task to finish") && !turn.card(), r.text);
  tasks.finish(created.id, "done", "Added notes.");
  // The branch rewritten under the PR (reset and committed again): TOT never force-pushes.
  git(worktree, "reset", "-q", "--hard", second);
  const rewritten = commit(worktree, { "other.txt": "other\n" }, "Another way");
  setHead(rewritten);
  r = await webTools.call("task_land", { task_id: created.id, reason: "Rewritten." });
  check("a rewritten branch: not asked (it would need a force push)", r.isError && r.text.includes("never force-pushes") && !turn.card() && onGitHub() === third, r.text);
  turn.end();
  await webTools.client.close();
}

// =============================================================================
// task_stop, task_pause, task_resume: any task in the project, no card
// =============================================================================
console.log("\n# The Lead controls tasks");
chatWakes.useBatchDelay(150);
chatWakes.start();
leadWakes.start();
const launchChat = conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Launch notes", projectId: launch.id });
const leadTools = await mcp(launchLead.id);
const chatTools = await mcp(launchChat.id);
const names = await leadTools.tools();
check("the Lead has task_stop, task_pause and task_resume", ["task_stop", "task_pause", "task_resume"].every((name) => names.includes(name)), names.join(", "));
const plain = await chatTools.tools();
check("a plain chat in the project doesn't", !plain.some((name) => ["task_stop", "task_pause", "task_resume"].includes(name)), plain.join(", "));

const draft = tasks.create({ agentId: tot.id, projectId: launch.id, goal: "Draft the announcement" });
r = await leadTools.call("task_pause", { task_id: draft.id });
check("task_pause: a queued task leaves the line", !r.isError && r.text.startsWith("Paused “Draft the announcement”.") && taskStore.get(draft.id)!.task.status === "paused", r.text);
r = await leadTools.call("task_pause", { task_id: draft.id });
check("…pausing it again: it's paused already", !r.isError && r.text.includes("paused already"), r.text);
r = await leadTools.call("task_resume", { task_id: draft.id });
check("task_resume: back in line", !r.isError && r.text.startsWith("Resumed “Draft the announcement”: queued") && taskStore.get(draft.id)!.task.status === "queued", r.text);

// A running task (its turn in flight), started from another chat in the project.
const running = tasks.create({ agentId: tot.id, parentId: launchChat.id, goal: "Collect the quotes" });
taskStore.transition(running.id, "running");
const runningTurn = startRun(running.id);
r = await leadTools.call("task_pause", { task_id: running.id });
check("pausing a running task stops its turn", !r.isError && taskStore.get(running.id)!.task.status === "paused" && runningTurn.run.controller.signal.aborted, r.text);
runningTurn.end();

sent.length = 0;
r = await leadTools.call("task_stop", { task_id: running.id, reason: "The quotes came in by email." });
const stopped = taskStore.get(running.id)!;
check(
  "task_stop: stopped, with the Lead's reason as its summary",
  !r.isError && r.text.startsWith("Stopped “Collect the quotes”.") && stopped.task.status === "stopped" && stopped.task.summary === "Stopped by the Lead: The quotes came in by email.",
  `${r.text} ⏎ ${stopped.task.summary}`,
);
const own = tasks.create({ agentId: tot.id, parentId: launchLead.id, goal: "Book the venue" });
r = await leadTools.call("task_stop", { task_id: own.id, reason: "Not needed." });
await sleep(600);
check(
  "…the chat that started it hears; the Lead (which knows) isn't woken by it",
  !r.isError &&
    notices(launchChat.id).some((n) => n.text === "“Collect the quotes” was stopped.") &&
    !sent.some((s) => s.conversationId === launchLead.id) &&
    !conversations.get(launchLead.id)!.childResults.includes(running.id) &&
    !conversations.get(launchLead.id)!.childResults.includes(own.id),
  JSON.stringify(sent),
);
r = await leadTools.call("task_stop", { task_id: running.id, reason: "Again." });
check("stopping it again: it isn't running", !r.isError && r.text.includes("isn't running"), r.text);
r = await leadTools.call("task_resume", { task_id: running.id });
check("task_resume picks a stopped task up again", !r.isError && taskStore.get(running.id)!.task.status === "queued", r.text);
const finished = tasks.create({ agentId: tot.id, projectId: launch.id, goal: "Pick a date" });
taskStore.transition(finished.id, "running");
tasks.finish(finished.id, "done", "Nov 12.");
r = await leadTools.call("task_resume", { task_id: finished.id });
check("…not a done one: that takes task_message with an instruction", r.isError && r.text.includes("task_message"), r.text);
r = await leadTools.call("task_pause", { task_id: finished.id });
check("pausing a finished task: refused", r.isError && r.text.includes("isn't running"), r.text);
const elsewhere = tasks.create({ agentId: tot.id, projectId: other.id, goal: "Another project's work" });
r = await leadTools.call("task_stop", { task_id: elsewhere.id, reason: "?" });
check("a task in another project: not found, not stopped", r.isError && r.text.includes("in this project") && taskStore.get(elsewhere.id)!.task.status === "queued", r.text);

await leadTools.client.close();
await chatTools.client.close();
chatWakes.stop();
leadWakes.stop();
server.close();
fakeServer.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
