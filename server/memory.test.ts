// Memory repo (roadmap module 10): memory as git repos of markdown. The one-time import of the old memories
// table, the entry format, tools and routes writing one commit each, secrets refused, project memory, the
// first-turn prompt, parallel writers, history and undo, the backup remote (a local bare repo) and Dreaming
// (a fake model). Device sync, with two TOTs, is in memory-sync.test.ts.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/memory.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// --- Before TOT starts: a database from before module 10, with memories in the old table -------------------------
const dataDir = process.env.TOT_DATA_DIR!;
const oldDb = new DatabaseSync(join(dataDir, "tot.db"));
oldDb.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT NOT NULL, conversation_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, agent_id TEXT)`);
const seed = oldDb.prepare(`INSERT INTO memories (id, content, source, conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
const day = Date.UTC(2026, 3, 1, 12);
seed.run(randomUUID(), "Lives in Berlin and works in UTC+1", "user", null, day, day);
seed.run(randomUUID(), "Prefers TypeScript over Python", "agent", "chat-from-before", day + 1, day + 1);
seed.run(randomUUID(), "Their Anthropic key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123", "agent", null, day + 2, day + 2);
for (let n = 0; n < 50; n++) {
  seed.run(randomUUID(), `Old fact number ${n} about the user's habits, padded out to make the import overflow its file`, "agent", null, day + 10 + n, day + 10 + n);
}
oldDb.close();

const { serve } = await import("@hono/node-server");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { MCP_TOKEN, setSecret } = await import("./config.ts");
const { db } = await import("./db.ts");
const { agents } = await import("./data/agents.ts");
const { conversations } = await import("./data/conversations.ts");
const { memories } = await import("./data/memories.ts");
const { settings } = await import("./data/settings.ts");
const { providers } = await import("./agent/providers/index.ts");
const { sendMessage } = await import("./agent/orchestrator.ts");
const { runEnd } = await import("./tasks/run-loop.ts");
const { createApp } = await import("./app.ts");
const { projects } = await import("./projects/projects.ts");
const { migrateMemories } = await import("./memory/migrate.ts");
const { reindexAll } = await import("./memory/index.ts");
const { remember, SECRET_REFUSAL, undo } = await import("./memory/memory.ts");
const repo = await import("./memory/repo.ts");
const { syncRemote } = await import("./memory/sync.ts");
const { dream, checkOps } = await import("./memory/dreaming.ts");
type AgentProvider = import("./agent/providers/types.ts").AgentProvider;
type TurnInput = import("./agent/providers/types.ts").TurnInput;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 240)}` : ""}`);
}
const mascot = { shape: "blob" as const, color: "#60a5fa", accessory: "none" as const, eyes: "dots" as const };
const youDir = repo.repoDir("you");
const g = (dir: string, ...args: string[]) => repo.git(dir, args);
const commits = async (dir = youDir) => Number((await g(dir, "rev-list", "--count", "HEAD")).trim());
const file = (path: string, dir = youDir) => (existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : "");
const todayStr = repo.today();

settings.patch({ computer: { mode: "local" }, memory: { enabled: true } });

// --- Fake providers (a turn records its system prompt) ------------------------------------------------------------
const turns: TurnInput[] = [];
function fakeProvider(id: "claude" | "chatgpt", label: string): AgentProvider {
  return {
    id,
    label,
    status: async () => ({ id, label, installed: true, loggedIn: true, models: [{ id: `${id}:m`, provider: id, model: "m", label: "m", available: true }] }),
    async *runTurn(input) {
      turns.push(input);
      yield { type: "session", sessionId: input.sessionId ?? `${id}-${randomUUID().slice(0, 8)}` };
      yield { type: "text-delta", blockId: "b1", delta: "Done." };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    },
    complete: async () => "A title",
  };
}
providers.claude = fakeProvider("claude", "Claude");
providers.chatgpt = fakeProvider("chatgpt", "ChatGPT");

