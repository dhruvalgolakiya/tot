// Rewinding a chat: checkpoints of its workspace before a turn's first change (a commit on a private ref, the
// checkout's own index and branch untouched), rewinding to one of the user's messages (the messages going, the
// message coming back as a draft), putting the files back (new files gone, changed ones back, commits undone, ignored
// files kept), the provider session cut after the reply the chat now ends with, and what's refused. Real git and the
// real macOS sandbox in a temp HOME; a fake provider that calls TOT's tools mid-turn, no network.
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Conversation, Project, RewindPreview, RewindResponse } from "@tot/shared/types";

// A temp home in the repo's git-ignored .scratch (not the system temp folder, which sandboxed commands may write).
const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".scratch");
mkdirSync(SCRATCH, { recursive: true });
const HOME = realpathSync.native(mkdtempSync(join(SCRATCH, "home-")));
process.env.HOME = HOME;
process.on("exit", () => rmSync(HOME, { recursive: true, force: true }));
process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test
const PORT = 38_000 + Math.floor(Math.random() * 2000);

const { sendMessage } = await import("./agent/orchestrator.ts");
const { providers } = await import("./agent/providers/index.ts");
const { computerManager } = await import("./computer/manager.ts");
const { localSandboxed } = await import("./computer/local.ts");
const { MCP_TOKEN } = await import("./config.ts");
const { agents } = await import("./data/agents.ts");
const { conversations } = await import("./data/conversations.ts");
const { messages } = await import("./data/messages.ts");
const { settings } = await import("./data/settings.ts");
const { db } = await import("./db.ts");
const { createApp } = await import("./app.ts");
const { runEnd } = await import("./tasks/run-loop.ts");
type AgentProvider = import("./agent/providers/types.ts").AgentProvider;
type TurnInput = import("./agent/providers/types.ts").TurnInput;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 300)}` : ""}`);
}
const mascot = { shape: "blob" as const, color: "#60a5fa", accessory: "none" as const, eyes: "dots" as const };
settings.patch({ computer: { mode: "local" }, memory: { enabled: false } });

if (!localSandboxed) {
  console.log("SKIP  rewinding: no macOS sandbox here");
  process.exit(0);
}

