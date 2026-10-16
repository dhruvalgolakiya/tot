// Worktree lifecycle (roadmap module 09, lane C): a new task worktree's setup (a project's command, or one its
// lockfile implies), a folder project's files copied in, port blocks, previews (a real dev server in the task's
// worktree, under the same sandbox and grant), and cleanup of old worktrees. Real git and the macOS sandbox under
// a temp HOME, the local computer backend, fake providers, no network.
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Conversation, Project, SendMessageRequest, TaskPorts } from "../shared/types.ts";

// A temp home inside the repo's git-ignored .scratch (folder projects must be in the home folder, and the
// sandbox lets commands write any temp folder, so the system one wouldn't show what stays unwritable).
const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), "..", ".scratch");
mkdirSync(SCRATCH, { recursive: true });
const HOME = realpathSync.native(mkdtempSync(join(SCRATCH, "home-")));
process.env.HOME = HOME;
process.on("exit", () => rmSync(HOME, { recursive: true, force: true }));
process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test
// Ports nothing else uses: this test's API, and port blocks from a base of its own. TOT's own Executor port is
// put inside the fourth block, which tasks must then never get.
const PORT = 28_001 + Math.floor(Math.random() * 1000) * 2;
const BASE = 46_000 + Math.floor(Math.random() * 40) * 100;
process.env.TOT_PORT = String(PORT);
process.env.TOT_EXECUTOR_PORT = String(BASE + 35);
process.env.TOT_TASK_PORT_BASE = String(BASE);

const { sendMessage } = await import("./agent/orchestrator.ts");
const { providers } = await import("./agent/providers/index.ts");
const { computerManager } = await import("./computer/manager.ts");
const { localSandboxed } = await import("./computer/local.ts");
const { DATA_DIR, MCP_TOKEN } = await import("./config.ts");
const { agents } = await import("./data/agents.ts");
const { computers } = await import("./data/computers.ts");
const { conversations } = await import("./data/conversations.ts");
const { queueHolds } = await import("./data/queue-holds.ts");
const { settings } = await import("./data/settings.ts");
const { createApp } = await import("./app.ts");
const { grantFor, prepareTask } = await import("./projects/checkout.ts");
const { taskSection } = await import("./tasks/prompt.ts");
const { runEnd } = await import("./tasks/run-loop.ts");
const { taskStore } = await import("./tasks/store.ts");
const { tasks } = await import("./tasks/tasks.ts");
const { worktrees } = await import("./tasks/worktree.ts");
const { worktreeCleanup } = await import("./worktrees/cleanup.ts");
const { worktreeLifecycle } = await import("./worktrees/lifecycle.ts");
const { previews, PREVIEW_NEEDS_LOCAL } = await import("./worktrees/preview.ts");
const { detectIn } = await import("./worktrees/setup.ts");
type AgentProvider = import("./agent/providers/types.ts").AgentProvider;
type TurnInput = import("./agent/providers/types.ts").TurnInput;
type TaskRecord = import("./tasks/store.ts").TaskRecord;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 300)}` : ""}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await condition()) return true;
  return Boolean(await condition());
}
const mascot = { shape: "blob" as const, color: "#60a5fa", accessory: "none" as const, eyes: "dots" as const };

// Everything TOT printed while the test ran: a copied file's contents must never be among it.
const SECRET = `s3cr3t-${randomUUID()}`;
/** Shaped like an Anthropic API key: what scrub() hides even when TOT doesn't hold it. Commands print it in two halves. */
const KEY_TAIL = `api03-${randomUUID().replaceAll("-", "")}`;
const API_KEY_SHAPE = `sk-ant-${KEY_TAIL}`;
const printKey = (words: string) => `printf '${words} sk-ant-%s\\n' ${KEY_TAIL}`;
const printed: string[] = [];
for (const name of ["log", "warn", "error"] as const) {
  const original = console[name].bind(console);
  console[name] = (...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
    original(...args);
  };
}

// --- Limits: Settings → Tasks defaults (a fresh data dir) ---------------------------------------
console.log("\n# Limits");
const defaults = settings.get().tasks;
check("tasks run 4 per agent and 8 in all by default", defaults.perAgentLimit === 4 && defaults.globalLimit === 8, JSON.stringify(defaults));
check("worktrees are cleaned up after 14 days by default", defaults.worktreeCleanupDays === 14);
settings.patch({ computer: { mode: "local" }, memory: { enabled: false } });

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
providers.chatgpt = fakeProvider("chatgpt", "ChatGPT", ["gpt-6.1-sol", "gpt-6-sol"]);
async function turn(conversationId: string, body: SendMessageRequest): Promise<TurnInput> {
  const { runId } = await sendMessage(conversationId, body);
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

/** An MCP client on a conversation's tools, as the harness would use them. */
const clients: Client[] = [];
async function mcp(conversationId: string) {
  const client = new Client({ name: "tot-worktrees-test", version: "0.0.0" });
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
const stdout = (text: string) => /--- stdout ---\n([\s\S]*?)(?:\n--- stderr ---|$)/.exec(text)?.[1] ?? "";

// git as the user runs it on this Mac (outside any sandbox).
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
function makeRepo(path: string, files: Record<string, string> = { "README.md": "hello\n" }): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  git(path, "add", ".");
  git(path, "commit", "-qm", "init");
}

/** What a URL answers now, or null when nothing does. */
async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return await res.text();
  } catch {
    return null;
  }
}
const local = (port: number, path = "/") => `http://127.0.0.1:${port}${path}`;

const tot = agents.create({ name: "Tot", mascot });
// Tasks are created here and set up by hand (prepareTask, as the run loop does), never run by a model.
queueHolds.set(tot.id, null, "test");
await computerManager.ensure(tot.id);
worktreeLifecycle.start();

