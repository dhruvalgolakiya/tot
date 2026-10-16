// Where a chat works (like T3 Code's thread target): a new chat in a code project picks its main checkout or a
// worktree of its own. Covers the request's checks, the folder grants and the real macOS sandbox for each mode,
// making the worktree on the first turn (once), the prompt, deleting the chat, and the cleanup sweep leaving chat
// worktrees alone. Real git in a temp HOME; fake providers, no network.
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Conversation, Project, SendMessageRequest } from "@tot/shared/types";

// A temp home in the repo's git-ignored .scratch (not the system temp folder, which sandboxed commands may write).
const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".scratch");
mkdirSync(SCRATCH, { recursive: true });
const HOME = realpathSync.native(mkdtempSync(join(SCRATCH, "home-")));
process.env.HOME = HOME;
process.on("exit", () => rmSync(HOME, { recursive: true, force: true }));
process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test
const PORT = 36_000 + Math.floor(Math.random() * 2000);

const { sendMessage } = await import("./agent/orchestrator.ts");
const { providers } = await import("./agent/providers/index.ts");
const { chatWorkspaces } = await import("./chats/workspace.ts");
const { computerManager } = await import("./computer/manager.ts");
const { localSandboxed } = await import("./computer/local.ts");
const { MCP_TOKEN } = await import("./config.ts");
const { agents } = await import("./data/agents.ts");
const { conversations } = await import("./data/conversations.ts");
const { settings } = await import("./data/settings.ts");
const { createApp } = await import("./app.ts");
const { grantFor } = await import("./projects/checkout.ts");
const { projects } = await import("./projects/projects.ts");
const { projectSection } = await import("./projects/prompt.ts");
const { runEnd } = await import("./tasks/run-loop.ts");
const { worktreeCleanup } = await import("./worktrees/cleanup.ts");
type AgentProvider = import("./agent/providers/types.ts").AgentProvider;
type TurnInput = import("./agent/providers/types.ts").TurnInput;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 300)}` : ""}`);
}
const mascot = { shape: "blob" as const, color: "#60a5fa", accessory: "none" as const, eyes: "dots" as const };
settings.patch({ computer: { mode: "local" }, memory: { enabled: false } });

const turns: TurnInput[] = [];
const fake: AgentProvider = {
  id: "claude",
  label: "Claude",
  status: async () => ({ id: "claude", label: "Claude", installed: true, loggedIn: true, models: [{ id: "claude:claude-opus-5-5", provider: "claude", model: "claude-opus-5-5", label: "Opus", available: true }] }),
  async *runTurn(input) {
    turns.push(input);
    yield { type: "session", sessionId: input.sessionId ?? `s-${randomUUID().slice(0, 8)}` };
    yield { type: "text-delta", blockId: "b1", delta: "Done." };
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
  },
  complete: async () => "A title",
};
providers.claude = fake;
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
const clients: Client[] = [];
async function mcp(conversationId: string) {
  const client = new Client({ name: "tot-chat-workspace-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp/${conversationId}`), {
      requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
    }),
  );
  clients.push(client);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: Boolean(result.isError), text: (result.content as { text?: string }[]).map((c) => c.text ?? "").join("\n") };
  };
}
const stdout = (text: string) => /--- stdout ---\n([\s\S]*?)(?:\n--- stderr ---|$)/.exec(text)?.[1]?.trim() ?? "";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
function makeRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  writeFileSync(join(path, "notes.txt"), "hello\n");
  git(path, "add", ".");
  git(path, "commit", "-qm", "init");
}
/** A commit made by the agent, in the sandbox (its computer has no git identity of its own). */
const COMMIT = "git -c user.name=Agent -c user.email=a@example.com commit -qm";

const tot = agents.create({ name: "Tot", mascot });
await computerManager.ensure(tot.id);
const meet = join(HOME, "code/meet");
makeRepo(meet);
const plain = join(HOME, "code/plain");
mkdirSync(plain, { recursive: true });
writeFileSync(join(plain, "a.txt"), "a\n");

let res: { status: number; data: any } = await request<Project>("POST", "/projects", { kind: "folder", source: meet, grant: true });
const meetProject: Project = res.data;
res = await request<Project>("POST", "/projects", { kind: "folder", source: plain, grant: true });
const plainProject: Project = res.data;
res = await request<Project>("POST", "/projects", { kind: "none", name: "Launch" });
const topic: Project = res.data;