/** What the fake model does in its next turn: a tool call through TOT's MCP server, and whether it reports a ref. */
type Step = { tool?: [chatId: string, name: string, args: Record<string, unknown>]; ref?: boolean; hold?: Promise<void> };
const steps: Step[] = [];
const turns: TurnInput[] = [];
const toolResults: string[] = [];
const fake: AgentProvider = {
  id: "claude",
  label: "Claude",
  status: async () => ({ id: "claude", label: "Claude", installed: true, loggedIn: true, models: [{ id: "claude:claude-opus-5-5", provider: "claude", model: "claude-opus-5-5", label: "Opus", available: true }] }),
  async *runTurn(input) {
    turns.push(input);
    const step = steps.shift() ?? {};
    yield { type: "session", sessionId: input.sessionId ?? `s-${randomUUID().slice(0, 8)}` };
    if (step.tool) toolResults.push(await callTool(...step.tool));
    if (step.hold) await step.hold;
    yield { type: "text-delta", blockId: "b1", delta: "Done." };
    if (step.ref !== false) yield { type: "ref", ref: `ref-${turns.length}` };
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
  },
  complete: async () => "A title",
};
providers.claude = fake;
async function turn(chatId: string, text: string, step: Step = {}): Promise<TurnInput> {
  steps.push(step);
  const { runId } = await sendMessage(chatId, { text });
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
const clients = new Map<string, Client>();
async function callTool(chatId: string, name: string, args: Record<string, unknown>): Promise<string> {
  let client = clients.get(chatId);
  if (!client) {
    client = new Client({ name: "tot-rewind-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp/${chatId}`), {
        requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
      }),
    );
    clients.set(chatId, client);
  }
  const result = await client.callTool({ name, arguments: args });
  return (result.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
const COMMIT = "git -c user.name=Agent -c user.email=a@example.com commit -qm";

const tot = agents.create({ name: "Tot", mascot });
await computerManager.ensure(tot.id);
const repo = join(HOME, "code/shop");
mkdirSync(repo, { recursive: true });
git(repo, "init", "-q", "-b", "main");
writeFileSync(join(repo, "notes.txt"), "hello\n");
writeFileSync(join(repo, ".gitignore"), "build/\n");
git(repo, "add", ".");
git(repo, "commit", "-qm", "init");
const init = git(repo, "rev-parse", "HEAD");
mkdirSync(join(repo, "build"));
writeFileSync(join(repo, "build/out.js"), "ignored\n");

const project: Project = (await request<Project>("POST", "/projects", { kind: "folder", source: repo, grant: true })).data;
const chat: Conversation = (await request<Conversation>("POST", "/conversations", { agentId: tot.id, projectId: project.id, workspace: "checkout" })).data;
const ids = () => messages.listByConversation(chat.id).map((m) => m.id);
const rows = () => db.prepare(`SELECT message_id, start_sha FROM chat_checkpoints WHERE conversation_id = ? ORDER BY created_at`).all(chat.id) as { message_id: string; start_sha: string }[];

// =============================================================================
console.log("\n# Checkpoints before a turn's first change");
await turn(chat.id, "Add the alpha file", { tool: [chat.id, "computer_write_file", { path: "alpha.txt", content: "one\n" }] });
check("the agent's write landed", read(join(repo, "alpha.txt")) === "one\n", toolResults.at(-1));
let list = rows();
const firstReply = messages.listByConversation(chat.id)[1]!.id;
check("the turn's workspace was checkpointed once, for its reply", list.length === 1 && list[0]!.message_id === firstReply, JSON.stringify(list));
check("…as a commit on a private ref, with HEAD as its parent", git(repo, "rev-parse", `refs/tot/checkpoints/${chat.id}/${firstReply}`) === list[0]!.start_sha && git(repo, "rev-parse", `${list[0]!.start_sha}^`) === init);
check("…holding the files from before the change", git(repo, "ls-tree", "--name-only", list[0]!.start_sha).split("\n").sort().join(",") === ".gitignore,notes.txt");
check("…without touching the checkout's index or branch", git(repo, "status", "--porcelain") === "?? alpha.txt" && git(repo, "rev-parse", "HEAD") === init, git(repo, "status", "--porcelain"));

await turn(chat.id, "Rework notes and commit", {
  tool: [chat.id, "computer_exec", { command: `echo more >> notes.txt && rm alpha.txt && echo new > beta.txt && mkdir -p src && echo s > src/s.txt && git add -A && ${COMMIT} agent && echo committed` }],
});
check("the agent changed files and committed", read(join(repo, "beta.txt")) === "new\n" && git(repo, "log", "-1", "--format=%s") === "agent", toolResults.at(-1));
await turn(chat.id, "Just answer this one");
list = rows();
check("a turn that touches no tools has no checkpoint", list.length === 2, JSON.stringify(list));
check("the second checkpoint holds the first turn's new file", git(repo, "show", `${list[1]!.start_sha}:alpha.txt`) === "one");

// =============================================================================
console.log("\n# Rewinding, with the files");
const [, , secondAsk] = ids();
let res: { status: number; data: any } = await request<RewindPreview>("GET", `/conversations/${chat.id}/rewind?messageId=${secondAsk}`);
check("the preview counts what goes and offers the files", res.status === 200 && res.data.messages === 4 && res.data.files === true, JSON.stringify(res.data));
res = await request<RewindPreview>("GET", `/conversations/${chat.id}/rewind?messageId=${ids()[1]}`);
check("only the user's messages can be rewound to", res.status === 400, JSON.stringify(res.data));
const sessionBefore = conversations.get(chat.id)!.providerSessionId;
const rewound = await request<RewindResponse>("POST", `/conversations/${chat.id}/rewind`, { messageId: secondAsk, restoreFiles: true });
check("rewinding works", rewound.status === 200 && rewound.data.filesRestored === true, JSON.stringify(rewound.data));
check("the message and everything after it are gone", ids().length === 2 && !ids().includes(secondAsk!), JSON.stringify(ids()));
check("its text comes back as a draft", rewound.data.draft?.text === "Rework notes and commit" && rewound.data.draft.attachments.length === 0);
check(
  "the files are as they were before that turn: new ones gone, deleted ones back",
  read(join(repo, "alpha.txt")) === "one\n" && read(join(repo, "beta.txt")) === null && !existsSync(join(repo, "src/s.txt")) && read(join(repo, "notes.txt")) === "hello\n",
  git(repo, "status", "--porcelain"),
);
check("…the commit is undone, the new file untracked again", git(repo, "rev-parse", "HEAD") === init && git(repo, "status", "--porcelain") === "?? alpha.txt", git(repo, "status", "--porcelain"));
check("…ignored files are left alone", read(join(repo, "build/out.js")) === "ignored\n");
check("…and what was there before the rewind is kept on a ref", git(repo, "show", `refs/tot/checkpoints/${chat.id}/before-rewind:beta.txt`) === "new");
await new Promise((resolve) => setTimeout(resolve, 300));
check(
  "the removed turns' checkpoints go, the kept one stays",
  rows().length === 1 && git(repo, "for-each-ref", "--format=%(refname:short)", `refs/tot/checkpoints/${chat.id}/`).split("\n").sort().join(",") === [`tot/checkpoints/${chat.id}/before-rewind`, `tot/checkpoints/${chat.id}/${firstReply}`].sort().join(","),
  git(repo, "for-each-ref", `refs/tot/checkpoints/${chat.id}/`),
);
check("the provider session is let go", sessionBefore !== null && conversations.get(chat.id)!.providerSessionId === null);
let input = await turn(chat.id, "Rework notes differently");
check(
  "the next turn carries on from a copy of the session, cut after the reply that's left",
  !input.sessionId && input.fork?.sessionId === sessionBefore && input.fork?.at === "ref-1" && input.prompt === "Rework notes differently",
  JSON.stringify({ sessionId: input.sessionId, fork: input.fork, prompt: input.prompt.slice(0, 200) }),
);
const forkedSession = conversations.get(chat.id)!.providerSessionId;
input = await turn(chat.id, "And then?");
check("…and after that resumes its own session", input.sessionId === forkedSession && !input.fork, JSON.stringify({ sessionId: input.sessionId, fork: input.fork }));

// =============================================================================
console.log("\n# Rewinding without the files, and the session");
writeFileSync(join(repo, "alpha.txt"), "kept\n");
await turn(chat.id, "No ref this time", { ref: false });
await turn(chat.id, "One more", { tool: [chat.id, "computer_write_file", { path: "gamma.txt", content: "g\n" }] });
const oneMore = ids().at(-2)!;
res = await request("POST", `/conversations/${chat.id}/rewind`, { messageId: oneMore });
check("rewinding without the files leaves them as they are", res.status === 200 && res.data.filesRestored === false && read(join(repo, "gamma.txt")) === "g\n" && read(join(repo, "alpha.txt")) === "kept\n");
input = await turn(chat.id, "Where were we?");
check(
  "a reply with no ref to cut at: a fresh session seeded with what's left",
  !input.sessionId && !input.fork && input.prompt.includes("Here is the conversation so far") && input.prompt.includes("No ref this time") && !input.prompt.includes("One more"),
  input.prompt.slice(0, 300),
);
res = await request("POST", `/conversations/${chat.id}/rewind`, { messageId: ids()[0] });
check("rewinding to the first message empties the chat", res.status === 200 && ids().length === 0 && conversations.get(chat.id)!.provider === null);
input = await turn(chat.id, "Start over");
check("…and its next turn starts afresh, with no transcript", !input.sessionId && !input.fork && input.prompt === "Start over", input.prompt.slice(0, 200));

// =============================================================================
console.log("\n# Refused");
let release!: () => void;
steps.push({ hold: new Promise<void>((resolve) => (release = resolve)) });
const { runId } = await sendMessage(chat.id, { text: "A long one" });
res = await request("POST", `/conversations/${chat.id}/rewind`, { messageId: ids()[0] });
check("while a reply runs", res.status === 409 && /Wait for the reply/.test(res.data.error ?? ""), JSON.stringify(res.data));
release();
await runEnd(runId);
res = await request("POST", `/conversations/${chat.id}/rewind`, { messageId: "nope" });
check("a message that isn't in the chat", res.status === 404);
res = await request("POST", `/conversations/${chat.id}/rewind`, {});
check("no message at all", res.status === 400);
// Files that can't go back keep the chat as it was.
await turn(chat.id, "Write delta", { tool: [chat.id, "computer_write_file", { path: "delta.txt", content: "d\n" }] });
const deltaAsk = ids().at(-2)!;
git(repo, "checkout", "-q", "--orphan", "elsewhere");
git(repo, "rm", "-rq", "--cached", ".");
git(repo, "commit", "-qm", "unrelated", "--allow-empty");
const before = ids().length;
res = await request("POST", `/conversations/${chat.id}/rewind`, { messageId: deltaAsk, restoreFiles: true });
check("files on a checkout that moved to other commits aren't put back", res.status === 409 && /other commits/.test(res.data.error ?? ""), JSON.stringify(res.data));
check("…and the chat isn't rewound", ids().length === before);

// =============================================================================
console.log("\n# A worktree chat");
git(repo, "checkout", "-qf", "main");
const wt: Conversation = (await request<Conversation>("POST", "/conversations", { agentId: tot.id, projectId: project.id, workspace: "worktree" })).data;
conversations.update(wt.id, { title: "Wt" });
await turn(wt.id, "Edit in the worktree", { tool: [wt.id, "computer_exec", { command: `echo wt >> notes.txt && echo x > x.txt && git add -A && ${COMMIT} wt` }] });
const tree = conversations.get(wt.id)!.workspace;
const worktree = tree?.mode === "worktree" ? tree.worktree! : "";
check("the agent changed its worktree", read(join(worktree, "x.txt")) === "x\n" && git(worktree, "log", "-1", "--format=%s") === "wt", toolResults.at(-1));
const wtAsk = messages.listByConversation(wt.id)[0]!.id;
res = await request("POST", `/conversations/${wt.id}/rewind`, { messageId: wtAsk, restoreFiles: true });
check(
  "rewinding puts its worktree and branch back, the main checkout untouched",
  res.status === 200 && read(join(worktree, "x.txt")) === null && read(join(worktree, "notes.txt")) === "hello\n" && git(worktree, "log", "-1", "--format=%s") === "init" && git(repo, "rev-parse", "main") === init,
  JSON.stringify(res.data),
);
check("deleting the chat drops its checkpoint refs", (await request("DELETE", `/conversations/${chat.id}`)).status === 200 && git(repo, "for-each-ref", `refs/tot/checkpoints/${chat.id}/`) === "");

for (const client of clients.values()) await client.close();
server.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