/** A folder project on this Mac, allowed for agents, with the given worktree settings. */
async function folderProject(name: string, files: Record<string, string>, settings: { setupCommand?: string | null; copyFiles?: string[] } = {}): Promise<Project> {
  const folder = join(HOME, "playground", name);
  makeRepo(folder, files);
  const created = await request<Project>("POST", "/projects", { kind: "folder", source: folder, grant: true });
  if (!Object.keys(settings).length) return created.data;
  const patched = await request<Project>("PATCH", `/projects/${created.data.id}`, settings);
  if (patched.status !== 200) throw new Error(JSON.stringify(patched.data));
  return patched.data;
}

/** A task in the project, set up as the run loop would before its first turn. */
async function preparedTask(project: Project, goal: string): Promise<TaskRecord> {
  const created = tasks.create({ agentId: tot.id, projectId: project.id, goal });
  const repo = await prepareTask(taskStore.get(created.id)!);
  taskStore.patch(created.id, { repo });
  return taskStore.get(created.id)!;
}
const blocks: TaskPorts[] = [];
const noteBlock = (task: TaskRecord) => task.task.ports && blocks.push(task.task.ports);

const busy: Server = createServer();
await new Promise<void>((resolve) => busy.listen(BASE + 12, "127.0.0.1", () => resolve()));