// =============================================================================
console.log("\n# Creating a chat with a workspace");
const create = (body: Record<string, unknown>) => request<Conversation>("POST", "/conversations", { agentId: tot.id, ...body });
check("a workspace without a project is refused", (await create({ workspace: "checkout" })).status === 400);
check("…and in a topic project", (await create({ projectId: topic.id, workspace: "worktree" })).status === 400);
check("…and one that isn't checkout or worktree", (await create({ projectId: meetProject.id, workspace: "elsewhere" })).status === 400);
res = await create({ projectId: plainProject.id, workspace: "worktree" });
check("a new worktree needs a git repo", res.status === 400 && /git repo/.test(JSON.stringify(res.data)), JSON.stringify(res.data));
check("…but a folder without git can still be the main checkout", (await create({ projectId: plainProject.id, workspace: "checkout" })).status === 201);
res = await create({ projectId: meetProject.id, workspace: "checkout" });
const checkoutChat: Conversation = res.data;
check("a checkout chat is stored as such", res.status === 201 && checkoutChat.workspace?.mode === "checkout", JSON.stringify(checkoutChat.workspace));
res = await create({ projectId: meetProject.id, workspace: "worktree" });
const worktreeChat: Conversation = res.data;
check(
  "a worktree chat is stored, its worktree not made yet",
  res.status === 201 && worktreeChat.workspace?.mode === "worktree" && !worktreeChat.workspace.created && worktreeChat.workspace.branch === null,
  JSON.stringify(worktreeChat.workspace),
);
const legacy = conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Old", projectId: meetProject.id });
check("a chat from before has no workspace", (await request("GET", `/conversations/${legacy.id}`)).data.conversation.workspace === undefined);
check(
  "a chat that works in the project's files stays in the project",
  (await request("PATCH", `/conversations/${checkoutChat.id}`, { projectId: null })).status === 400 && conversations.get(checkoutChat.id)!.projectId === meetProject.id,
);

// =============================================================================
console.log("\n# Grants");
const legacyGrant = grantFor(conversations.get(legacy.id)!);
check("a chat from before only reads the folder", legacyGrant?.folder === meet && !legacyGrant.write && !legacyGrant.task, JSON.stringify(legacyGrant));
const checkoutGrant = grantFor(conversations.get(checkoutChat.id)!);
check("a checkout chat may write the folder", checkoutGrant?.folder === meet && checkoutGrant.write === true && !checkoutGrant.task, JSON.stringify(checkoutGrant));
const unnamed = grantFor(conversations.get(worktreeChat.id)!);
check("a worktree chat before its first turn only reads", unnamed?.folder === meet && !unnamed.write && !unnamed.task, JSON.stringify(unnamed));

// =============================================================================
console.log("\n# The worktree, made on the first turn");
conversations.update(worktreeChat.id, { title: "Fix login" });
projects.update(meetProject.id, { setupCommand: "echo ready > setup-ran.txt" });
// Two turns' preparations at once: one worktree.
const [first, second] = await Promise.all([
  chatWorkspaces.prepare(conversations.get(worktreeChat.id)!, "fix it"),
  chatWorkspaces.prepare(conversations.get(worktreeChat.id)!, "fix it"),
]);
const made = conversations.get(worktreeChat.id)!.workspace;
const tree = made?.mode === "worktree" ? made : null;
check(
  "the first turn makes tot/<title>-<4 hex> in <repo>/.tot-worktrees",
  Boolean(tree?.created && /^tot\/fix-login-[0-9a-f]{4}$/.test(tree.branch ?? "") && tree.worktree === `${meet}/.tot-worktrees/${tree.branch!.replace(/\//g, "-")}` && tree.baseBranch === "main"),
  JSON.stringify(made),
);
check("…in the user's repo, on its own branch", Boolean(tree && existsSync(join(tree.worktree!, "notes.txt")) && git(meet, "branch", "--list", tree.branch!).includes(tree.branch!)));
check("…once, though two turns asked at the same time", git(meet, "worktree", "list").split("\n").length === 2 && !first.notice && !second.notice, git(meet, "worktree", "list"));
check("…with the project's setup run in it", Boolean(tree && readFileSync(join(tree.worktree!, "setup-ran.txt"), "utf8").trim() === "ready"));
projects.update(meetProject.id, { setupCommand: "" });
const again = await turn(worktreeChat.id, { text: "Now the header" });
const after = conversations.get(worktreeChat.id)!.workspace;
check("a later turn keeps the same worktree", JSON.stringify(after) === JSON.stringify(made) && git(meet, "worktree", "list").split("\n").length === 2);
check("its prompt says where it works", again.systemPrompt.includes(`You work in your own worktree ${tree?.worktree} on branch ${tree?.branch}`), again.systemPrompt.slice(-800));
const worktreeGrant = grantFor(conversations.get(worktreeChat.id)!);
check("…and its grant is a task's: its branch and worktree", worktreeGrant?.task?.branch === tree?.branch && !worktreeGrant?.write, JSON.stringify(worktreeGrant));

// =============================================================================
console.log("\n# Prompt sections");
const project = projects.get(meetProject.id)!;
check("a chat from before: look, don't change", projectSection(project).includes("but don't change it: start a task for any change"));
check(
  "a checkout chat works in the main checkout",
  projectSection(project, { workspace: { mode: "checkout" } }).includes(`You work directly in ${meet} (the user's main checkout): change files there when asked; small, careful changes; for big or parallel work start a task.`),
);
check(
  "a worktree chat works only in its worktree",
  projectSection(project, { workspace: tree }).includes(`change files only there; the main checkout (${meet}) is read-only.`),
);
check("a task's section is unchanged by a workspace", projectSection(project, { inTask: true, workspace: { mode: "checkout" } }).includes("You're one task in this project"));

