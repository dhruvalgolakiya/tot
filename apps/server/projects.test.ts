// Projects (roadmap module 06): projects shared by every agent, chats filed in one project or none,
// the project section in an agent's prompt, and tasks that default to the project's repo.
// Fake providers behind the real turn pipeline; no real GitHub, Slack or model.
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import type { Conversation, Project, SendMessageRequest } from "@tot/shared/types";

const PORT = 8805;

const { sendMessage } = await import("./agent/orchestrator.ts");
const { providers } = await import("./agent/providers/index.ts");
const { agents } = await import("./data/agents.ts");
const { brains } = await import("./data/brains.ts");
const { conversations } = await import("./data/conversations.ts");
const { queueHolds } = await import("./data/queue-holds.ts");
const { settings } = await import("./data/settings.ts");
const { wiki } = await import("./data/wiki.ts");
const { createApp } = await import("./app.ts");
const { migrateRepoBrains, projects } = await import("./projects/projects.ts");
const { projectSection } = await import("./projects/prompt.ts");
const { runEnd } = await import("./tasks/run-loop.ts");
const { tasks } = await import("./tasks/tasks.ts");
type TurnInput = import("./agent/providers/types.ts").TurnInput;
type AgentProvider = import("./agent/providers/types.ts").AgentProvider;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 240)}` : ""}`);
}
const mascot = { shape: "blob" as const, color: "#60a5fa", accessory: "none" as const, eyes: "dots" as const };

settings.patch({ computer: { mode: "local" } });