if (!localSandboxed) {
  console.log("SKIP  worktree lifecycle: no macOS sandbox here");
} else {
  try {
    // =============================================================================
    // Project settings
    // =============================================================================
    console.log("\n# Project settings");
    const shop = await folderProject("shop", {
      "package.json": '{ "name": "shop", "version": "1.0.0" }\n',
      "package-lock.json": '{ "name": "shop", "version": "1.0.0", "lockfileVersion": 3, "requires": true, "packages": { "": { "name": "shop", "version": "1.0.0" } } }\n',
      // No network in a test: npm stays offline.
      ".npmrc": "offline=true\naudit=false\nfund=false\nupdate-notifier=false\n",
    });
    check("a new project detects its setup and copies nothing", shop.setupCommand === null && JSON.stringify(shop.copyFiles) === "[]", JSON.stringify(shop));
    let res = await request("GET", `/projects/${shop.id}/setup-detect`);
    check("GET /setup-detect: a folder with package-lock.json would run npm ci", res.status === 200 && res.data.command === "npm ci" && res.data.lockfile === "package-lock.json", JSON.stringify(res.data));

    const lockDir = join(HOME, "locks");
    const detected: string[] = [];
    for (const lockfile of ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "uv.lock", "Gemfile.lock"]) {
      rmSync(lockDir, { recursive: true, force: true });
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, lockfile), "");
      detected.push(`${lockfile}=${detectIn(lockDir).command}`);
    }
    check(
      "each lockfile implies its install, and an unknown one nothing",
      detected.join(" ") ===
        "pnpm-lock.yaml=pnpm install --frozen-lockfile yarn.lock=yarn install --immutable bun.lock=bun install --frozen-lockfile bun.lockb=bun install --frozen-lockfile uv.lock=uv sync Gemfile.lock=null",
      detected.join(" "),
    );
    writeFileSync(join(lockDir, "package-lock.json"), "");
    writeFileSync(join(lockDir, "uv.lock"), "");
    check("npm's lockfile comes first when there are several", detectIn(lockDir).command === "npm ci");

    res = await request<Project>("PATCH", `/projects/${shop.id}`, { setupCommand: "  pnpm i && pnpm build  " });
    check("PATCH sets a setup command (trimmed)", res.status === 200 && res.data.setupCommand === "pnpm i && pnpm build", JSON.stringify(res.data));
    res = await request<Project>("PATCH", `/projects/${shop.id}`, { setupCommand: "" });
    check('…"" runs nothing', res.status === 200 && res.data.setupCommand === "");
    res = await request<Project>("PATCH", `/projects/${shop.id}`, { name: "shop" });
    check("…and other changes leave it as it is", res.status === 200 && res.data.setupCommand === "");
    res = await request<Project>("PATCH", `/projects/${shop.id}`, { setupCommand: null });
    check("…null detects it again", res.status === 200 && res.data.setupCommand === null);
    res = await request("PATCH", `/projects/${shop.id}`, { setupCommand: "npm ci\nrm -rf /" });
    check("a command over several lines is refused", res.status === 400 && String(res.data.error).includes("one line"), JSON.stringify(res.data));

    res = await request<Project>("PATCH", `/projects/${shop.id}`, { copyFiles: ["./.env", "config//dev.json", ".env", " "] });
    check("PATCH sets the files to copy, cleaned up", res.status === 200 && JSON.stringify(res.data.copyFiles) === '[".env","config/dev.json"]', JSON.stringify(res.data.copyFiles));
    for (const [what, path] of [
      ["..", "../secrets.env"],
      ["a .. inside", "config/../../x"],
      ["an absolute path", "/etc/hosts"],
      ["~", "~/.ssh/id_rsa"],
      ["git's own files", ".git/config"],
      ["TOT's worktrees", ".tot-worktrees/x/.env"],
    ]) {
      res = await request("PATCH", `/projects/${shop.id}`, { copyFiles: [path] });
      check(`copy files: ${what} is refused`, res.status === 400, JSON.stringify(res.data));
    }
    check("…and a refused list changes nothing", JSON.stringify((await request<Project[]>("GET", "/projects")).data.find((p) => p.id === shop.id)?.copyFiles) === '[".env","config/dev.json"]');
    await request("PATCH", `/projects/${shop.id}`, { copyFiles: [] });
    const topic = (await request<Project>("POST", "/projects", { kind: "none", name: "Launch" })).data;
    res = await request("PATCH", `/projects/${topic.id}`, { copyFiles: [".env"] });
    check("only folder projects copy files", res.status === 400, JSON.stringify(res.data));

    // =============================================================================
    // Setup
    // =============================================================================
    console.log("\n# Setup");
    const shopTask = await preparedTask(shop, "Add a cart");
    noteBlock(shopTask);
    const shopTree = shopTask.task.repo!.worktree;
    check(
      "a new worktree runs the command its lockfile implies (npm ci), in the worktree",
      shopTask.task.setup?.state === "done" && shopTask.task.setup.command === "npm ci" && shopTask.task.setup.error === null,
      JSON.stringify(shopTask.task.setup),
    );
    check("…and the card shows what it was doing only while it ran", shopTask.task.progress === null, String(shopTask.task.progress));
    check("…and its prompt says it ran", taskSection(shopTask.task, shopTask.id).includes("TOT ran `npm ci` in your worktree"), taskSection(shopTask.task, shopTask.id));
    // Set up again (the run loop calls prepareTask at every start): the worktree is there, setup isn't run again.
    const setupAt = shopTask.task.setup!.at;
    await sleep(5);
    await prepareTask(taskStore.get(shopTask.id)!);
    check("a worktree that's already there isn't set up again", taskStore.get(shopTask.id)!.task.setup!.at === setupAt);

    const broken = await folderProject("broken", { "README.md": "broken\n" }, { setupCommand: 'echo "the lockfile is out of date" >&2; exit 3' });
    const brokenTask = await preparedTask(broken, "Fix the build");
    noteBlock(brokenTask);
    const setup = brokenTask.task.setup;
    check(
      "a failing setup is recorded with its last output, and the task goes on",
      setup?.state === "failed" && setup.command?.startsWith("echo") === true && Boolean(setup.error?.includes("the lockfile is out of date")) && brokenTask.task.status === "queued",
      JSON.stringify(setup),
    );
    const first = await turn(brokenTask.id, { text: brokenTask.task.goal });
    check(
      "…and the agent hears about it in its first turn",
      first.systemPrompt.includes("and it failed:\n<setup_output>\nthe lockfile is out of date") && first.systemPrompt.includes("before you rely on the dependencies"),
      first.systemPrompt.slice(first.systemPrompt.indexOf("# Your task"), first.systemPrompt.indexOf("# Your task") + 1500),
    );
    const ports = brokenTask.task.ports!;
    check(
      "…which also gives it its ports",
      first.systemPrompt.includes(`your commands get PORT=${ports.base} and TOT_PORTS=${ports.base}-${ports.base + 9}`) && first.systemPrompt.includes("task_preview_start"),
    );

    const plain = await folderProject("plain", { "README.md": "plain\n" });
    const plainTask = await preparedTask(plain, "Write docs");
    noteBlock(plainTask);
    check("no lockfile and no command: setup is skipped", plainTask.task.setup?.state === "skipped" && plainTask.task.setup.command === null, JSON.stringify(plainTask.task.setup));
    const off = await folderProject("off", { "package-lock.json": "{}\n" }, { setupCommand: "" });
    const offTask = await preparedTask(off, "Nothing to install");
    noteBlock(offTask);
    check('…and "" runs nothing even with a lockfile', offTask.task.setup?.state === "skipped" && offTask.task.setup.command === null, JSON.stringify(offTask.task.setup));

    const envy = await folderProject("envy", { "README.md": "envy\n" }, { setupCommand: 'printf "%s %s" "$PORT" "$TOT_PORTS" > setup-env.txt' });
    const envyTask = await preparedTask(envy, "Check the env");
    noteBlock(envyTask);
    const envyPorts = envyTask.task.ports!;
    check(
      "the setup command gets the task's PORT and TOT_PORTS",
      readFileSync(join(envyTask.task.repo!.worktree, "setup-env.txt"), "utf8") === `${envyPorts.base} ${envyPorts.base}-${envyPorts.base + 9}`,
    );

    // Setup output goes into the agent's prompt and the UI: secrets come out first, not just GitHub tokens.
    const leaky = await folderProject("leaky", { "README.md": "leaky\n" }, { setupCommand: `${printKey("using")} >&2; exit 2` });
    const leakyTask = await preparedTask(leaky, "Leak nothing");
    noteBlock(leakyTask);
    check(
      "a failed setup's output has secrets hidden (any key-shaped text, not only GitHub tokens)",
      leakyTask.task.setup?.state === "failed" && Boolean(leakyTask.task.setup.error?.includes("using [secret hidden]")) && !JSON.stringify(leakyTask.task).includes(API_KEY_SHAPE),
      JSON.stringify(leakyTask.task.setup),
    );

    // =============================================================================
    // Copy files
    // =============================================================================
    console.log("\n# Copy files");
    mkdirSync(join(HOME, ".ssh"), { recursive: true });
    writeFileSync(join(HOME, ".ssh/id_test"), "PRIVATE KEY\n");
    const secrets = await folderProject("secrets", { "README.md": "secrets\n", ".gitignore": "config/local.json\n" });
    const secretsFolder = secrets.source!;
    writeFileSync(join(secretsFolder, ".env"), `API_KEY=${SECRET}\n`);
    mkdirSync(join(secretsFolder, "config"));
    writeFileSync(join(secretsFolder, "config/local.json"), `{ "key": "${SECRET}" }\n`);
    symlinkSync(join(HOME, ".ssh/id_test"), join(secretsFolder, "key.pem"));
    mkdirSync(join(secretsFolder, "certs"));
    await request("PATCH", `/projects/${secrets.id}`, { copyFiles: [".env", "config/local.json", "key.pem", "certs", "missing.env"] });
    const before = printed.length;
    const secretsTask = await preparedTask(secrets, "Use the API");
    noteBlock(secretsTask);
    const tree = secretsTask.task.repo!.worktree;
    check(
      "listed files are copied from the folder into the new worktree, as they are",
      readFileSync(join(tree, ".env"), "utf8") === readFileSync(join(secretsFolder, ".env"), "utf8") &&
        readFileSync(join(tree, "config/local.json"), "utf8") === readFileSync(join(secretsFolder, "config/local.json"), "utf8"),
    );
    check(
      "…but not a symlink out of the folder, a folder, or a file that isn't there",
      !existsSync(join(tree, "key.pem")) && !existsSync(join(tree, "certs")) && !existsSync(join(tree, "missing.env")),
    );
    check(
      "…which the agent is told, by name",
      secretsTask.task.setup?.state === "skipped" &&
        secretsTask.task.setup.error === "Not copied from the project's folder (missing, not a file, or outside it): key.pem, certs, missing.env." &&
        taskSection(secretsTask.task, secretsTask.id).includes("key.pem, certs, missing.env"),
      JSON.stringify(secretsTask.task.setup),
    );
    check(
      "copied files stay out of the task's commits (and out of the user's git status)",
      git(tree, "status", "--porcelain") === "" && !git(secretsFolder, "status", "--porcelain").includes(".env"),
      `${git(tree, "status", "--porcelain")} | ${git(secretsFolder, "status", "--porcelain")}`,
    );
    check(
      "….env through the repo's exclude file; config/local.json was ignored already",
      readFileSync(join(secretsFolder, ".git/info/exclude"), "utf8").includes("\n/.env\n") && !readFileSync(join(secretsFolder, ".git/info/exclude"), "utf8").includes("local.json"),
    );
    check("the files' contents were never printed or logged", !printed.slice(before).some((line) => line.includes(SECRET)) && !JSON.stringify(taskStore.get(secretsTask.id)).includes(SECRET));

    // A tracked symlink in the branch that points out of the worktree can't redirect a copy.
    const sneaky = await folderProject("sneaky", { "README.md": "sneaky\n" });
    symlinkSync(HOME, join(sneaky.source!, "out"));
    git(sneaky.source!, "add", "out");
    git(sneaky.source!, "commit", "-qm", "link");
    writeFileSync(join(sneaky.source!, "local.env"), `X=${SECRET}\n`);
    await request("PATCH", `/projects/${sneaky.id}`, { copyFiles: ["out/planted.env", "local.env"] });
    const sneakyTask = await preparedTask(sneaky, "Sneak");
    noteBlock(sneakyTask);
    check(
      "a copy is never written through a symlink out of the worktree",
      !existsSync(join(HOME, "planted.env")) && existsSync(join(sneakyTask.task.repo!.worktree, "local.env")) && Boolean(sneakyTask.task.setup?.error?.includes("out/planted.env")),
      JSON.stringify(sneakyTask.task.setup),
    );

    // The branch has a symlink where a listed file goes, pointing at a file that doesn't exist yet (the user's
    // folder, on another branch, has the real file): the copy mustn't create it through the link.
    const dangling = await folderProject("dangling", { "README.md": "dangling\n" });
    const planted = join(HOME, "planted-dangling.env");
    symlinkSync(planted, join(dangling.source!, "local.env"));
    git(dangling.source!, "add", "local.env");
    git(dangling.source!, "commit", "-qm", "link");
    git(dangling.source!, "checkout", "-q", "-b", "dev");
    git(dangling.source!, "rm", "-q", "local.env");
    git(dangling.source!, "commit", "-qm", "unlink");
    writeFileSync(join(dangling.source!, "local.env"), `X=${SECRET}\n`);
    await request("PATCH", `/projects/${dangling.id}`, { copyFiles: ["local.env"] });
    // Its branch starts from main (the folder has dev checked out).
    const dangle = tasks.create({ agentId: tot.id, projectId: dangling.id, goal: "Dangle", baseBranch: "main" });
    taskStore.patch(dangle.id, { repo: await prepareTask(taskStore.get(dangle.id)!) });
    const danglingTask = taskStore.get(dangle.id)!;
    noteBlock(danglingTask);
    check(
      "…nor through a symlink that points nowhere yet",
      lstatSync(join(danglingTask.task.repo!.worktree, "local.env")).isSymbolicLink() && !existsSync(planted) && Boolean(danglingTask.task.setup?.error?.includes("local.env")),
      JSON.stringify(danglingTask.task.setup),
    );

    // The exclude check is git run by TOT itself: TOT's own GIT_DIR (a repo that ignores everything) mustn't steer it.
    const decoy = join(HOME, "decoy");
    makeRepo(decoy);
    writeFileSync(join(decoy, ".git/info/exclude"), "*\n");
    const decoyed = await folderProject("decoyed", { "README.md": "decoyed\n" });
    writeFileSync(join(decoyed.source!, ".env"), `KEY=${SECRET}\n`);
    await request("PATCH", `/projects/${decoyed.id}`, { copyFiles: [".env"] });
    process.env.GIT_DIR = join(decoy, ".git");
    let decoyedTask: TaskRecord;
    try {
      decoyedTask = await preparedTask(decoyed, "Ignore the decoy");
    } finally {
      delete process.env.GIT_DIR;
    }
    noteBlock(decoyedTask);
    check(
      "TOT's own GIT_DIR doesn't reach the git it runs: the copied .env is still kept out of commits",
      readFileSync(join(decoyed.source!, ".git/info/exclude"), "utf8").includes("\n/.env\n") && git(decoyedTask.task.repo!.worktree, "status", "--porcelain") === "",
      readFileSync(join(decoyed.source!, ".git/info/exclude"), "utf8"),
    );

    // =============================================================================
    // Ports
    // =============================================================================
    console.log("\n# Ports");
    const inEnvy = await mcp(envyTask.id);
    let r = await inEnvy("computer_exec", { command: 'echo "$PORT $TOT_PORTS"' });
    check("computer_exec in a task gets its PORT and TOT_PORTS", stdout(r.text).trim() === `${envyPorts.base} ${envyPorts.base}-${envyPorts.base + 9}`, r.text);
    const chat = conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Chat" });
    r = await (await mcp(chat.id))("computer_exec", { command: 'echo "[$PORT][$TOT_PORTS]"' });
    check("…a chat's commands get none", stdout(r.text).trim() === "[][]", r.text);

    const bases = blocks.map((block) => block.base).sort((a, b) => a - b);
    check(
      "every task got its own block of 10, from the base up",
      blocks.every((block) => block.count === 10 && block.base >= BASE && (block.base - BASE) % 10 === 0) && new Set(bases).size === bases.length,
      bases.join(","),
    );
    check("…skipping a block where something already listens", !bases.includes(BASE + 10), bases.join(","));
    check("…and the one with TOT's own port in it", !bases.includes(BASE + 30), bases.join(","));

    // Landing (lane A sets TaskInfo.landing) gives the block back; the next task gets the lowest free one,
    // which is that one: every block below it is held or skipped.
    const freed = offTask.task.ports!.base;
    taskStore.patch(offTask.id, { landing: { kind: "merged", at: Date.now(), target: "main", sha: null, pr: null } });
    check("a landed task gives its ports back", await until(() => taskStore.get(offTask.id)!.task.ports === null));
    const next = await preparedTask(plain, "Next one");
    check("…and the next task gets them", next.task.ports?.base === freed, `${JSON.stringify(next.task.ports)} · ${bases.join(",")}`);
    await tasks.remove(next.id);
    const after = await preparedTask(plain, "After a delete");
    check("a deleted task's block is free again", after.task.ports?.base === freed, JSON.stringify(after.task.ports));

    // =============================================================================
    // Previews
    // =============================================================================
    console.log("\n# Previews");
    // A tiny dev server: answers with its port, its working directory and the page asked for.
    const devServer = (extra = "") =>
      `node -e "require('http').createServer((q, s) => s.end(process.env.PORT + ' ' + process.cwd() + ' ' + q.url)).listen(process.env.PORT); ${extra}"`;
    const inShop = await mcp(shopTask.id);
    const shopPorts = taskStore.get(shopTask.id)!.task.ports!;
    r = await inShop("task_preview_start", { command: devServer() });
    let preview = taskStore.get(shopTask.id)!.task.preview;
    check(
      "task_preview_start runs the dev server and waits until it answers",
      !r.isError && r.text.includes(`Preview running at http://localhost:${shopPorts.base}/`) && preview?.url === `http://localhost:${shopPorts.base}/` && preview.port === shopPorts.base,
      r.text,
    );
    let answer = await fetchText(local(shopPorts.base, "/cart"));
    check(
      "…on the task's PORT, in its worktree",
      answer === `${shopPorts.base} ${realpathSync.native(shopTree)} /cart`,
      `${answer} vs ${shopTree}`,
    );
    check("…its output kept in a log under the data dir", existsSync(join(DATA_DIR, "previews", `${shopTask.id}.log`)) && previews.isRunning(shopTask.id));
    r = await inShop("computer_exec", { command: `curl -s http://127.0.0.1:${PORT}/api/health || echo BLOCKED` });
    check("…and the task's commands still can't reach TOT itself", !stdout(r.text).includes('"ok"'), r.text);

    r = await inShop("task_preview_start", { command: devServer(), port: shopPorts.base + 3, path: "/checkout" });
    preview = taskStore.get(shopTask.id)!.task.preview;
    check(
      "starting again (another port of its block, a path) replaces the running one",
      !r.isError && preview?.url === `http://localhost:${shopPorts.base + 3}/checkout` && (await fetchText(local(shopPorts.base))) === null,
      r.text,
    );
    check("…with PORT set to the port it asked for", (await fetchText(local(shopPorts.base + 3)))?.startsWith(`${shopPorts.base + 3} `) === true);
    r = await inShop("task_preview_start", { command: devServer(), port: shopPorts.base + 10 });
    check("a port outside the task's block is refused", r.isError && r.text.includes(`${shopPorts.base}–${shopPorts.base + 9}`) && previews.isRunning(shopTask.id), r.text);
    r = await inShop("task_preview_start", { command: devServer(), path: "dashboard" });
    check("…and a path that isn't one", r.isError && r.text.includes('"/dashboard"'), r.text);

    r = await inShop("task_preview_stop");
    check(
      "task_preview_stop ends it and clears the link",
      !r.isError && r.text.startsWith("Stopped the preview") && taskStore.get(shopTask.id)!.task.preview === null && (await until(async () => (await fetchText(local(shopPorts.base + 3))) === null)),
      r.text,
    );
    r = await inShop("task_preview_stop");
    check("…and says so when nothing runs", r.text === "No preview was running.", r.text);

    r = await inShop("task_preview_start", { command: 'echo "Error: Cannot find module vite" >&2; exit 1' });
    check(
      "a dev server that dies at once: the agent gets its output, and no link stays",
      r.isError && r.text.includes("stopped before it answered") && r.text.includes("Cannot find module vite") && taskStore.get(shopTask.id)!.task.preview === null,
      r.text,
    );
    r = await inShop("task_preview_start", { command: devServer("setTimeout(() => process.exit(0), 1500)") });
    check("a dev server that ends by itself later…", !r.isError && Boolean(taskStore.get(shopTask.id)!.task.preview));
    check("…takes its link with it", await until(() => taskStore.get(shopTask.id)!.task.preview === null && !previews.isRunning(shopTask.id), 6000));

    // The task's sandbox and grant apply: the preview can't write the user's folder.
    const inSecrets = await mcp(secretsTask.id);
    const secretsPorts = taskStore.get(secretsTask.id)!.task.ports!;
    r = await inSecrets("task_preview_start", { command: `echo pwned > ${secretsFolder}/README.md; ${devServer()}` });
    check(
      "the preview runs in the task's sandbox: the user's own files stay unwritable",
      !r.isError && readFileSync(join(secretsFolder, "README.md"), "utf8") === "secrets\n" && (await fetchText(local(secretsPorts.base)))?.startsWith(String(secretsPorts.base)) === true,
      r.text,
    );
    // Discarding (lane A: TaskInfo.landing) stops it and gives the ports back.
    taskStore.patch(secretsTask.id, { landing: { kind: "discarded", at: Date.now(), target: null, sha: null, pr: null } });
    check(
      "discarding the task stops its preview and gives back its ports",
      (await until(() => !previews.isRunning(secretsTask.id) && taskStore.get(secretsTask.id)!.task.preview === null && taskStore.get(secretsTask.id)!.task.ports === null)) &&
        (await until(async () => (await fetchText(local(secretsPorts.base))) === null)),
      JSON.stringify(taskStore.get(secretsTask.id)!.task.preview),
    );

    // Stopping the task stops it too; so does POST /preview/stop, and deleting the task.
    const envyPortsNow = taskStore.get(envyTask.id)!.task.ports!;
    r = await inEnvy("task_preview_start", { command: devServer() });
    check("(a preview for the next checks)", !r.isError && Boolean(await fetchText(local(envyPortsNow.base))), r.text);
    tasks.stop(envyTask.id);
    check(
      "stopping the task stops its preview",
      (await until(() => !previews.isRunning(envyTask.id) && taskStore.get(envyTask.id)!.task.preview === null)) && (await until(async () => (await fetchText(local(envyPortsNow.base))) === null)),
    );
    const brokenPorts = taskStore.get(brokenTask.id)!.task.ports!;
    r = await (await mcp(brokenTask.id))("task_preview_start", { command: devServer() });
    res = await request<Conversation>("POST", `/tasks/${brokenTask.id}/preview/stop`);
    check(
      "POST /api/tasks/:id/preview/stop stops it and returns the task",
      !r.isError && res.status === 200 && res.data.task?.preview === null && (await until(async () => (await fetchText(local(brokenPorts.base))) === null)),
      `${r.text} ${JSON.stringify(res.data).slice(0, 200)}`,
    );
    check("…404 for a task that isn't there", (await request("POST", "/tasks/nope/preview/stop")).status === 404);
    const plainPorts = taskStore.get(plainTask.id)!.task.ports!;
    r = await (await mcp(plainTask.id))("task_preview_start", { command: devServer() });
    await tasks.remove(plainTask.id);
    check(
      "deleting the task stops its preview",
      !r.isError && !previews.isRunning(plainTask.id) && (await until(async () => (await fetchText(local(plainPorts.base))) === null)),
      r.text,
    );

    // Its output goes back to the agent: secrets hidden.
    r = await inShop("task_preview_start", { command: `${printKey("listening with")}; exit 1` });
    check("a preview's output has secrets hidden", r.isError && r.text.includes("listening with [secret hidden]") && !r.text.includes(API_KEY_SHAPE), r.text);

    // Two starts at once: one after the other, and only the second keeps running.
    const [firstStart, secondStart] = await Promise.allSettled([
      previews.start(shopTask.id, { command: devServer(), port: shopPorts.base + 1 }),
      previews.start(shopTask.id, { command: devServer(), port: shopPorts.base + 2 }),
    ]);
    check(
      "two task_preview_start calls at once leave one preview running, not two",
      firstStart.status === "fulfilled" &&
        secondStart.status === "fulfilled" &&
        taskStore.get(shopTask.id)!.task.preview?.port === shopPorts.base + 2 &&
        (await fetchText(local(shopPorts.base + 2))) !== null &&
        (await until(async () => (await fetchText(local(shopPorts.base + 1))) === null)),
      `${firstStart.status} ${secondStart.status} ${JSON.stringify(taskStore.get(shopTask.id)!.task.preview)}`,
    );
    const recorded = () => JSON.parse(readFileSync(join(DATA_DIR, "previews", "running.json"), "utf8")) as Record<string, { pid: number; started: string }>;
    check("…and it's recorded on disk, with its process group", Number.isInteger(recorded()[shopTask.id]?.pid) && Boolean(recorded()[shopTask.id]?.started), JSON.stringify(recorded()));

    // Stopping the agent's computer stops its previews too.
    await computerManager.stop(tot.id);
    check(
      "stopping the computer stops the preview, and clears its link and record",
      (await until(() => !previews.isRunning(shopTask.id) && taskStore.get(shopTask.id)!.task.preview === null)) &&
        (await until(async () => (await fetchText(local(shopPorts.base + 2))) === null)) &&
        !(shopTask.id in recorded()),
      JSON.stringify(taskStore.get(shopTask.id)!.task.preview),
    );

    // TOT crashed with a preview running: the next TOT (a fresh copy of the module, its memory empty) stops it from the record.
    r = await inShop("task_preview_start", { command: devServer() });
    const crashedPid = recorded()[shopTask.id]?.pid;
    const afterCrash = (await import(String("./worktrees/preview.ts?after-crash"))) as typeof import("./worktrees/preview.ts");
    // A pid in the record that's someone else's by now (it started at another time) must survive.
    const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    bystander.unref();
    await sleep(200);
    writeFileSync(join(DATA_DIR, "previews", "running.json"), JSON.stringify({ ...recorded(), "task-gone": { pid: bystander.pid, started: "Thu Jan 1 00:00:00 1970" } }));
    afterCrash.previews.forgetStale();
    const alive = (pid: number | undefined) => {
      try {
        process.kill(pid!, 0);
        return true;
      } catch {
        return false;
      }
    };
    check(
      "after a crash, TOT stops a preview it left running (found by its recorded pid and start time)",
      !r.isError &&
        Boolean(crashedPid) &&
        (await until(async () => (await fetchText(local(shopPorts.base))) === null)) &&
        (await until(() => !alive(crashedPid) && !previews.isRunning(shopTask.id))),
      r.text,
    );
    check("…never a process whose pid only looks the same (another start time)", alive(bystander.pid) && JSON.stringify(recorded()) === "{}", JSON.stringify(recorded()));
    process.kill(bystander.pid!, "SIGKILL");

    // Landing (merge) and discarding stop the preview before the worktree goes.
    const shipping = await folderProject("shipping", { "README.md": "shipping\n" });
    const shipIt = await preparedTask(shipping, "Ship it");
    const dropIt = await preparedTask(shipping, "Drop it");
    for (const [task, file] of [
      [shipIt, "ship.txt"],
      [dropIt, "drop.txt"],
    ] as const) {
      const tree = task.task.repo!.worktree;
      writeFileSync(join(tree, file), "work\n");
      git(tree, "add", file);
      git(tree, "commit", "-qm", file);
      taskStore.patch(task.id, { repo: { ...task.task.repo!, headSha: git(tree, "rev-parse", "HEAD") } });
      taskStore.transition(task.id, "running");
      taskStore.transition(task.id, "done", { summary: "Done." });
      const started = await previews.start(task.id, { command: devServer() });
      if (!started.ready) throw new Error(`no preview for ${file}`);
    }
    const shipPort = taskStore.get(shipIt.id)!.task.preview!.port;
    res = await request<Conversation>("POST", `/tasks/${shipIt.id}/land`, { method: "merge", headSha: taskStore.get(shipIt.id)!.task.repo!.headSha });
    check(
      "merging stops the task's preview first (it's gone when the merge returns), then its worktree goes",
      res.status === 200 &&
        res.data.task?.landing?.kind === "merged" &&
        res.data.task.preview === null &&
        !previews.isRunning(shipIt.id) &&
        !existsSync(shipIt.task.repo!.worktree) &&
        (await fetchText(local(shipPort))) === null,
      JSON.stringify(res.data.task ?? res.data).slice(0, 300),
    );
    const dropPort = taskStore.get(dropIt.id)!.task.preview!.port;
    res = await request<Conversation>("POST", `/tasks/${dropIt.id}/discard`);
    check(
      "…and so does discarding",
      res.status === 200 && res.data.task?.landing?.kind === "discarded" && res.data.task.preview === null && !previews.isRunning(dropIt.id) && (await fetchText(local(dropPort))) === null,
      JSON.stringify(res.data.task ?? res.data).slice(0, 300),
    );

    // A Boat computer has no preview; and a chat has no preview tools.
    const cloudy = agents.create({ name: "Cloudy", mascot });
    queueHolds.set(cloudy.id, null, "test");
    computers.create({ agentId: cloudy.id, kind: "boat", state: "stopped", label: "Boat" });
    const cloudTask = tasks.create({ agentId: cloudy.id, goal: "Cloud work", repo: "acme/web" });
    taskStore.patch(cloudTask.id, { repo: { ...cloudTask.task.repo!, headSha: "abc123" } });
    r = await (await mcp(cloudTask.id))("task_preview_start", { command: devServer() });
    check("on a Boat computer: a clear “needs a local computer”", r.isError && r.text === PREVIEW_NEEDS_LOCAL, r.text);
    const tools = await clients.at(-1)!.listTools();
    check("…and the preview tools are only in coding tasks", tools.tools.some((tool) => tool.name === "task_preview_stop"));
    const chatTools = await (async () => {
      const client = new Client({ name: "tot-worktrees-test", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp/${chat.id}`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } }));
      clients.push(client);
      return (await client.listTools()).tools.map((tool) => tool.name);
    })();
    check("…not in chats", !chatTools.includes("task_preview_start") && chatTools.includes("computer_exec"), chatTools.join(","));

    // TOT shutting down ends every preview; after a restart, old links are forgotten.
    r = await inShop("task_preview_start", { command: devServer() });
    await worktreeLifecycle.shutdown();
    check("TOT shutting down stops every preview", !r.isError && !previews.isRunning(shopTask.id) && (await until(async () => (await fetchText(local(shopPorts.base))) === null)), r.text);
    taskStore.patch(shopTask.id, { preview: { url: `http://localhost:${shopPorts.base}/`, port: shopPorts.base, command: "npm run dev", startedAt: Date.now() } });
    worktreeLifecycle.start();
    check("…and after a restart a preview from before is forgotten", taskStore.get(shopTask.id)!.task.preview === null);

    // =============================================================================
    // Cleanup
    // =============================================================================
    console.log("\n# Cleanup");
    res = await request("PATCH", "/settings", { tasks: { worktreeCleanupDays: 400 } });
    check("cleanup days must be 0–365", res.status === 400, JSON.stringify(res.data));
    res = await request("PATCH", "/settings", { tasks: { worktreeCleanupDays: 1.5 } });
    check("…whole days", res.status === 400);
    res = await request("PATCH", "/settings", { tasks: { worktreeCleanupDays: 0 } });
    check("…0 (never) is allowed", res.status === 200 && res.data.tasks.worktreeCleanupDays === 0);

    const DAY = 24 * 60 * 60_000;
    const finish = (task: TaskRecord, daysAgo: number) => {
      taskStore.transition(task.id, "running");
      taskStore.transition(task.id, "done", { summary: "Done." });
      taskStore.patch(task.id, { finishedAt: Date.now() - daysAgo * DAY });
    };
    const old = await preparedTask(shop, "Old work");
    const recent = await preparedTask(shop, "Recent work");
    const landed = await preparedTask(shop, "Landed work");
    const open = await preparedTask(shop, "Open work");
    finish(old, 20);
    finish(recent, 3);
    finish(landed, 30);
    taskStore.patch(landed.id, { landing: { kind: "pr", at: Date.now(), target: "main", sha: null, pr: { number: 1, url: "https://example.com/1" } } });
    taskStore.patch(open.id, { finishedAt: Date.now() - 30 * DAY });
    const oldPorts = taskStore.get(old.id)!.task.ports!;
    r = await (await mcp(old.id))("task_preview_start", { command: devServer() });
    res = await request("POST", "/worktrees/cleanup");
    check("with cleanup turned off (0), nothing is removed", res.status === 200 && res.data.removed === 0 && existsSync(old.task.repo!.worktree), JSON.stringify(res.data));
    await request("PATCH", "/settings", { tasks: { worktreeCleanupDays: 14 } });
    res = await request("POST", "/worktrees/cleanup");
    const oldNow = taskStore.get(old.id)!;
    check(
      "POST /api/worktrees/cleanup removes worktrees of finished, unlanded tasks older than 14 days",
      res.status === 200 && res.data.removed === 1 && !existsSync(old.task.repo!.worktree) && oldNow.task.repo!.headSha === null,
      JSON.stringify(res.data),
    );
    check("…keeping their branches", git(shop.source!, "branch", "--list", old.task.repo!.branch).includes(old.task.repo!.branch));
    check(
      "…stopping their previews and giving back their ports",
      !r.isError && oldNow.task.preview === null && oldNow.task.ports === null && (await until(async () => (await fetchText(local(oldPorts.base))) === null)),
      r.text,
    );
    check(
      "…and leaving recent, landed and unfinished tasks' worktrees alone",
      existsSync(recent.task.repo!.worktree) && existsSync(landed.task.repo!.worktree) && existsSync(open.task.repo!.worktree),
    );
    res = await request("POST", "/worktrees/cleanup", { days: 2 });
    check("“Clean up now” with the days on screen (2)", res.data.removed === 1 && !existsSync(recent.task.repo!.worktree), JSON.stringify(res.data));
    res = await request("POST", "/worktrees/cleanup", { days: 0 });
    check("…which must be 1–365", res.status === 400);

    // Picking a cleaned-up task up again makes its worktree again, from its branch, and sets it up again.
    const again = await prepareTask(taskStore.get(old.id)!);
    taskStore.patch(old.id, { repo: again });
    const revived = taskStore.get(old.id)!;
    check(
      "a cleaned-up task picked up again gets its worktree back from its branch, set up again, with ports",
      existsSync(again.worktree) && again.branch === old.task.repo!.branch && Boolean(again.headSha) && revived.task.setup?.state === "done" && Boolean(revived.task.ports),
      JSON.stringify(revived.task.setup),
    );

    // Work the task never committed (a new file) keeps its worktree where it is.
    const unsaved = await preparedTask(shop, "Unsaved work");
    finish(unsaved, 20);
    writeFileSync(join(unsaved.task.repo!.worktree, "notes.md"), "not committed\n");
    res = await request("POST", "/worktrees/cleanup");
    check(
      "cleanup leaves a worktree with uncommitted work (a new file) alone",
      res.status === 200 && existsSync(join(unsaved.task.repo!.worktree, "notes.md")) && Boolean(taskStore.get(unsaved.id)!.task.repo!.headSha),
      JSON.stringify(res.data),
    );

    // A task being picked up again (it holds its lock, as tasks.message does) is never cleaned up under it.
    const picked = await preparedTask(shop, "Picked up again");
    finish(picked, 20);
    let sweep: Promise<{ removed: number }> | null = null;
    await worktrees.forTask(picked.id, async () => {
      sweep = worktreeCleanup.run();
      await sleep(300);
      taskStore.transition(picked.id, "running");
    });
    const swept = await sweep!;
    check(
      "cleanup looks at a task again once it's its turn: one picked up meanwhile keeps its worktree",
      swept.removed === 0 && existsSync(picked.task.repo!.worktree) && Boolean(taskStore.get(picked.id)!.task.repo!.headSha),
      JSON.stringify(swept),
    );
    taskStore.transition(picked.id, "done", { summary: "Done." });

    // Two replies at once to a cleaned-up task: its worktree is made once, and set up once.
    const twice = await folderProject("twice", { "README.md": "twice\n" }, { setupCommand: "echo ran >> setup-runs.txt" });
    const twiceTask = await preparedTask(twice, "Set up once");
    await worktrees.remove(tot.id, twiceTask.task.repo!, { force: true, grant: grantFor(twiceTask) });
    taskStore.patch(twiceTask.id, { repo: { ...twiceTask.task.repo!, headSha: null }, setup: null });
    const [onceA] = await Promise.all([prepareTask(taskStore.get(twiceTask.id)!), prepareTask(taskStore.get(twiceTask.id)!)]);
    check(
      "two set-ups at once of a cleaned-up task run its setup once",
      readFileSync(join(onceA.worktree, "setup-runs.txt"), "utf8") === "ran\n",
      readFileSync(join(onceA.worktree, "setup-runs.txt"), "utf8"),
    );
  } catch (err) {
    check("the test ran to the end", false, err instanceof Error ? (err.stack ?? err.message) : String(err));
  } finally {
    await worktreeLifecycle.shutdown();
  }
}

busy.close();
for (const client of clients) await client.close();
server.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