const PORT = 19_000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const server = serve({ fetch: createApp().fetch, port: PORT, hostname: "127.0.0.1" });
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, text };
};

/** An MCP client on one chat's tools. */
async function toolsFor(conversationId: string) {
  const client = new Client({ name: "tot-memory-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${conversationId}`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } }));
  return {
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return { text: (result.content as { text?: string }[]).map((c) => c.text ?? "").join("\n"), isError: Boolean(result.isError) };
    },
    close: () => client.close(),
  };
}
const idIn = (text: string) => /\(([0-9a-f]{6}|h[0-9a-f]{5})\)/.exec(text)?.[1] ?? "";

const kiwi = agents.create({ name: "Kiwi", mascot });
const chat = conversations.create({ agentId: kiwi.id, modelId: "auto" });
const tempDirs: string[] = [];

try {
  // --- M1 · The one-time import --------------------------------------------------------------------------------
  console.log("\n# Importing the old memories (once)");
  check("the old rows moved aside, the table became an index", (db.prepare(`SELECT COUNT(*) AS n FROM memories_legacy`).get() as { n: number }).n === 53);
  const imported = await migrateMemories();
  check("old memories become entries in the you repo, secrets left out", imported === 52, String(imported));
  const main = file("MEMORY.md");
  check("MEMORY.md stays under ~3500 characters, the rest goes to notes.md", main.length <= 3500 && file("notes.md").includes("Old fact number 49"), String(main.length));
  check("MEMORY.md links notes.md", main.includes("[[notes]]"));
  check("the first entry has the spec's metadata", new RegExp(`^- Lives in Berlin and works in UTC\\+1 \\[id: [0-9a-f]{6}; source: you; added: 2026-04-0[12]\\]$`, "m").test(main), main.slice(0, 300));
  check("an agent's memory names the chat it came from", /Prefers TypeScript over Python \[id: [0-9a-f]{6}; source: tot:\/\/c\/chat-from-before;/.test(main));
  check("the secret never reached a file", !main.includes("sk-ant-") && !file("notes.md").includes("sk-ant-"));
  const log = await g(youDir, "log", "--format=%s");
  check("one commit: the deterministic start, then the import", log.trim().split("\n").length === 2 && log.startsWith("Imported 52 memories"), log);
  check("the import commit says what it left out", (await g(youDir, "log", "-1", "--format=%b")).includes("Left out 1 that looked like a secret"));
  check("the .gitattributes merges markdown by union", file(".gitattributes").trim() === "*.md merge=union");
  const before = await commits();
  check("running it again does nothing", (await migrateMemories()) === 0 && (await commits()) === before);
  reindexAll();
  check("the index is rebuilt from the files", memories.list("you").length === 52 && memories.search("Berlin", { repos: ["you"] })[0]?.path === "MEMORY.md");
  check("the old table is kept, untouched", (db.prepare(`SELECT COUNT(*) AS n FROM memories_legacy`).get() as { n: number }).n === 53);

  // --- M1 · Tools through the files ----------------------------------------------------------------------------
  console.log("\n# Tools write the files, one commit each");
  const tools = await toolsFor(chat.id);
  let n = await commits();
  let r = await tools.call("memory_save", { content: "Prefers pnpm over npm" });
  const pnpmId = idIn(r.text);
  check("memory_save saves an entry", !r.isError && r.text.startsWith("Saved to memory") && /^[0-9a-f]{6}$/.test(pnpmId), r.text);
  check("…into the file, in the spec's format", file("notes.md").includes(`- Prefers pnpm over npm [id: ${pnpmId}; source: tot://c/${chat.id}; added: ${todayStr}]`), r.text);
  check("…as one commit by the agent", (await commits()) === n + 1 && (await g(youDir, "log", "-1", "--format=%s")).trim() === "Kiwi: remember Prefers pnpm over npm");
  r = await tools.call("memory_save", { content: "prefers PNPM over npm" });
  check("the same fact twice is already remembered (no commit)", r.text.startsWith("Already remembered") && (await commits()) === n + 1, r.text);
  r = await tools.call("memory_search", { query: "pnpm" });
  check("memory_search finds it, with its file", r.text.includes(`(${pnpmId}) Prefers pnpm over npm — you/notes.md`), r.text);
  n = await commits();
  r = await tools.call("memory_update", { id: pnpmId, content: "Prefers pnpm; never npm" });
  check("memory_update rewrites the line, same id, one commit", !r.isError && file("notes.md").includes(`- Prefers pnpm; never npm [id: ${pnpmId};`) && (await commits()) === n + 1, r.text);
  check("…and the index follows", memories.get(pnpmId, ["you"])?.content === "Prefers pnpm; never npm");
  r = await tools.call("memory_delete", { id: pnpmId });
  check("memory_delete removes the line, one commit", !r.isError && !file("notes.md").includes(pnpmId) && (await commits()) === n + 2 && !memories.get(pnpmId), r.text);
  r = await tools.call("memory_save", { content: "Has a dog called Pixel", file: "people" });
  check("a topic file is made and linked from MEMORY.md", file("people.md").startsWith("# People\n") && file("MEMORY.md").includes("[[people]]"), r.text);
  r = await tools.call("memory_read", { path: "[[people]]" });
  check("memory_read follows a [[link]]", !r.isError && r.text.startsWith("you/people.md") && r.text.includes("Pixel"), r.text);
  r = await tools.call("memory_read", { path: "MEMORY.md" });
  check("memory_read lists a file's links", r.text.includes("[Links: notes, people]"), r.text.slice(-80));
  r = await tools.call("memory_read", { path: "nope" });
  check("memory_read names the files when one is missing", r.isError && r.text.includes("Files: MEMORY.md"), r.text);

  console.log("\n# Secrets are refused");
  n = await commits();
  r = await tools.call("memory_save", { content: "Their OpenAI key is sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD" });
  check("a key-shaped secret is refused", r.isError && r.text === SECRET_REFUSAL, r.text);
  r = await tools.call("memory_save", { content: "GitHub token ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
  check("a GitHub token is refused", r.isError && r.text === SECRET_REFUSAL, r.text);
  setSecret("boatApiKey", "boat-test-key-0123456789abcdef");
  r = await tools.call("memory_save", { content: "The Boat key boat-test-key-0123456789abcdef works" });
  check("one of TOT's own secrets is refused", r.isError && r.text === SECRET_REFUSAL, r.text);
  r = await tools.call("memory_save", { content: "Their password is hunter2hunter2" });
  check("a password is refused", r.isError && r.text === SECRET_REFUSAL, r.text);
  let res = await api("POST", "/memories", { content: "AWS key AKIAABCDEFGHIJKLMNOP for staging" });
  check("…from the Memory page too (400)", res.status === 400 && res.data.error === SECRET_REFUSAL, res.text);
  check("nothing was committed", (await commits()) === n);

  console.log("\n# A line written by hand");
  writeFileSync(join(youDir, "people.md"), `${file("people.md")}- Sister lives in Lisbon\n`);
  n = await commits();
  await remember({ repo: "you", text: "Drinks oat milk", source: "you", actor: "you" });
  const handLine = memories.list("you").find((m) => m.content === "Sister lives in Lisbon");
  check("the next change commits it first, as an edit outside TOT", (await commits()) === n + 2 && (await g(youDir, "log", "-2", "--format=%s")).includes("Edited outside TOT"));
  check("it gets a derived id, not written back", /^h[0-9a-f]{5}$/.test(handLine?.id ?? "") && !file("people.md").includes(handLine?.id ?? "x"), handLine?.id);
  r = await tools.call("memory_update", { id: handLine?.id ?? "x", content: "Sister lives in Porto" });
  const realId = idIn(r.text);
  check("editing it gives it a real id", !r.isError && /^[0-9a-f]{6}$/.test(realId) && file("people.md").includes(`- Sister lives in Porto [id: ${realId};`), r.text);

  // --- M1 · Project memory ---------------------------------------------------------------------------------------
  console.log("\n# A project chat writes to the project repo");
  const web = projects.create({ kind: "none", name: "Web shop" });
  const webDir = repo.repoDir(`projects/${web.slug}`);
  const projectChat = conversations.create({ agentId: kiwi.id, modelId: "auto", projectId: web.id });
  const projectTools = await toolsFor(projectChat.id);
  r = await projectTools.call("memory_save", { content: "Tests need TZ=UTC", scope: "project" });
  check("scope project goes to projects/<slug>/MEMORY.md", !r.isError && file("MEMORY.md", webDir).includes("- Tests need TZ=UTC [id: ") && r.text.includes(`projects/${web.slug}/MEMORY.md`), r.text);
  check("…in a repo of its own, started the same way", (await g(webDir, "log", "--format=%s")).trim().split("\n").length === 2);
  r = await tools.call("memory_save", { content: "Deploys go through make ship", scope: "project" });
  check("a chat in no project has no project memory", r.isError && r.text.includes("isn't in a project"), r.text);
  r = await projectTools.call("memory_search", { query: "tests UTC" });
  check("a project chat searches both", r.text.includes(`projects/${web.slug}/MEMORY.md`), r.text);
  const second = projects.create({ kind: "none", name: "Docs" });
  await remember({ repo: `projects/${second.slug}`, text: "Docs build with mkdocs", source: "you", actor: "you" });
  const roots = await Promise.all([webDir, repo.repoDir(`projects/${second.slug}`)].map((dir) => g(dir, "rev-list", "--max-parents=0", "HEAD")));
  check("every repo of a kind starts with the same commit (so devices share history)", roots[0] === roots[1] && roots[0]!.trim().length === 40, roots.join(" "));

  console.log("\n# The first turn's prompt");
  await remember({ repo: "you", text: "Uses Neovim with LazyVim", file: "tools.md", source: "you", actor: "you" });
  const { runId } = await sendMessage(projectChat.id, { text: "Can you set up Neovim for this repo?" });
  await runEnd(runId);
  const prompt = conversations.get(projectChat.id)?.systemPrompt ?? "";
  check("it loads you/MEMORY.md", prompt.includes("## About the user (you/MEMORY.md)") && prompt.includes("- Lives in Berlin and works in UTC+1 ("), prompt.slice(0, 200));
  check("…and the project's MEMORY.md", prompt.includes(`## Web shop (projects/${web.slug}/MEMORY.md)`) && prompt.includes("- Tests need TZ=UTC ("));
  check("…and related entries from other files", prompt.includes("## Related entries from other files") && prompt.includes("Uses Neovim with LazyVim") && prompt.includes("you/tools.md"));
  check("…without the metadata noise", !prompt.includes("source: tot://") && !prompt.includes("added: 20"));
  check("…and teaches where things go", prompt.includes('scope "project"') && prompt.includes("Web shop"));

  console.log("\n# Routes");
  res = await api("GET", "/memories");
  check("GET /api/memories lists the you repo in file order", res.status === 200 && res.data[0]?.path === "MEMORY.md" && res.data.every((m: { repo: string }) => m.repo === "you"));
  res = await api("POST", "/memories", { content: "Builds with Vite", repo: web.slug });
  check("POST /api/memories with a repo", res.status === 201 && res.data.repo === `projects/${web.slug}`, res.text);
  const viteId = res.data.id;
  res = await api("PATCH", `/memories/${viteId}?repo=${web.slug}`, { content: "Builds with Vite 8" });
  check("PATCH /api/memories/:id?repo=", res.status === 200 && res.data.content === "Builds with Vite 8", res.text);
  res = await api("PATCH", `/memories/${viteId}`, { content: "x y z" });
  check("…not found in the wrong repo", res.status === 404, res.text);
  res = await api("GET", "/memory/repos");
  const you = res.data.find((s: { id: string }) => s.id === "you");
  check("GET /api/memory/repos: you and each project, with counts and the last commit", res.status === 200 && res.data[0].id === "you" && you.entries > 50 && you.lastCommit?.actor && res.data.some((s: { projectId: string }) => s.projectId === web.id) && you.sync?.remote.enabled === false, res.text.slice(0, 300));
  res = await api("GET", `/memory/${encodeURIComponent(`projects/${web.slug}`)}/files`);
  check("GET /api/memory/:repo/files (URL-encoded id)", res.status === 200 && res.data[0].path === "MEMORY.md" && res.data[0].entries.length === 2, res.text.slice(0, 200));
  res = await api("GET", `/memory/you/file?path=people.md`);
  check("GET /api/memory/:repo/file", res.status === 200 && res.data.content.includes("Pixel"));
  res = await api("GET", `/memory/you/file?path=../tot.db`);
  check("…never outside the repo", res.status === 400, res.text);
  res = await api("GET", `/memory/you/history?limit=5`);
  check("GET /api/memory/:repo/history: actor, kind, what changed", res.status === 200 && res.data.length === 5 && res.data[0].actor === "you" && res.data[0].kind === "remember" && res.data[0].added >= 1, res.text.slice(0, 200));

  // --- M2 · Parallel writers and history -------------------------------------------------------------------------
  console.log("\n# 20 tasks saving at once");
  n = await commits();
  const taskChats = Array.from({ length: 20 }, () => conversations.create({ agentId: kiwi.id, modelId: "auto" }));
  const clients = await Promise.all(taskChats.map((c) => toolsFor(c.id)));
  const results = await Promise.all(clients.map((client, i) => client.call("memory_save", { content: `Parallel fact ${i} from its own task` })));
  check("all 20 saved", results.every((result) => !result.isError), results.find((result) => result.isError)?.text);
  check("20 commits", (await commits()) === n + 20, String((await commits()) - n));
  const allText = file("MEMORY.md") + file("notes.md");
  check("no entry lost", Array.from({ length: 20 }, (_, i) => `Parallel fact ${i} from its own task`).every((text) => allText.includes(text)));
  check("…and all in the index", memories.search("parallel", { repos: ["you"], limit: 50 }).length === 20);
  check("the working tree is clean", !(await g(youDir, "status", "--porcelain")).trim());
  await Promise.all(clients.map((client) => client.close()));

  console.log("\n# Undo");
  const dog = memories.list("you").find((m) => m.content === "Has a dog called Pixel")!;
  r = await tools.call("memory_delete", { id: dog.id });
  const forgetSha = (await g(youDir, "rev-parse", "HEAD")).trim();
  res = await api("POST", "/memory/you/revert", { sha: forgetSha });
  check("reverting the delete brings the entry back", res.status === 200 && res.data.kind === "undo" && file("people.md").includes(`[id: ${dog.id};`), res.text);
  check("…and reindexes", memories.get(dog.id, ["you"])?.content === "Has a dog called Pixel");
  const added = (await remember({ repo: "you", text: "Plays chess on Sundays", source: "you", actor: "you" })).memory;
  const addSha = (await g(youDir, "rev-parse", "HEAD")).trim();
  await api("PATCH", `/memories/${added.id}`, { content: "Plays chess on Saturdays" });
  n = await commits();
  res = await api("POST", "/memory/you/revert", { sha: addSha });
  check("an undo that collides with a later edit is refused (409), nothing changes", res.status === 409 && (await commits()) === n && !(await g(youDir, "status", "--porcelain")).trim(), res.text);
  const root = (await g(youDir, "rev-list", "--max-parents=0", "HEAD")).trim();
  res = await api("POST", "/memory/you/revert", { sha: root });
  check("the first commit can't be undone", res.status === 400, res.text);
  check("history marks it", (await api("GET", "/memory/you/history?limit=200")).data.at(-1).revertible === false);

  // --- M3 · The backup remote ----------------------------------------------------------------------------------
  console.log("\n# The backup remote (a local bare repo)");
  const remoteDir = mkdtempSync(join(tmpdir(), "tot-memory-remote-"));
  tempDirs.push(remoteDir);
  await g(remoteDir, "init", "-q", "--bare", "-b", "main");
  res = await api("PATCH", "/settings", { memory: { remote: { url: "https://me:hunter2@github.com/me/memory.git", enabled: true } } });
  check("a URL with a password in it is refused", res.status === 400 && /password or token/.test(res.data.error), res.text);
  res = await api("PATCH", "/settings", { memory: { dreaming: { time: "25:00" } } });
  check("a bad Dreaming time is refused", res.status === 400, res.text);
  check("off by default", settings.get().memory.remote.enabled === false && settings.get().memory.remote.url === "");
  res = await api("PATCH", "/settings", { memory: { remote: { url: remoteDir, enabled: true } } });
  check("settings merge memory field by field", res.status === 200 && res.data.memory.enabled === true && res.data.memory.dreaming.time === "03:30" && res.data.memory.remote.url === remoteDir);
  await syncRemote();
  const local = (await g(youDir, "rev-parse", "HEAD")).trim();
  check("it pushes the you repo", (await g(remoteDir, "rev-parse", "main").catch(() => "")).trim() === local);
  const clone = mkdtempSync(join(tmpdir(), "tot-memory-clone-"));
  tempDirs.push(clone);
  await g(clone, "clone", "-q", remoteDir, ".");
  writeFileSync(join(clone, "MEMORY.md"), `${readFileSync(join(clone, "MEMORY.md"), "utf8")}- Has a cat named Miso [id: c0ffee; source: you; added: ${todayStr}]\n`);
  await g(clone, "commit", "-qam", "laptop: remember a cat");
  await g(clone, "push", "-q", "origin", "main");
  await remember({ repo: "you", text: "Reads before bed", source: "you", actor: "you" });
  await syncRemote();
  check("it pulls what's new there, merging with its own changes", memories.get("c0ffee", ["you"])?.content === "Has a cat named Miso" && file("notes.md").includes("Reads before bed"));
  check("…and pushes the merge back", (await g(remoteDir, "rev-parse", "main")).trim() === (await g(youDir, "rev-parse", "HEAD")).trim());
  res = await api("GET", "/memory/repos");
  check("the sync status shows the last push", Boolean(res.data[0].sync.remote.lastPushAt) && res.data[0].sync.remote.error === null);
  settings.patch({ memory: { remote: { enabled: false } } });

  // --- M4 · Dreaming -------------------------------------------------------------------------------------------
  console.log("\n# Dreaming (a fake model)");
  const lab = projects.create({ kind: "none", name: "Lab" });
  const labRepo = `projects/${lab.slug}`;
  const labDir = repo.repoDir(labRepo);
  const ids: Record<string, string> = {};
  for (const [key, text] of Object.entries({
    a: "Prefers pnpm over npm",
    b: "Likes pnpm better than npm",
    stale: "Is flying to Lisbon on 2026-05-03",
    k1: "CI runs on GitHub Actions",
    k2: "The main branch is protected",
    k3: "Uses Postgres 17",
  })) {
    ids[key] = (await remember({ repo: labRepo, text, source: "you", actor: "you" })).memory.id;
  }
  const labChat = conversations.create({ agentId: kiwi.id, modelId: "auto", projectId: lab.id });
  messagesInsert(labChat.id, "We moved the main database to Postgres 17 last week.");
  let seenPrompt = "";
  const fake = (ops: unknown[]) => async (prompt: string) => {
    seenPrompt = prompt;
    return "```json\n" + JSON.stringify({ ops, notes: "tidied" }) + "\n```";
  };
  n = await commits(labDir);
  const result = await dream(
    labRepo,
    fake([
      { op: "merge", ids: [ids.a, ids.b], text: "Prefers pnpm over npm" },
      { op: "delete", id: ids.stale, reason: "the trip is over" },
      { op: "update", id: "zzzzzz", text: "Not a real entry" },
      { op: "add", file: "MEMORY.md", text: "Their token is ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
      { op: "add", file: "stack.md", text: "Deploys to Fly.io", source: `tot://c/${labChat.id}` },
    ]),
  );
  check("the model sees every entry with its id, and the chats since", seenPrompt.includes(`[id: ${ids.stale};`) && seenPrompt.includes("Postgres 17 last week"), seenPrompt.slice(0, 120));
  check("duplicates merge, the stale entry goes, a new fact is added", result.applied.length === 3 && memories.list(labRepo).filter((m) => /pnpm/.test(m.content)).length === 1 && !memories.get(ids.stale, [labRepo]) && memories.list(labRepo).some((m) => m.content === "Deploys to Fly.io" && m.path === "stack.md"), JSON.stringify(result.applied));
  check("an unknown id and a secret are refused", result.refused.length === 2 && result.refused.some((x) => x.reason.includes("Unknown id")) && result.refused.some((x) => x.reason === SECRET_REFUSAL) && !file("MEMORY.md", labDir).includes("ghp_"), JSON.stringify(result.refused));
  const dreamLog = await g(labDir, "log", "-1", "--format=%s%n%b");
  check("one commit, with the details in its body", (await commits(labDir)) === n + 1 && dreamLog.startsWith("Dreaming: merged 1, removed 1, added 1") && dreamLog.includes("the trip is over") && dreamLog.includes("TOT-Actor: Dreaming"), dreamLog);
  check("the result is kept for Settings", result.summary === "Merged 1, removed 1, added 1" && (await api("GET", "/memory/repos")).data.find((s: { id: string }) => s.id === labRepo).dream.sha === result.sha);

  n = await commits(labDir);
  const current = memories.list(labRepo);
  let refusedWhole = "";
  await dream(labRepo, fake(current.slice(0, 4).map((m) => ({ op: "delete", id: m.id, reason: "x" })))).catch((err: Error) => (refusedWhole = err.message));
  check("over-deletion is refused whole", /never removes more than 40%/.test(refusedWhole) && (await commits(labDir)) === n && memories.list(labRepo).length === current.length, refusedWhole);
  check("checked again before applying: an entry edited meanwhile is left alone", (() => {
    const entries = [{ id: "aaaaaa", text: "new text", source: null, added: null, derived: false, path: "MEMORY.md", line: 3, indent: "", bullet: "-" }];
    const checked = checkOps(entries, [{ op: "update", id: "aaaaaa", text: "model's text" }], new Map([["aaaaaa", "old text"]]));
    return checked.ops.length === 0 && checked.refused[0]?.reason.includes("changed meanwhile");
  })());

  await undo(labRepo, result.sha!);
  check(
    "the dream's commit reverts cleanly",
    memories.list(labRepo).filter((m) => /pnpm/.test(m.content)).length === 2 && Boolean(memories.get(ids.stale, [labRepo])) && !memories.list(labRepo).some((m) => m.content === "Deploys to Fly.io") && !(await g(labDir, "status", "--porcelain")).trim(),
  );

  await tools.close();
  await projectTools.close();
} finally {
  server.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}

/** A user message in a chat, for Dreaming to read. */
function messagesInsert(conversationId: string, text: string) {
  db.prepare(`INSERT INTO messages (id, conversation_id, role, parts, status, created_at) VALUES (?, ?, 'user', ?, 'complete', ?)`).run(
    randomUUID(),
    conversationId,
    JSON.stringify([{ type: "text", id: randomUUID(), text }]),
    Date.now(),
  );
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