// --- Fake providers, recording each turn's input ---------------------------------------------
const turns: TurnInput[] = [];
function fakeProvider(id: "claude" | "chatgpt", label: string, models: string[]): AgentProvider {
  return {
    id,
    label,
    status: async () => ({ id, label, installed: true, loggedIn: true, models: models.map((model) => ({ id: `${id}:${model}`, provider: id, model, label: model, available: true })) }),
    async *runTurn(input) {
      turns.push(input);
      yield { type: "session", sessionId: input.sessionId ?? `${id}-session-${randomUUID().slice(0, 8)}` };
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

const tot = agents.create({ name: "Tot", mascot });
const puddin = agents.create({ name: "Puddin", mascot });
// Tasks are created and filed here, never run: a held queue starts nothing (no clone from GitHub).
queueHolds.set(tot.id, null, "test");
queueHolds.set(puddin.id, null, "test");

// --- Creating projects ------------------------------------------------------------------------
console.log("\n# Creating projects");
let res: { status: number; data: any } = await request<Project>("POST", "/projects", { kind: "github", source: "https://github.com/acme/web.git" });
const web = res.data;
const webBrain = brains.get(web.brainId);
check(
  "a GitHub project from a URL: named after the repo, owner/name as its source, one shared repo brain",
  res.status === 201 && web.name === "web" && web.slug === "web" && web.kind === "github" && web.source === "acme/web" && webBrain?.kind === "repo" && webBrain.allAgents && webBrain.source === "https://github.com/acme/web",
  JSON.stringify({ status: res.status, web, webBrain }),
);
check("the same repo again is refused", (await request("POST", "/projects", { kind: "github", source: "acme/web" })).status === 409);
check("a login in the URL is refused", (await request("POST", "/projects", { kind: "github", source: "https://me:token@github.com/acme/x" })).status === 400);
check("a topic needs a name", (await request("POST", "/projects", { kind: "none" })).status === 400);
res = await request<Project>("POST", "/projects", { kind: "none", name: "Q4 launch!" });
const launch = res.data;
check("a topic project: its slug is its folder name, its brain a notes brain", res.status === 201 && launch.slug === "q4-launch" && brains.get(launch.brainId)?.kind === "notes", JSON.stringify(launch));
check("a second project with the same name gets its own slug and brain", (await request<Project>("POST", "/projects", { kind: "none", name: "Q4 launch" })).data.slug === "q4-launch-2");
check("a folder outside the home folder is refused", (await request("POST", "/projects", { kind: "folder", source: "/tmp" })).status === 400);
check("a folder that doesn't exist is refused", (await request("POST", "/projects", { kind: "folder", source: `~/no-such-folder-${randomUUID()}` })).status === 400);
check("an unknown kind is refused", (await request("POST", "/projects", { kind: "drive" })).status === 400);

// --- Chats in a project ------------------------------------------------------------------------
console.log("\n# Chats in a project");
res = await request<Conversation>("POST", "/conversations", { agentId: tot.id, projectId: web.id });
const chat = res.data;
check("a chat started in a project is filed there, and its new wiki pages go to the project's brain", res.status === 201 && chat.projectId === web.id && brains.focus(chat.id) === web.brainId, JSON.stringify(chat));
await request("PATCH", `/projects/${web.id}`, { instructions: "Use pnpm.\n\nNever touch billing/ without asking." });
let input = await turn(chat.id, { text: "Where is the checkout code?" });
check(
  "its agent gets the project section: where the repo is, the instructions, the brain and the one rule",
  input.systemPrompt.includes("# Project: web\n<project>\nGitHub acme/web · base branch is the repo's default · files at ~/projects/web\nInstructions: Use pnpm.\nNever touch billing/ without asking.") &&
    input.systemPrompt.includes("Look in ~/projects/web, but don't change it: start a task for any change.\nEach task gets its own branch (tot/…) and folder.\n</project>"),
  input.systemPrompt.slice(input.systemPrompt.indexOf("# Project"), input.systemPrompt.indexOf("# Project") + 500),
);
check("…and no note about moving, since it started there", !input.prompt.includes("[This chat is now in a project"));
input = await turn(chat.id, { text: "And the cart?" });
check("the next turn has no project note either", !input.prompt.includes("[This chat"), input.prompt.slice(0, 200));

wiki.update(wiki.overview(web.brainId).id, { content: "web is the storefront. Checkout lives in src/checkout." }, "user");
check("with an Overview, the section carries it", projectSection(projects.get(web.id)!).includes("Overview:\nweb is the storefront."));

// A chat that already talked, filed afterwards.
const loose = conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Loose" });
await turn(loose.id, { text: "Hi" });
res = await request<Conversation>("PATCH", `/conversations/${loose.id}`, { projectId: web.id });
check("moving a chat into a project files it", res.status === 200 && res.data.projectId === web.id, JSON.stringify(res.data));
input = await turn(loose.id, { text: "What's in this repo?" });
check(
  "its next turn hears about the project once, in the message, and its prompt now has the section",
  input.prompt.includes("[This chat is now in a project; this replaces any earlier project section:\n# Project: web") && input.systemPrompt.includes("# Project: web"),
  input.prompt.slice(0, 300),
);
input = await turn(loose.id, { text: "Thanks" });
check("…and not again", !input.prompt.includes("[This chat"));
await request("PATCH", `/projects/${web.id}`, { instructions: "Use npm." });
input = await turn(loose.id, { text: "Run the tests" });
check("changed instructions reach chats already in the project, once", input.prompt.includes("Instructions: Use npm.") && input.systemPrompt.includes("Instructions: Use npm."), input.prompt.slice(0, 300));
await request("PATCH", `/conversations/${loose.id}`, { projectId: null });
input = await turn(loose.id, { text: "Something else" });
check("moving it out says so, and the section leaves its prompt", input.prompt.includes("[This chat is no longer in a project") && !input.systemPrompt.includes("# Project:"), input.prompt.slice(0, 200));

check("a chat can't be filed in a project that doesn't exist", (await request("PATCH", `/conversations/${loose.id}`, { projectId: "nope" })).status === 404);

// --- Tasks in a project -------------------------------------------------------------------------
console.log("\n# Tasks in a project");
const task = tasks.create({ agentId: tot.id, parentId: chat.id, goal: "Fix the flaky checkout test" });
check(
  "a task started from a project chat is in the project and works on its repo, without being given one",
  task.projectId === web.id && task.task.repo?.source === "acme/web" && task.task.repo.branch.startsWith("tot/") && task.task.repo.folder === "~/projects/web" && task.task.repo.worktree.startsWith("~/projects/web/.tot-worktrees/tot-"),
  JSON.stringify(task.task.repo),
);
const other = tasks.create({ agentId: tot.id, parentId: chat.id, goal: "Something else", repo: "acme/api" });
check("in a project with code, a task's repo is always the project's", other.task.repo?.source === "acme/web", JSON.stringify(other.task.repo));
await request("PATCH", `/projects/${web.id}`, { defaultBranch: "develop" });
const third = tasks.create({ agentId: tot.id, parentId: chat.id, goal: "Third" });
check("the project's base branch is where tasks start", third.task.repo?.baseBranch === "develop", JSON.stringify(third.task.repo));
const topicChat = conversations.create({ agentId: tot.id, modelId: tot.modelId, projectId: launch.id });
const research = tasks.create({ agentId: tot.id, parentId: topicChat.id, goal: "Research launch dates" });
check("a task in a topic project has no repo", research.projectId === launch.id && research.task.repo === null);

res = await request("PATCH", `/conversations/${task.id}`, { projectId: launch.id });
check("a task can't be moved on its own", res.status === 400);
res = await request<Conversation>("PATCH", `/conversations/${chat.id}`, { projectId: launch.id });
check("moving a chat takes its tasks along", conversations.get(task.id)?.projectId === launch.id && conversations.get(other.id)?.projectId === launch.id);
await request("PATCH", `/conversations/${chat.id}`, { projectId: web.id });

// --- Shared by every agent ------------------------------------------------------------------------
console.log("\n# Every agent");
const puddinChat = (await request<Conversation>("POST", "/conversations", { agentId: puddin.id, projectId: web.id })).data;
const inWeb = conversations.inProject(web.id).map((c) => c.agentId);
check("chats from two agents are in the same project", inWeb.includes(tot.id) && inWeb.includes(puddin.id) && puddinChat.projectId === web.id);
const listed = (await request<Project[]>("GET", "/projects")).data.find((p) => p.id === web.id);
check("the project list counts its chats and tasks", listed?.chats === conversations.inProject(web.id).length, JSON.stringify(listed));
const forked = (await request<Conversation>("POST", `/conversations/${chat.id}/fork`)).data;
check("a fork stays in its chat's project", forked?.projectId === web.id, JSON.stringify(forked));

// --- Archiving, and settings --------------------------------------------------------------------------
console.log("\n# Archiving");
res = await request<Project>("PATCH", `/projects/${launch.id}`, { intake: { slackChannels: ["Launch-Team", "#bad channel"], linearTeams: ["mkt", "x y"] } });
check("intake keeps valid channels and team keys", JSON.stringify(res.data.intake) === JSON.stringify({ slackChannels: ["#launch-team"], linearTeams: ["MKT"] }), JSON.stringify(res.data.intake));
check("a bad branch name is refused", (await request("PATCH", `/projects/${web.id}`, { defaultBranch: "a b" })).status === 400);
res = await request<Project>("PATCH", `/projects/${launch.id}`, { name: "Q4 big launch" });
check("renaming keeps its folder name (the slug)", res.data.name === "Q4 big launch" && res.data.slug === "q4-launch");
await request("DELETE", `/projects/${launch.id}`);
const active = (await request<Project[]>("GET", "/projects")).data.map((p) => p.id);
const archived = (await request<Project[]>("GET", "/projects?archived=1")).data.map((p) => p.id);
check("an archived project leaves the list, and is listed with ?archived=1", !active.includes(launch.id) && archived.includes(launch.id));
check("its chats stay filed under it", conversations.get(topicChat.id)?.projectId === launch.id);
check("new chats can't start in it", (await request("POST", "/conversations", { agentId: tot.id, projectId: launch.id })).status === 400);

// --- Repo brains from before projects ---------------------------------------------------------------
console.log("\n# Migration");
const apiBrain = brains.create({ name: "api", kind: "repo", source: "https://github.com/acme/api" });
brains.create({ name: "scratch", kind: "repo", source: "~/repos/scratch" });
migrateRepoBrains();
migrateRepoBrains();
const migrated = projects.list().filter((p) => p.brainId === apiBrain.id);
check(
  "a repo brain from GitHub becomes one GitHub project (twice run, still one), shared with every agent",
  migrated.length === 1 && migrated[0]!.source === "acme/api" && migrated[0]!.name === "api" && brains.get(apiBrain.id)!.allAgents,
  JSON.stringify(migrated),
);
check("a brain learned from a folder on an agent's computer doesn't", !projects.list().some((p) => p.name === "scratch"));
res = await request<Project>("POST", "/projects", { kind: "github", source: "acme/billing" });
const billingBrain = brains.create({ name: "billing-notes", kind: "repo", source: "https://github.com/acme/billing" });
check("a project made before its repo was learned keeps its own brain", res.data.brainId !== billingBrain.id);

server.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