// =============================================================================
if (!localSandboxed) {
  console.log("SKIP  the sandbox for each mode: no macOS sandbox here");
} else {
  console.log("\n# The sandbox, for each mode");
  const inLegacy = await mcp(legacy.id);
  let r = await inLegacy("computer_exec", { command: `echo no > ${meet}/legacy.txt` });
  check("a chat from before can't write the folder", !existsSync(join(meet, "legacy.txt")), r.text);
  r = await inLegacy("computer_write_file", { path: `${meet}/legacy.txt`, content: "no" });
  check("…and is told to start a task", r.isError && r.text.includes("read-only in a chat; start a task"), r.text);

  const inCheckout = await mcp(checkoutChat.id);
  r = await inCheckout("computer_exec", { command: "pwd" });
  check("a checkout chat's commands start in the folder", stdout(r.text) === meet, r.text);
  r = await inCheckout("computer_exec", { command: `echo edited >> notes.txt && git add notes.txt && ${COMMIT} edit && git log -1 --format=%s` });
  check("…it changes files and commits there", stdout(r.text) === "edit" && readFileSync(join(meet, "notes.txt"), "utf8").includes("edited"), r.text);
  r = await inCheckout("computer_write_file", { path: "added.txt", content: "new\n" });
  check("…relative paths are in the folder", !r.isError && readFileSync(join(meet, "added.txt"), "utf8") === "new\n", r.text);
  const config = readFileSync(join(meet, ".git/config"), "utf8");
  r = await inCheckout("computer_exec", { command: "echo '[alias] x = !touch /tmp/pwned' >> .git/config; mkdir -p .git/hooks && echo 'touch /tmp/pwned' > .git/hooks/pre-commit; echo bad > .tot-worktrees/meddle.txt; true" });
  check(
    "…but not git's config, hooks or TOT's worktrees",
    readFileSync(join(meet, ".git/config"), "utf8") === config && !existsSync(join(meet, ".git/hooks/pre-commit")) && !existsSync(join(meet, ".tot-worktrees/meddle.txt")),
    r.text,
  );
  r = await inCheckout("computer_write_file", { path: `${meet}/.git/config`, content: "x" });
  check("…and a refused write says what's read-only", r.isError && r.text.includes("git's config and hooks"), r.text);
  r = await inCheckout("computer_exec", { command: `echo out > ${HOME}/outside.txt; true` });
  check("…nor anything outside the folder", !existsSync(join(HOME, "outside.txt")), r.text);

  const inWorktree = await mcp(worktreeChat.id);
  r = await inWorktree("computer_exec", { command: `pwd && echo work > work.txt && git add work.txt && ${COMMIT} work && echo main > ${meet}/main-edit.txt; true` });
  check("a worktree chat's commands start in its worktree, and commit there", stdout(r.text).startsWith(tree!.worktree!) && existsSync(join(tree!.worktree!, "work.txt")), r.text);
  check("…while the main checkout stays read-only", !existsSync(join(meet, "main-edit.txt")));
  check("…and its commit is on its branch only", git(meet, "log", "-1", "--format=%s", tree!.branch!) === "work" && git(meet, "log", "-1", "--format=%s", "main") === "edit");
}

// =============================================================================
console.log("\n# Cleanup and deleting");
const swept = await worktreeCleanup.run({ days: 1, now: Date.now() + 30 * 86_400_000 });
check("the cleanup sweep leaves a chat's worktree alone", swept.removed === 0 && existsSync(tree!.worktree!));

// A second worktree chat with no commits of its own: deleting it takes its branch too.
res = await create({ projectId: meetProject.id, workspace: "worktree" });
const idle: Conversation = res.data;
conversations.update(idle.id, { title: "Idle" });
await chatWorkspaces.prepare(conversations.get(idle.id)!, "nothing");
const idleTree = conversations.get(idle.id)!.workspace;
const idleBranch = idleTree?.mode === "worktree" ? idleTree.branch! : "";
check("a second worktree chat gets its own branch", /^tot\/idle-[0-9a-f]{4}$/.test(idleBranch) && idleBranch !== tree!.branch, idleBranch);
check("deleting it works", (await request("DELETE", `/conversations/${idle.id}`)).status === 200);
check("…and takes its worktree and its branch, which had nothing of its own", idleTree?.mode === "worktree" && !existsSync(idleTree.worktree!) && !git(meet, "branch", "--list", idleBranch));

check("deleting the chat with commits works", (await request("DELETE", `/conversations/${worktreeChat.id}`)).status === 200);
check(
  "…its worktree goes, its branch with the commit stays",
  !existsSync(tree!.worktree!) && git(meet, "branch", "--list", tree!.branch!).includes(tree!.branch!) && !conversations.get(worktreeChat.id),
);
check("deleting a checkout chat leaves the folder as it is", (await request("DELETE", `/conversations/${checkoutChat.id}`)).status === 200 && existsSync(join(meet, "notes.txt")));

for (const client of clients) await client.close();
server.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
