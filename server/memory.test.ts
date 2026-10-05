// Memory repo (roadmap module 10): memory as git repos of markdown. The one-time import of the old memories
// table (and what happens when it fails), the entry format, tools and routes writing one commit each, secrets
// refused and hidden, symlinks refused, project memory, the first-turn prompt, parallel writers, history and
// undo, copies merging entry by entry, sync bundles, the backup remote (a local bare repo) and Dreaming (a fake
// model). Device sync, with two TOTs, is in memory-sync.test.ts.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/memory.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
// Words about a password aren't one; a password written out is (left out, but the user may import it anyway).
seed.run(randomUUID(), "My password is managed by Bitwarden", "user", null, day + 3, day + 3);
seed.run(randomUUID(), "Their wifi password is Sunflower99", "agent", null, day + 4, day + 4);
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
const { importStatus } = await import("./memory/migrate.ts");
const { reindexAll } = await import("./memory/index.ts");
const { edit, entryFileFits, forget, remember, SECRET_REFUSAL } = await import("./memory/memory.ts");
const { promptMemory } = await import("./memory/prompt.ts");
const repo = await import("./memory/repo.ts");
const { createBundle, mergeBundle, mergesWith, readCapped, SYNC_TMP, syncRemote } = await import("./memory/sync.ts");
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const legacyCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM memories_legacy`).get() as { n: number }).n;
const enc = encodeURIComponent;

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
const idIn = (text: string) => /\(([0-9a-f]{8}(?:\.\d+)?|h[0-9a-f]{10}(?:\.\d+)?)\)/.exec(text)?.[1] ?? "";
/** The file a tool's reply names: "… in you/notes.md: …". */
const fileIn = (text: string) => / in you\/(\S+?):/.exec(text)?.[1] ?? "";

const kiwi = agents.create({ name: "Kiwi", mascot });
const chat = conversations.create({ agentId: kiwi.id, modelId: "auto" });
const tempDirs: string[] = [];

try {
  // --- M1 · The one-time import, failing first ------------------------------------------------------------
  console.log("\n# An import that fails leaves the old memories readable");
  check("the old rows moved aside, the table became an index", legacyCount() === 55);
  mkdirSync(dirname(youDir), { recursive: true });
  writeFileSync(youDir, "a file where the repo should be: git can't make it");
  let failed = "";
  await migrateMemories().catch((err: Error) => (failed = err.message));
  check("the import fails and keeps why", Boolean(failed) && importStatus().error === failed && !importStatus().done, failed);
  let res = await api("GET", "/memories");
  const legacyTexts = ((res.data ?? []) as { content: string }[]).map((m) => m.content);
  check(
    "/api/memories serves the old memories meanwhile (no secrets among them)",
    res.status === 200 && legacyTexts.length === 53 && legacyTexts.includes("Lives in Berlin and works in UTC+1") && !legacyTexts.some((t) => /sk-ant|Sunflower99/.test(t)),
    String(legacyTexts.length),
  );
  const legacyPrompt = promptMemory(null, "Where do I live?");
  check("…and so does a new chat's prompt, newest first, read-only", /read-only/.test(legacyPrompt.you) && legacyPrompt.you.includes("- Old fact number 49 ") && !/sk-ant|Sunflower99/.test(legacyPrompt.you), legacyPrompt.you.slice(0, 160));
  res = await api("GET", "/memory/repos");
  check("Settings → Memory still loads, with the import's error", res.status === 200 && res.data[0].import?.error === failed && res.data[0].import?.done === false, res.text.slice(0, 200));
  rmSync(youDir);

  console.log("\n# Importing the old memories (tried again at the next start)");
  const imported = await migrateMemories();
  check("old memories become entries in the you repo, secrets left out", imported === 53, String(imported));
  check("…and the error is gone", importStatus().done && importStatus().error === null);
  const main = file("MEMORY.md");
  const notes = file("notes.md");
  const mainSize = repo.promptSize("MEMORY.md", main);
  check("MEMORY.md fills to ~3500 characters as the prompt shows it (metadata doesn't count)", mainSize <= 3500 && mainSize > 3000, String(mainSize));
  check("the newest old memories are in MEMORY.md, the oldest in notes.md", main.includes("Old fact number 49 ") && notes.includes("Old fact number 0 ") && !main.includes("Lives in Berlin") && notes.includes("Lives in Berlin"));
  check("MEMORY.md links notes.md", main.includes("[[notes]]"));
  check("an entry has the spec's metadata, with an 8-hex id", new RegExp(`^- Lives in Berlin and works in UTC\\+1 \\[id: [0-9a-f]{8}; source: you; added: 2026-04-0[12]\\]$`, "m").test(notes), notes.slice(0, 300));
  check("an agent's memory names the chat it came from", /Prefers TypeScript over Python \[id: [0-9a-f]{8}; source: tot:\/\/c\/chat-from-before;/.test(notes));
  check("words about a password aren't taken for one", notes.includes("My password is managed by Bitwarden"));
  check("the secrets never reached a file", !/sk-ant-|Sunflower99/.test(main + notes));
  const log = await g(youDir, "log", "--format=%s");
  check("one commit: the deterministic start, then the import", log.trim().split("\n").length === 2 && log.startsWith("Imported 53 memories"), log);
  check("the import commit says what it left out", (await g(youDir, "log", "-1", "--format=%b")).includes("Left out 2 that looked like secrets"));
  check("the committed .gitattributes is the spec's", file(".gitattributes").trim() === "*.md merge=union");
  const localAttributes = () => readFileSync(join(youDir, ".git", "info", "attributes"), "utf8");
  check("…but this device's own attributes outrank it: byte for byte, plain-text merges for undo", /-filter/.test(localAttributes()) && /merge=text/.test(localAttributes()));
  const before = await commits();
  check("running it again does nothing", (await migrateMemories()) === 0 && (await commits()) === before);
  reindexAll();
  check("the index is rebuilt from the files", memories.list("you").length === 53 && memories.search("Berlin", { repos: ["you"] })[0]?.path === "notes.md");
  check("the old table is kept, untouched", legacyCount() === 55);

  console.log("\n# What the import left out");
  let skipped = importStatus().skipped;
  const wifi = skipped.find((row) => row.importable);
  const key = skipped.find((row) => !row.importable);
  check(
    "Settings → Memory lists both, the secret part hidden; the key can only be dropped",
    skipped.length === 2 && Boolean(wifi && key) && !/Sunflower99|sk-ant-/.test(JSON.stringify(skipped)) && wifi!.text.includes("[secret hidden]"),
    JSON.stringify(skipped),
  );
  res = await api("POST", `/memory/import/${wifi!.id}`);
  check("Import anyway adds it", res.status === 201 && memories.list("you").some((m) => m.content === "Their wifi password is Sunflower99"), res.text);
  check("…in a commit whose subject hides it", (await g(youDir, "log", "-1", "--format=%s")).trim() === "you: remember (text hidden)");
  res = await api("POST", `/memory/import/${key!.id}`);
  check("a key can't be imported anyway (400)", res.status === 400 && !file("MEMORY.md").includes("sk-ant") && !file("notes.md").includes("sk-ant"), res.text);
  res = await api("DELETE", `/memory/import/${key!.id}`);
  skipped = importStatus().skipped;
  check("Drop deletes it for good", res.status === 200 && skipped.length === 0 && legacyCount() === 54, res.text);

  console.log("\n# At startup: what a crash left behind");
  const lock = join(youDir, ".git", "index.lock");
  writeFileSync(lock, "");
  const longAgo = (Date.now() - 120_000) / 1000;
  utimesSync(lock, longAgo, longAgo);
  writeFileSync(join(youDir, ".git", "info", "attributes"), "*.md merge=union\n");
  let fixed = await repo.recoverRepos();
  check("a stale index.lock is removed, and this device's attributes put back", !existsSync(lock) && fixed.some((f) => f.includes("index.lock")) && /merge=text/.test(localAttributes()), JSON.stringify(fixed));
  writeFileSync(lock, "");
  fixed = await repo.recoverRepos();
  check("…but not a fresh one (git may be using it)", existsSync(lock) && !fixed.length);
  rmSync(lock);

  // --- M1 · Tools through the files ----------------------------------------------------------------------------
  console.log("\n# Tools write the files, one commit each");
  const tools = await toolsFor(chat.id);
  let n = await commits();
  let r = await tools.call("memory_save", { content: "Prefers pnpm over npm" });
  const pnpmId = idIn(r.text);
  const pnpmFile = fileIn(r.text);
  check("memory_save saves an entry with an 8-hex id", !r.isError && r.text.startsWith("Saved to memory") && /^[0-9a-f]{8}$/.test(pnpmId), r.text);
  check("…into the file, in the spec's format", file(pnpmFile).includes(`- Prefers pnpm over npm [id: ${pnpmId}; source: tot://c/${chat.id}; added: ${todayStr}]`), r.text);
  check("…as one commit by the agent, the text quoted", (await commits()) === n + 1 && (await g(youDir, "log", "-1", "--format=%s")).trim() === "Kiwi: remember “Prefers pnpm over npm”");
  r = await tools.call("memory_save", { content: "prefers PNPM over npm" });
  check("the same fact twice is already remembered (no commit)", r.text.startsWith("Already remembered") && (await commits()) === n + 1, r.text);
  r = await tools.call("memory_search", { query: "pnpm" });
  check("memory_search finds it, with its file", r.text.includes(`(${pnpmId}) Prefers pnpm over npm — you/${pnpmFile}`), r.text);
  n = await commits();
  r = await tools.call("memory_update", { id: pnpmId, content: "Prefers pnpm; never npm" });
  check("memory_update rewrites the line, same id, one commit", !r.isError && file(pnpmFile).includes(`- Prefers pnpm; never npm [id: ${pnpmId};`) && (await commits()) === n + 1, r.text);
  check("…and the index follows", memories.get(pnpmId, ["you"])?.content === "Prefers pnpm; never npm");
  r = await tools.call("memory_delete", { id: pnpmId });
  check("memory_delete removes the line, one commit", !r.isError && !file(pnpmFile).includes(pnpmId) && (await commits()) === n + 2 && !memories.get(pnpmId), r.text);
  r = await tools.call("memory_save", { content: "Has a dog called Pixel", file: "people" });
  check("a topic file is made and linked from MEMORY.md", file("people.md").startsWith("# People\n") && file("MEMORY.md").includes("[[people]]"), r.text);
  r = await tools.call("memory_read", { path: "[[people]]" });
  check("memory_read follows a [[link]]", !r.isError && r.text.startsWith("you/people.md") && r.text.includes("Pixel"), r.text);
  r = await tools.call("memory_read", { path: "MEMORY.md" });
  check("memory_read lists a file's links", r.text.includes("[Links: notes, people]"), r.text.slice(-80));
  r = await tools.call("memory_read", { path: "nope" });
  check("memory_read names the files when one is missing", r.isError && r.text.includes("Files: MEMORY.md"), r.text);
  n = await commits();
  const badNames = await Promise.all(["../escape", "notes.sql", ".hidden", "run.sh", "a/b/c/d/e/f.md"].map((name) => tools.call("memory_save", { content: "A fact with a bad file", file: name })));
  check("memory_save refuses a file that isn't a plain markdown name", badNames.every((x) => x.isError) && (await commits()) === n, badNames.map((x) => x.text).join(" | "));
  r = await tools.call("memory_save", { content: "My password is managed by Bitwarden" });
  check("a sentence about a password is no secret", r.text.startsWith("Already remembered"), r.text);

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
  res = await api("POST", "/memories", { content: "AWS key AKIAABCDEFGHIJKLMNOP for staging" });
  check("…from the Memory page too (400)", res.status === 400 && res.data.error === SECRET_REFUSAL, res.text);
  check("nothing was committed", (await commits()) === n);

  console.log("\n# A line written by hand");
  writeFileSync(join(youDir, "people.md"), `${file("people.md")}- Sister lives in Lisbon\n`);
  n = await commits();
  await remember({ repo: "you", text: "Drinks oat milk", source: "you", actor: "you" });
  const handLine = memories.list("you").find((m) => m.content === "Sister lives in Lisbon");
  check("the next change commits it first, as an edit outside TOT", (await commits()) === n + 2 && (await g(youDir, "log", "-2", "--format=%s")).includes("Edited outside TOT"));
  check("it gets a derived id (h + 10 hex), not written back", /^h[0-9a-f]{10}$/.test(handLine?.id ?? "") && !file("people.md").includes(handLine?.id ?? "x"), handLine?.id);
  r = await tools.call("memory_update", { id: handLine?.id ?? "x", content: "Sister lives in Porto" });
  const realId = idIn(r.text);
  check("editing it gives it a real id", !r.isError && /^[0-9a-f]{8}$/.test(realId) && file("people.md").includes(`- Sister lives in Porto [id: ${realId};`), r.text);

  console.log("\n# Secrets written by hand are hidden from agents");
  writeFileSync(join(youDir, "people.md"), `${file("people.md")}- Old badge code sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzzzz\n`);
  await remember({ repo: "you", text: "Likes long walks", file: "people.md", source: "you", actor: "you" });
  r = await tools.call("memory_read", { path: "people" });
  check("memory_read hides it", !r.text.includes("sk-ant-") && r.text.includes("[secret hidden]"), r.text);
  r = await tools.call("memory_search", { query: "badge code" });
  check("memory_search hides it", r.text.includes("badge code") && !r.text.includes("sk-ant-"), r.text);
  const badge = memories.list("you").find((m) => m.content.startsWith("Old badge code"))!;
  r = await tools.call("memory_delete", { id: badge.id });
  check("forgetting it doesn't copy it into the history", !r.isError && !(await g(youDir, "log", "-3", "--format=%s%n%b")).includes("sk-ant-") && (await g(youDir, "log", "-1", "--format=%s")).trim() === "Kiwi: forget (text hidden)", r.text);

  console.log("\n# Writes never go through a link");
  const outside = mkdtempSync(join(tmpdir(), "tot-memory-outside-"));
  tempDirs.push(outside);
  writeFileSync(join(outside, "target.md"), "untouched\n");
  symlinkSync(outside, join(youDir, "linked"));
  symlinkSync(join(outside, "target.md"), join(youDir, "linked-file.md"));
  r = await tools.call("memory_save", { content: "Goes through a linked folder", file: "linked/new.md" });
  const r2 = await tools.call("memory_save", { content: "Goes through a linked file", file: "linked-file.md" });
  check("a linked folder or file is refused, nothing written outside", r.isError && r2.isError && readdirSync(outside).join() === "target.md" && readFileSync(join(outside, "target.md"), "utf8") === "untouched\n", `${r.text} | ${r2.text}`);
  unlinkSync(join(youDir, "linked"));
  unlinkSync(join(youDir, "linked-file.md"));
  const mainBefore = file("MEMORY.md");
  rmSync(join(youDir, "MEMORY.md"));
  symlinkSync(join(outside, "target.md"), join(youDir, "MEMORY.md"));
  r = await tools.call("memory_save", { content: "Lands in a new topic file first", file: "fresh-topic" });
  check(
    "a save that fails halfway (the topic file written, MEMORY.md a link) leaves nothing behind",
    r.isError && !existsSync(join(youDir, "fresh-topic.md")) && !(await g(youDir, "status", "--porcelain")).trim() && readFileSync(join(outside, "target.md"), "utf8") === "untouched\n",
    r.text,
  );
  unlinkSync(join(youDir, "MEMORY.md"));
  writeFileSync(join(youDir, "MEMORY.md"), mainBefore);
  await remember({ repo: "you", text: "Reads the news at breakfast", file: "routine.md", source: "you", actor: "you" });
  check("…and once MEMORY.md is a file again, saving works", file("routine.md").includes("Reads the news at breakfast") && file("MEMORY.md").includes("[[routine]]"));

  console.log("\n# The same id on two lines");
  writeFileSync(
    join(youDir, "dupes.md"),
    "# Dupes\n\n- Prefers dark mode [id: d00dfeed]\n- Prefers dark mode everywhere [id: d00dfeed]\n- Likes rain\n- Likes rain\n- Owns a kayak [id: bead12]\n",
  );
  await remember({ repo: "you", text: "Owns a bike", file: "dupes.md", source: "you", actor: "you" });
  const dupes = memories.list("you").filter((m) => m.path === "dupes.md");
  const rain = dupes.filter((m) => m.content === "Likes rain");
  check(
    "the index keeps both lines of an id, the second as <id>.2; an old 6-hex id still reads",
    dupes.some((m) => m.id === "d00dfeed" && m.content === "Prefers dark mode") && dupes.some((m) => m.id === "d00dfeed.2" && m.content === "Prefers dark mode everywhere") && rain.length === 2 && rain[1]!.id === `${rain[0]!.id}.2` && dupes.some((m) => m.id === "bead12" && m.content === "Owns a kayak"),
    JSON.stringify(dupes.map((m) => [m.id, m.content])),
  );
  r = await tools.call("memory_delete", { id: "d00dfeed.2" });
  check("…and each can be forgotten on its own", !r.isError && file("dupes.md").includes("Prefers dark mode [id: d00dfeed]") && !file("dupes.md").includes("everywhere"), r.text);
  await edit({ repos: ["you"], id: rain[0]!.id, text: "Likes rain in autumn", actor: "you" });
  check("a hand-written line (derived id) twice: editing one leaves the other", file("dupes.md").includes("- Likes rain in autumn [id: ") && file("dupes.md").split("\n").filter((line) => line === "- Likes rain").length === 1);
  const rainLeft = memories.list("you").find((m) => m.content === "Likes rain")!;
  db.prepare(`UPDATE memories SET content = 'Something else entirely' WHERE id = ? AND repo = 'you'`).run(rainLeft.id);
  n = await commits();
  let refusedForget = "";
  await forget({ repos: ["you"], id: rainLeft.id, actor: "you" }).catch((err: Error) => (refusedForget = err.message));
  check("a derived id only reaches a line whose text still matches", /No memory with id/.test(refusedForget) && file("dupes.md").includes("- Likes rain\n") && (await commits()) === n, refusedForget);
  reindexAll();

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
  writeFileSync(join(youDir, "MEMORY.md"), file("MEMORY.md").replace("\nSee also:", "\nOld door code: sk-ant-api03-yyyyyyyyyyyyyyyyyyyyyyyyyy\n\nSee also:"));
  const { runId } = await sendMessage(projectChat.id, { text: "Can you set up Neovim for this repo?" });
  await runEnd(runId);
  const prompt = conversations.get(projectChat.id)?.systemPrompt ?? "";
  check("it loads you/MEMORY.md, the newest memories", prompt.includes("## About the user (you/MEMORY.md)") && prompt.includes("- Old fact number 49 about the user's habits"), prompt.slice(0, 200));
  check("…and the project's MEMORY.md", prompt.includes(`## Web shop (projects/${web.slug}/MEMORY.md)`) && prompt.includes("- Tests need TZ=UTC ("));
  check("…and related entries from other files", prompt.includes("## Related entries from other files") && prompt.includes("Uses Neovim with LazyVim") && prompt.includes("you/tools.md"));
  check("…then, with the room left, the newest from other files: an old memory in notes.md still reaches the chat", prompt.includes("## Recent entries from other files") && prompt.includes("- Lives in Berlin and works in UTC+1 ("), prompt.slice(-400));
  const budgets = promptMemory(web.id, "Can you set up Neovim for this repo?");
  const otherChars = [...budgets.related, ...budgets.recent].reduce((sum, m) => sum + m.content.length, 0);
  check("…so at least the old 5000 characters of memory reach a chat", budgets.you.length + otherChars >= 5000, String(budgets.you.length + otherChars));
  check("…with anything that looks like a secret hidden, even in prose written by hand", !prompt.includes("sk-ant-") && prompt.includes("Old door code: [secret hidden]"));
  check("…without the metadata noise", !prompt.includes("source: tot://") && !prompt.includes("added: 20"));
  check("…and teaches where things go", prompt.includes('scope "project"') && prompt.includes("Web shop"));
  writeFileSync(join(youDir, "MEMORY.md"), file("MEMORY.md").replace("\nOld door code: sk-ant-api03-yyyyyyyyyyyyyyyyyyyyyyyyyy\n", ""));

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
  n = await commits(webDir);
  res = await api("PATCH", `/memories/${viteId}?repo=${web.slug}`, { content: "Builds with Vite 6", expected: "Builds with Vite" });
  check("an edit that started from older text is refused (409), the newer text stays", res.status === 409 && (await commits(webDir)) === n && memories.get(viteId, [`projects/${web.slug}`])?.content === "Builds with Vite 8", res.text);
  res = await api("PATCH", `/memories/${viteId}?repo=${web.slug}`, { content: "Builds with Vite 9", expected: "Builds with Vite 8" });
  check("…and one from the current text goes through", res.status === 200 && res.data.content === "Builds with Vite 9", res.text);
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
  check("undo leaves this device's attributes alone", /merge=text/.test(localAttributes()) && /-filter/.test(localAttributes()));

  // --- M3 · Copies merge entry by entry --------------------------------------------------------------------------
  console.log("\n# Two copies of a repo merge entry by entry");
  const mergeLab = projects.create({ kind: "none", name: "Merge lab" });
  const mergeRepo = `projects/${mergeLab.slug}`;
  const mergeDir = repo.repoDir(mergeRepo);
  const bun = (await remember({ repo: mergeRepo, text: "Uses Bun for scripts", source: "you", actor: "you" })).memory;
  const ci = (await remember({ repo: mergeRepo, text: "Runs CI nightly", source: "you", actor: "you" })).memory;
  const other = mkdtempSync(join(tmpdir(), "tot-memory-other-"));
  tempDirs.push(other);
  await g(other, "clone", "-q", mergeDir, ".");
  const otherFile = (path = "MEMORY.md") => readFileSync(join(other, path), "utf8");
  const commitOther = async (subject: string) => {
    await g(other, "add", "-A");
    await g(other, "commit", "-qm", subject);
  };
  /** The other copy's history, merged in here the way a sync does it. */
  const pullOther = async () => {
    await g(mergeDir, "fetch", "-q", other, "+refs/heads/main:refs/peers/other");
    const merged = await repo.withRepo(mergeRepo, () => repo.mergeRef(mergeRepo, "refs/peers/other", { subject: "Sync: synced with the other copy", actor: "Sync", kind: "sync" }));
    reindexAll();
    return merged;
  };
  const catchUpOther = async () => {
    await g(other, "fetch", "-q", mergeDir, "main");
    await g(other, "reset", "-q", "--hard", "FETCH_HEAD");
  };
  const mergeFile = () => file("MEMORY.md", mergeDir);
  const entryLines = (content: string) => content.split("\n").filter((line) => line.startsWith("- "));

  await forget({ repos: [mergeRepo], id: ci.id, actor: "you" });
  writeFileSync(join(other, "MEMORY.md"), `${otherFile()}- Deploys on Fridays [id: 0ddba11a; source: you; added: ${todayStr}]\n`);
  await commitOther("other: remember Fridays");
  let merged = await pullOther();
  check(
    "forgotten here while the other copy appended after it: it stays forgotten, the new entry comes in",
    merged.changed && !mergeFile().includes("Runs CI nightly") && mergeFile().includes("Deploys on Fridays") && mergeFile().includes("Uses Bun for scripts"),
    mergeFile(),
  );
  const mergeSha = (await g(mergeDir, "rev-parse", "HEAD")).trim();
  check("…as a merge commit with both parents", (await g(mergeDir, "rev-list", "--parents", "-n1", "HEAD")).trim().split(" ").length === 3);

  await catchUpOther();
  await edit({ repos: [mergeRepo], id: bun.id, text: "Uses Bun for every script", actor: "you" });
  writeFileSync(join(other, "MEMORY.md"), otherFile().split("\n").filter((line) => !line.includes(`[id: ${bun.id};`)).join("\n"));
  await commitOther("other: forget Bun");
  merged = await pullOther();
  check("edited here, deleted there: the edit wins, in its place", merged.changed && entryLines(mergeFile())[0]?.startsWith("- Uses Bun for every script ["), mergeFile());

  await catchUpOther();
  await forget({ repos: [mergeRepo], id: "0ddba11a", actor: "you" });
  writeFileSync(join(other, "MEMORY.md"), otherFile().replace("- Deploys on Fridays [", "- Deploys on Fridays after 2pm ["));
  await commitOther("other: edit Fridays");
  merged = await pullOther();
  check("deleted here, edited there: the edit wins", merged.changed && mergeFile().includes("- Deploys on Fridays after 2pm ["), mergeFile());

  await catchUpOther();
  await remember({ repo: mergeRepo, text: "Ships with make release", source: "you", actor: "you" });
  writeFileSync(join(other, "MEMORY.md"), `${otherFile()}- Pins Node 22 [id: 5eed5eed; source: you; added: ${todayStr}]\n`);
  await commitOther("other: remember Node");
  merged = await pullOther();
  const lines = entryLines(mergeFile());
  const ships = lines.findIndex((line) => line.startsWith("- Ships with make release"));
  const node = lines.findIndex((line) => line.startsWith("- Pins Node 22"));
  check("added on both: both kept, this device's first", merged.changed && ships >= 0 && node === ships + 1, mergeFile());

  await catchUpOther();
  // A link as git records one (mode 120000), whatever this machine's settings.
  const linkBlob = (await repo.git(other, ["hash-object", "-w", "--stdin"], { input: "/etc/hosts" })).trim();
  await g(other, "update-index", "--add", "--cacheinfo", `120000,${linkBlob},hosts.md`);
  writeFileSync(join(other, "run.sh"), "#!/bin/sh\necho hi\n");
  writeFileSync(join(other, ".gitattributes"), "*.md merge=binary filter=evil\n");
  writeFileSync(join(other, ".gitignore"), "*.md\n");
  writeFileSync(join(other, "stack.md"), `# Stack\n\n- Uses SQLite [id: 51a7e000; source: you; added: ${todayStr}]\n`);
  await g(other, "add", "-f", "run.sh", ".gitattributes", ".gitignore", "stack.md");
  await g(other, "commit", "-qm", "other: a link, a script, its own attributes and ignore file");
  merged = await pullOther();
  const tree = (await g(mergeDir, "ls-tree", "-r", "--name-only", "HEAD")).split("\n");
  check(
    "only memory files come in: no link, no script, this device's .gitattributes, no .gitignore",
    merged.changed && tree.includes("stack.md") && !tree.includes("hosts.md") && !tree.includes("run.sh") && !tree.includes(".gitignore") && file(".gitattributes", mergeDir).trim() === "*.md merge=union" && !existsSync(join(mergeDir, "hosts.md")) && !existsSync(join(mergeDir, "run.sh")),
    JSON.stringify(merged.dropped),
  );
  check("…and the merge says what it left out", (await g(mergeDir, "log", "-1", "--format=%b")).includes("Left out what isn't memory") && memories.list(mergeRepo).some((m) => m.content === "Uses SQLite"));

  console.log("\n# Syncs can't be undone");
  res = await api("GET", `/memory/${enc(mergeRepo)}/history?limit=20`);
  const mergeCommit = (res.data as { sha: string; revertible: boolean; kind: string }[]).find((commit) => commit.sha === mergeSha);
  check("a merge isn't offered for undo", mergeCommit?.revertible === false && mergeCommit.kind === "sync", JSON.stringify(mergeCommit));
  const headBefore = (await g(mergeDir, "rev-parse", "HEAD")).trim();
  res = await api("POST", `/memory/${enc(mergeRepo)}/revert`, { sha: mergeSha });
  check("…and undoing one is refused (400), nothing changes", res.status === 400 && (await g(mergeDir, "rev-parse", "HEAD")).trim() === headBefore, res.text);

  // --- M3 · Sync bundles ---------------------------------------------------------------------------------------
  console.log("\n# Sync bundles");
  const sharedTmp = () => readdirSync(tmpdir()).filter((name) => name.startsWith("tot-memory-") && name.endsWith(".bundle"));
  const sharedBefore = sharedTmp().length;
  const bundle = await createBundle();
  check("a bundle of the you repo", bundle.subarray(0, 3).toString() === "# v" && bundle.toString("latin1").includes("git bundle"));
  check(
    "bundles pass through a private folder (0700) in the data dir, left empty, never the shared temp folder",
    (statSync(SYNC_TMP).mode & 0o777) === 0o700 && readdirSync(SYNC_TMP).length === 0 && sharedTmp().length === sharedBefore,
    (statSync(SYNC_TMP).mode & 0o777).toString(8),
  );
  const laptop = mkdtempSync(join(tmpdir(), "tot-memory-laptop-"));
  tempDirs.push(laptop);
  await g(laptop, "clone", "-q", youDir, ".");
  writeFileSync(join(laptop, "notes.md"), `${readFileSync(join(laptop, "notes.md"), "utf8")}- Cycles on weekends [id: b1c1c1e5; source: you; added: ${todayStr}]\n`);
  await g(laptop, "commit", "-qam", "laptop: remember cycling");
  await g(laptop, "bundle", "create", "-q", join(laptop, ".x.bundle"), "main");
  const laptopBundle = readFileSync(join(laptop, ".x.bundle"));
  await remember({ repo: "you", text: "Walks to work", source: "you", actor: "you" });
  let pulled = await mergeBundle(laptopBundle, "refs/peers/laptop", "Laptop", { merge: false });
  check("both changed and the other device merges: this one waits, and says so", !pulled.changed && pulled.diverged && !memories.get("b1c1c1e5", ["you"]));
  pulled = await mergeBundle(laptopBundle, "refs/peers/laptop", "Laptop");
  check("…the device that merges brings it in", pulled.changed && memories.get("b1c1c1e5", ["you"])?.content === "Cycles on weekends" && readdirSync(SYNC_TMP).length === 0);
  const syncCommit = (await api("GET", "/memory/you/history?limit=1")).data[0];
  check("…as “Sync: synced with Laptop”, not offered for undo", syncCommit.kind === "sync" && syncCommit.subject === "Sync: synced with Laptop" && syncCommit.revertible === false, JSON.stringify(syncCommit));
  const halfHour = 30 * 60_000;
  check(
    "who merges: the smaller id, or the one the other can't reach, or after 30 minutes of waiting",
    mergesWith("a", "b", true, null) && !mergesWith("b", "a", true, null) && mergesWith("b", "a", false, null) && !mergesWith("b", "a", true, Date.now() - halfHour + 60_000) && mergesWith("b", "a", true, Date.now() - halfHour - 1),
  );
  let capped = "";
  const endless = new Response(new ReadableStream({ pull: (controller) => controller.enqueue(new Uint8Array(64 * 1024)) }));
  await readCapped(endless, 1024 * 1024).catch((err: Error) => (capped = err.message));
  check("a bundle past the cap is cut off while it streams", capped === "too big");
  const declared = await readCapped(new Response("x", { headers: { "content-length": String(10 ** 9) } }), 1000).then(
    () => "read",
    (err: Error) => err.message,
  );
  check("…one that says it's too big isn't read at all, and a small one comes through", declared === "too big" && (await readCapped(new Response("hello"), 1000)).toString() === "hello", declared);
  // A commit whose tree names the same file twice: git's object checks refuse it on the way in.
  const plainGit = (args: string[], input?: Buffer) => execFileSync("git", args, { cwd: laptop, input, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).toString().trim();
  const blobId = plainGit(["hash-object", "-w", "--stdin"], Buffer.from("- Broken [id: badbadba]\n"));
  const entryBytes = Buffer.concat([Buffer.from("100644 a.md\0"), Buffer.from(blobId, "hex")]);
  const badTree = plainGit(["hash-object", "-w", "-t", "tree", "--literally", "--stdin"], Buffer.concat([entryBytes, entryBytes]));
  const badCommit = (await g(laptop, "commit-tree", badTree, "-p", "HEAD", "-m", "a broken tree")).trim();
  await g(laptop, "update-ref", "refs/heads/main", badCommit);
  await g(laptop, "bundle", "create", "-q", join(laptop, ".bad.bundle"), "main");
  const youHead = (await g(youDir, "rev-parse", "HEAD")).trim();
  const broken = await mergeBundle(readFileSync(join(laptop, ".bad.bundle")), "refs/peers/broken", "Laptop").then(
    () => "merged",
    (err: Error) => err.message,
  );
  check("a bundle with a broken object is refused, nothing changes", broken !== "merged" && (await g(youDir, "rev-parse", "HEAD")).trim() === youHead, broken);

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
  const bed = (await remember({ repo: "you", text: "Reads before bed", source: "you", actor: "you" })).memory;
  // The remote takes no pushes for now: what the fetch brought in must still reach the index.
  await g(remoteDir, "config", "receive.maxInputSize", "1");
  await syncRemote();
  res = await api("GET", "/memory/repos");
  check(
    "a push that fails after the merge still leaves the index (and screens) up to date",
    memories.get("c0ffee", ["you"])?.content === "Has a cat named Miso" && Boolean(res.data[0].sync.remote.error),
    String(res.data[0].sync.remote.error),
  );
  await g(remoteDir, "config", "--unset", "receive.maxInputSize");
  await syncRemote();
  check("it pulls what's new there, merging with its own changes", memories.get("c0ffee", ["you"])?.content === "Has a cat named Miso" && memories.get(bed.id, ["you"])?.content === "Reads before bed");
  check("…and pushes the merge back", (await g(remoteDir, "rev-parse", "main")).trim() === (await g(youDir, "rev-parse", "HEAD")).trim());
  res = await api("GET", "/memory/repos");
  check("the sync status shows the last push", Boolean(res.data[0].sync.remote.lastPushAt) && res.data[0].sync.remote.error === null);
  const backupMerge = (await api("GET", "/memory/you/history?limit=5")).data.find((commit: { kind: string }) => commit.kind === "backup");
  check("the backup's merge isn't offered for undo either", backupMerge?.revertible === false, JSON.stringify(backupMerge));

  console.log("\n# A slow backup remote never holds up a write");
  // An "ssh" that answers two seconds late, then runs the git command it was asked for on this machine.
  const slowSsh = join(remoteDir, "slow-ssh");
  writeFileSync(slowSsh, `#!/bin/sh\n[ "$1" = "-G" ] && exit 1\nsleep 2\nshift\nexec sh -c "$(printf '%s' "$*" | sed 's/^git-/git /')"\n`, { mode: 0o755 });
  process.env.GIT_SSH_COMMAND = slowSsh;
  settings.patch({ memory: { remote: { url: `ssh://slow${remoteDir}`, enabled: true } } });
  const backingUp = syncRemote();
  await sleep(400);
  const writeStarted = Date.now();
  const during = (await remember({ repo: "you", text: "Saves while the backup is slow", source: "you", actor: "you" })).memory;
  const waited = Date.now() - writeStarted;
  await backingUp;
  delete process.env.GIT_SSH_COMMAND;
  check("a write while the remote is busy doesn't wait for it", waited < 1500, `${waited} ms`);
  check("…and the backup still lands, with that write", (await g(remoteDir, "log", "--format=%s", "main")).includes("Saves while the backup is slow") && Boolean(memories.get(during.id, ["you"])), String((await api("GET", "/memory/repos")).data[0].sync.remote.error));
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
    k4: "Reviews need two approvals",
    k5: "Staging deploys on every merge",
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
  check("…a merge and a delete touch 3 of 8 entries: allowed", result.sha !== null);
  check("duplicates merge, the stale entry goes, a new fact is added", result.applied.length === 3 && memories.list(labRepo).filter((m) => /pnpm/.test(m.content)).length === 1 && !memories.get(ids.stale, [labRepo]) && memories.list(labRepo).some((m) => m.content === "Deploys to Fly.io" && m.path === "stack.md"), JSON.stringify(result.applied));
  check("an unknown id and a secret are refused", result.refused.length === 2 && result.refused.some((x) => x.reason.includes("Unknown id")) && result.refused.some((x) => x.reason === SECRET_REFUSAL) && !file("MEMORY.md", labDir).includes("ghp_"), JSON.stringify(result.refused));
  const dreamLog = await g(labDir, "log", "-1", "--format=%s%n%b");
  check("one commit, with the details in its body", (await commits(labDir)) === n + 1 && dreamLog.startsWith("Dreaming: merged 1, removed 1, added 1") && dreamLog.includes("the trip is over") && dreamLog.includes("TOT-Actor: Dreaming"), dreamLog);
  check("the result is kept for Settings", result.summary === "Merged 1, removed 1, added 1" && (await api("GET", "/memory/repos")).data.find((s: { id: string }) => s.id === labRepo).dream.sha === result.sha);

  n = await commits(labDir);
  const current = memories.list(labRepo);
  let refusedWhole = "";
  await dream(labRepo, fake(current.slice(0, 4).map((m) => ({ op: "delete", id: m.id, reason: "x" })))).catch((err: Error) => (refusedWhole = err.message));
  check("over-deletion is refused whole", /never touches more than 40%/.test(refusedWhole) && (await commits(labDir)) === n && memories.list(labRepo).length === current.length, refusedWhole);
  const entryAt = (key: string, line = 0) => ({ id: key, key, text: `Entry ${key}`, source: null, added: null, derived: false, path: "MEMORY.md", line, indent: "", bullet: "-" });
  check("checked again before applying: an entry edited meanwhile is left alone", (() => {
    const entries = [{ ...entryAt("aaaaaaaa", 3), text: "new text" }];
    const checked = checkOps(entries, [{ op: "update", id: "aaaaaaaa", text: "model's text" }], new Map([["aaaaaaaa", "old text"]]));
    return checked.ops.length === 0 && checked.refused[0]?.reason.includes("changed meanwhile");
  })());
  const few = checkOps([entryAt("a1"), entryAt("a2")], [{ op: "delete", id: "a1", reason: "stale" }]);
  check("with fewer than three entries, Dreaming removes none", Boolean(few.problem), String(few.problem));
  const ten = Array.from({ length: 10 }, (_, i) => entryAt(`b${i}`, i));
  const updates = (count: number) => checkOps(ten, ten.slice(0, count).map((e) => ({ op: "update", id: e.key, text: `New text for ${e.key}` })));
  const moves = checkOps(ten, ten.slice(0, 5).map((e) => ({ op: "move", id: e.key, file: "other.md" })));
  check("updates and moves count toward the 40% too", Boolean(updates(5).problem) && !updates(4).problem && Boolean(moves.problem), String(updates(5).problem));
  const many = checkOps(ten, Array.from({ length: 31 }, (_, i) => ({ op: "add", file: "MEMORY.md", text: `New fact number ${i}` })));
  check("at most 30 operations", many.ops.length === 30 && many.refused.length === 1 && /More than 30/.test(many.refused[0]!.reason));

  const full = projects.create({ kind: "none", name: "Full" });
  const fullRepo = `projects/${full.slug}`;
  const long = (n: number) => `Detail ${n}: ${"keeps a long design note in memory, written in full every time. ".repeat(14)}`.trim();
  for (let i = 1; i <= 3; i++) await remember({ repo: fullRepo, text: long(i), source: "you", actor: "you" });
  const big = "Writes design docs before coding, every time, and asks for a review first. ".repeat(9).trim();
  const fullDream = await dream(fullRepo, fake([{ op: "add", file: "MEMORY.md", text: "Uses tabs" }, { op: "add", file: "MEMORY.md", text: big }]));
  const placed = (text: string) => memories.list(fullRepo).find((m) => m.content === text)?.path;
  check(
    "what Dreaming adds to a full MEMORY.md goes to notes.md",
    fullDream.applied.length === 2 && placed("Uses tabs") === "MEMORY.md" && placed(big) === "notes.md" && !entryFileFits(file("MEMORY.md", repo.repoDir(fullRepo)), `- ${big} [id: 00000000]`),
    JSON.stringify([placed("Uses tabs"), placed(big)]),
  );

  res = await api("POST", `/memory/${enc(labRepo)}/revert`, { sha: result.sha });
  check(
    "the dream's commit reverts cleanly",
    res.status === 200 && memories.list(labRepo).filter((m) => /pnpm/.test(m.content)).length === 2 && Boolean(memories.get(ids.stale, [labRepo])) && !memories.list(labRepo).some((m) => m.content === "Deploys to Fly.io") && !(await g(labDir, "status", "--porcelain")).trim(),
    res.text,
  );
  const labSummary = (await api("GET", "/memory/repos")).data.find((summary: { id: string }) => summary.id === labRepo);
  check("…and Settings stops offering that dream's Undo", labSummary.dream.sha === null && /undone/.test(labSummary.dream.summary), JSON.stringify(labSummary.dream));

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
