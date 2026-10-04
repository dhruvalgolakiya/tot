// Projects M2 and M3 (roadmap module 06): one folder per project on each agent's computer (clones in
// ~/projects/<slug>, tasks' worktrees under them, old ~/repos clones moved with a symlink left behind),
// and folders on this Mac that agents use through the sandbox's folder grant. Real git and the real
// macOS sandbox under a temp HOME; fake providers, and no network (GitHub URLs lead to local bare repos).
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Project, RecentFolder, SendMessageRequest } from "../shared/types.ts";

// A temp home, set before anything reads it (local.ts reads homedir() as it loads). It lives in the
// repo's git-ignored .scratch rather than the system temp folder: sandboxed commands may write to any
// temp folder, so a home there couldn't show that the user's files stay unwritable.
const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), "..", ".scratch");
mkdirSync(SCRATCH, { recursive: true });
const HOME = realpathSync.native(mkdtempSync(join(SCRATCH, "home-")));
const OUTSIDE = realpathSync.native(mkdtempSync(join(SCRATCH, "outside-")));
process.env.HOME = HOME;
// Even when a check throws: the temp home holds git repos, worktrees and a fake ~/.ssh.
process.on("exit", () => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});
process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test
const PORT = 8817;

const { sendMessage } = await import("./agent/orchestrator.ts");
const { providers } = await import("./agent/providers/index.ts");
const { computerManager } = await import("./computer/manager.ts");
const { localSandboxed } = await import("./computer/local.ts");
const { MCP_TOKEN, paths } = await import("./config.ts");
const { agents } = await import("./data/agents.ts");
const { computers } = await import("./data/computers.ts");
const { conversations } = await import("./data/conversations.ts");
const { queueHolds } = await import("./data/queue-holds.ts");
const { settings } = await import("./data/settings.ts");
const { createApp } = await import("./app.ts");
const { NEEDS_LOCAL, checkout, prepareTask } = await import("./projects/checkout.ts");
const { FolderRefused, resolveFolder } = await import("./projects/folders.ts");
const { projects } = await import("./projects/projects.ts");
const { projectSection } = await import("./projects/prompt.ts");
const { runEnd } = await import("./tasks/run-loop.ts");
const { taskStore } = await import("./tasks/store.ts");
const { tasks } = await import("./tasks/tasks.ts");
const { worktrees } = await import("./tasks/worktree.ts");
type ActiveComputer = import("./computer/manager.ts").ActiveComputer;
type AgentProvider = import("./agent/providers/types.ts").AgentProvider;
type TurnInput = import("./agent/providers/types.ts").TurnInput;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 300)}` : ""}`);
}
const mascot = { shape: "blob" as const, color: "#60a5fa", accessory: "none" as const, eyes: "dots" as const };

settings.patch({ computer: { mode: "local" }, memory: { enabled: true } });

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

/** An MCP client on a conversation's tools, as the harness would use them. */
const clients: Client[] = [];
async function mcp(conversationId: string) {
  const client = new Client({ name: "tot-folders-test", version: "0.0.0" });
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

/** The stdout section of a computer_exec reply. */
const stdout = (text: string) => /--- stdout ---\n([\s\S]*?)(?:\n--- stderr ---|$)/.exec(text)?.[1] ?? "";

/** A command on an agent's computer, as TOT runs it (no grant); throws when it fails. */
async function sh(active: ActiveComputer, command: string, cwd?: string): Promise<string> {
  const result = await active.backend.exec(active.externalId, command, { cwd, timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(`${command}: ${result.stderr}`);
  return result.stdout.trim();
}

// git as the user runs it on this Mac (outside any sandbox).
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
function makeRepo(path: string, files: Record<string, string> = { "notes.txt": "hello\n" }): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  for (const [file, content] of Object.entries(files)) writeFileSync(join(path, file), content);
  git(path, "add", ".");
  git(path, "commit", "-qm", "init");
}
/** A stand-in for github.com/acme/web: a bare repo in the computer's home, and git told to fetch that URL from it. */
function fakeGitHub(workspace: string): void {
  const bare = join(workspace, "remotes/web.git");
  const seed = join(OUTSIDE, `seed-${randomUUID().slice(0, 6)}`);
  makeRepo(seed, { "README.md": "web\n" });
  execFileSync("git", ["clone", "-q", "--bare", seed, bare], { env: GIT_ENV });
  execFileSync("git", ["config", "--file", join(workspace, ".gitconfig"), `url.${bare}.insteadOf`, "https://github.com/acme/web.git"], { env: GIT_ENV });
}
function threw(work: () => unknown): string {
  try {
    work();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const tot = agents.create({ name: "Tot", mascot });
// Tasks are created here and set up by hand (prepareTask, as the run loop does), never run by a model.
queueHolds.set(tot.id, null, "test");

// =============================================================================
// M2: one folder per project
// =============================================================================
console.log("\n# M2: one folder per project");
const totPc = await computerManager.ensure(tot.id);
const totHome = realpathSync(totPc.backend.home(totPc.externalId));
fakeGitHub(totHome);

let res: { status: number; data: any } = await request<Project>("POST", "/projects", { kind: "github", source: "acme/web" });
const web: Project = res.data;
check("a GitHub project's folder is ~/projects/<slug> on every computer", res.status === 201 && projects.folder(web) === "~/projects/web", JSON.stringify(web));

const webChat = conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Web", projectId: web.id });
const header = tasks.create({ agentId: tot.id, parentId: webChat.id, goal: "Fix the header" });
const footer = tasks.create({ agentId: tot.id, parentId: webChat.id, goal: "Fix the footer" });
// Both start at once: the project is cloned once, then each gets its own worktree.
const [headerRepo, footerRepo] = await Promise.all([prepareTask(taskStore.get(header.id)!), prepareTask(taskStore.get(footer.id)!)]);
check(
  "two tasks in web use ~/projects/web/.tot-worktrees/… side by side",
  headerRepo.folder === "~/projects/web" &&
    footerRepo.folder === "~/projects/web" &&
    headerRepo.worktree.startsWith("~/projects/web/.tot-worktrees/tot-fix-the-header-") &&
    footerRepo.worktree.startsWith("~/projects/web/.tot-worktrees/tot-fix-the-footer-") &&
    Boolean(headerRepo.headSha && headerRepo.headSha === footerRepo.headSha),
  JSON.stringify([headerRepo, footerRepo]),
);
const onDisk = await sh(totPc, "ls projects/web/.tot-worktrees && git -C projects/web branch --list 'tot/*' && git -C projects/web config --get remote.origin.url");
check(
  "…both checked out there, on their own branches, in a clone of the project's repo",
  [headerRepo, footerRepo].every((repo) => onDisk.includes(repo.worktree.split("/").pop()!) && onDisk.includes(repo.branch)) && onDisk.includes("https://github.com/acme/web.git"),
  onDisk,
);
check("…and nothing in ~/repos", !existsSync(join(totHome, "repos")));

res = await request<Project>("POST", "/projects", { kind: "none", name: "Q4 launch" });
const launch: Project = res.data;
const launchChat = conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Launch", projectId: launch.id });
const inLaunch = await mcp(launchChat.id);
let r = await inLaunch("computer_exec", { command: "test -d ~/projects/q4-launch && echo 'Draft one' > ~/projects/q4-launch/plan.md && cat ~/projects/q4-launch/plan.md" });
check("a topic project's chat finds ~/projects/q4-launch made for it, and can write to it", r.text.includes("exit code 0") && stdout(r.text).includes("Draft one"), r.text);
check(
  "its prompt section names the folder",
  projectSection(projects.get(launch.id)!).includes("<project>\nNo code. Shared files at ~/projects/q4-launch (drafts, notes, exports); edit them freely.\n"),
  projectSection(projects.get(launch.id)!),
);
const prompt = (await turn(webChat.id, { text: "Where's the header?" })).systemPrompt;
const card = prompt.split("\n").find((line) => line.startsWith(`- web (${web.brainId})`)) ?? "";
check(
  "the project's brain card points at the project folder, not ~/repos",
  card.includes("— repo acme/web, project folder ~/projects/web") && !card.includes("~/repos") && prompt.includes("files at ~/projects/web"),
  card,
);

// --- An agent's computer from before projects: ~/repos/web, with an old task's worktree in it ----------
console.log("\n# M2: old ~/repos clones move into project folders");
const old = agents.create({ name: "Old", mascot });
queueHolds.set(old.id, null, "test");
const oldHome = join(paths.computers, old.id);
mkdirSync(oldHome, { recursive: true });
fakeGitHub(oldHome);
execFileSync("git", ["clone", "-q", "https://github.com/acme/web.git", join(oldHome, "repos/web")], { env: { ...GIT_ENV, HOME: oldHome } });
git(join(oldHome, "repos/web"), "worktree", "add", "-q", "-b", "tot/old-task-1a2b", ".tot-worktrees/tot-old-task-1a2b", "main");
execFileSync("git", ["clone", "-q", join(oldHome, "remotes/web.git"), join(oldHome, "repos/scratch")], { env: GIT_ENV });
const oldBranchSha = git(join(oldHome, "repos/web"), "rev-parse", "tot/old-task-1a2b");

const oldPc = await computerManager.ensure(old.id); // the first time TOT uses this computer
const moved = () => {
  const link = lstatSync(join(oldHome, "repos/web"));
  return link.isSymbolicLink() && readlinkSync(join(oldHome, "repos/web")) === "../projects/web" && lstatSync(join(oldHome, "projects/web")).isDirectory() && existsSync(join(oldHome, "projects/web/.git"));
};
check("the computer's first use moves ~/repos/web to ~/projects/web and leaves a symlink", moved(), await sh(oldPc, "ls -la repos projects"));
check("…but leaves a clone that isn't a project's alone", lstatSync(join(oldHome, "repos/scratch")).isDirectory() && !lstatSync(join(oldHome, "repos/scratch")).isSymbolicLink());
checkout.reset(); // as after a restart
await checkout.migrate(old.id, oldPc);
await checkout.migrate(old.id, oldPc);
check(
  "running it again leaves one folder and one symlink",
  moved() && (await sh(oldPc, "ls projects")) === "web" && (await sh(oldPc, "ls projects/web")) === "README.md" && !existsSync(join(oldHome, "projects/web/web")),
  await sh(oldPc, "ls -la repos projects projects/web"),
);
const oldRepo = { source: "acme/web", folder: "~/repos/web", baseBranch: "main", branch: "tot/old-task-1a2b", worktree: "~/repos/web/.tot-worktrees/tot-old-task-1a2b", headSha: oldBranchSha };
check(
  "an old task whose repo was ~/repos/web still finds its worktree through the symlink",
  (await worktrees.head(old.id, oldRepo)) === oldBranchSha && (await sh(oldPc, "git branch --show-current && git status --porcelain", "repos/web/.tot-worktrees/tot-old-task-1a2b")) === "tot/old-task-1a2b",
);
const oldChat = conversations.create({ agentId: old.id, modelId: old.modelId, title: "Web", projectId: web.id });
const newer = tasks.create({ agentId: old.id, parentId: oldChat.id, goal: "Newer work" });
const newerRepo = await prepareTask(taskStore.get(newer.id)!);
check(
  "new tasks there work in the moved clone, next to the old worktree",
  newerRepo.worktree.startsWith("~/projects/web/.tot-worktrees/tot-newer-work-") &&
    (await sh(oldPc, "ls projects/web/.tot-worktrees")).split("\n").length === 2,
  await sh(oldPc, "ls projects/web/.tot-worktrees"),
);

// =============================================================================
// M3: folders on this Mac
// =============================================================================
console.log("\n# M3: folders on this Mac");
// The user's home: git repos, a folder without git, secrets, and paths that must never be shared.
const meet = join(HOME, "playground/meet-notes");
makeRepo(meet);
git(meet, "branch", "feature");
const mainSha = git(meet, "rev-parse", "main");
const plain = join(HOME, "playground/plain");
mkdirSync(plain, { recursive: true });
writeFileSync(join(plain, "readme.txt"), "plain text\n");
makeRepo(join(HOME, "code/other"));
makeRepo(join(HOME, "dev/base"));
git(join(HOME, "dev/base"), "worktree", "add", "-q", "-b", "wt", join(HOME, "dev/base-wt"));
mkdirSync(join(HOME, ".ssh"));
writeFileSync(join(HOME, ".ssh/id_test"), "SECRET KEY\n");
mkdirSync(join(HOME, ".tot"));
mkdirSync(join(HOME, "Library/Keychains"), { recursive: true });
symlinkSync(OUTSIDE, join(HOME, "playground/link-out"));
symlinkSync(join(HOME, ".ssh"), join(HOME, "playground/link-ssh"));
// Most recently used first: meet-notes, then other, then base.
const now = Date.now() / 1000;
utimesSync(join(meet, ".git"), now, now);
utimesSync(join(HOME, "code/other/.git"), now - 60, now - 60);
utimesSync(join(HOME, "dev/base/.git"), now - 120, now - 120);

const recent = (await request<RecentFolder[]>("GET", "/projects/folders/recent")).data;
check(
  "recent git folders: one level deep in the usual folders, newest first, as ~/… labels",
  JSON.stringify(recent) ===
    JSON.stringify([
      { path: meet, label: "~/playground/meet-notes" },
      { path: join(HOME, "code/other"), label: "~/code/other" },
      { path: join(HOME, "dev/base"), label: "~/dev/base" },
    ]),
  JSON.stringify(recent),
);

const refusals: [string, string][] = [
  ["the home folder itself", "~"],
  ["~/.ssh", "~/.ssh"],
  ["~/.tot", "~/.tot"],
  ["~/Library", "~/Library/Keychains"],
  ["~/Library, spelled in another case", "~/library/Keychains"],
  ["a symlink pointing outside home", "~/playground/link-out"],
  ["a symlink into ~/.ssh", "~/playground/link-ssh"],
  ["a path with ..", "~/playground/../playground/meet-notes"],
  ["a folder outside home", OUTSIDE],
];
for (const [what, source] of refusals) {
  res = await request("POST", "/projects", { kind: "folder", source, grant: true });
  check(`refused: ${what}`, res.status === 400, JSON.stringify(res.data));
}
check("resolveFolder says why, in words for the user", threw(() => resolveFolder("~/.ssh")).includes("Hidden folders") && threw(() => resolveFolder("~")).includes("not the home folder itself"));
check("…and a refusal is a FolderRefused", (() => {
  try {
    resolveFolder("~/playground/link-out");
    return false;
  } catch (err) {
    return err instanceof FolderRefused;
  }
})());

res = await request<Project>("POST", "/projects", { kind: "folder", source: "~/playground/meet-notes" });
let meetProject: Project = res.data;
check("a folder project: its real path, not yet allowed", res.status === 201 && meetProject.source === meet && !meetProject.folderGranted && projects.folder(meetProject) === meet, JSON.stringify(meetProject));
const meetChat = conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Meet", projectId: meetProject.id });
check(
  "until it's allowed, no task can start in it, and the error points to the project's page",
  threw(() => tasks.create({ agentId: tot.id, parentId: meetChat.id, goal: "Fix the reminder bug" })).includes("allow it on the meet-notes project's page"),
);
check("…and its prompt tells the agent to ask", projectSection(meetProject).includes("The user hasn't let agents into this folder yet"));
check("…and Learn this project waits for it too", (await request("POST", `/projects/${meetProject.id}/learn`, { agentId: tot.id })).status === 400);
res = await request<Project>("POST", `/projects/${meetProject.id}/grant`);
meetProject = res.data;
check("POST /grant allows it", res.status === 200 && meetProject.folderGranted);
check("a topic can't be granted", (await request("POST", `/projects/${launch.id}/grant`)).status === 400);
check(
  "its prompt shows the ~/… path, and the full one to work with",
  projectSection(meetProject).includes("Folder on the user's Mac, ~/playground/meet-notes · base branch is the repo's default") &&
    projectSection(meetProject).includes(`Look in ${meet} (the full path: ~ on your computer is your own home), but don't change it: start a task for any change.`),
  projectSection(meetProject),
);

const cloudy = agents.create({ name: "Cloudy", mascot });
computers.create({ agentId: cloudy.id, kind: "boat", state: "stopped", label: "Boat" });
const cloudChat = conversations.create({ agentId: cloudy.id, modelId: cloudy.modelId, title: "Meet", projectId: meetProject.id });
check("on a Boat computer a folder project can't run yet, and says why", threw(() => tasks.create({ agentId: cloudy.id, parentId: cloudChat.id, goal: "x" })) === NEEDS_LOCAL);

res = await request<Project>("POST", "/projects", { kind: "folder", source: "~/playground/plain", grant: true });
const plainProject: Project = res.data;
check("a folder can be added with consent in one step (grant: true)", res.status === 201 && plainProject.folderGranted, JSON.stringify(plainProject));
const plainChat = conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Plain", projectId: plainProject.id });
check("a folder without git: no task can start in it", threw(() => tasks.create({ agentId: tot.id, parentId: plainChat.id, goal: "x" })).includes("isn't a git repo, so tasks can't start in it"));
check("…and its prompt says so", projectSection(plainProject).includes("It isn't a git repo of its own, so tasks can't start in it."));
res = await request<Project>("POST", "/projects", { kind: "folder", source: "~/dev/base-wt", grant: true });
const linkedChat = conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Linked", projectId: res.data.id });
check("a linked worktree's folder: no task can start in it either", threw(() => tasks.create({ agentId: tot.id, parentId: linkedChat.id, goal: "x" })).includes("worktree or submodule"));

if (!localSandboxed) {
  console.log("SKIP  the folder grant in the sandbox: no macOS sandbox here");
} else {
  // --- Chats in the project read the folder; nothing else can --------------------------------
  const inMeet = await mcp(meetChat.id);
  r = await inMeet("computer_exec", { command: "cat notes.txt && git branch --show-current", cwd: meet });
  check("a chat in the project reads the folder, and runs git in it", r.text.includes("exit code 0") && stdout(r.text).includes("hello") && stdout(r.text).includes("main"), r.text);
  r = await inMeet("computer_read_file", { path: `${meet}/notes.txt` });
  check("…and computer_read_file reads its files", !r.isError && r.text.includes("hello"), r.text);
  r = await inMeet("computer_exec", { command: "echo changed > notes.txt", cwd: meet });
  check("a chat can't change the folder: outside tasks it's read-only", !r.text.includes("exit code 0") && readFileSync(join(meet, "notes.txt"), "utf8") === "hello\n", r.text);
  r = await inMeet("computer_write_file", { path: `${meet}/notes.txt`, content: "changed" });
  check("…not with computer_write_file either", r.isError && readFileSync(join(meet, "notes.txt"), "utf8") === "hello\n", r.text);
  r = await inMeet("computer_exec", { command: `cat ${HOME}/.ssh/id_test; cat ${meet}/../plain/readme.txt; cat ${meet}/../link-ssh/id_test; true` });
  check("the grant is that folder only: ~/.ssh and the folder next to it stay unreadable", !r.text.includes("SECRET") && !r.text.includes("plain text"), r.text);

  const inWeb = await mcp(webChat.id);
  r = await inWeb("computer_exec", { command: `cat ${meet}/notes.txt` });
  check("a chat in another project can't read the folder", !stdout(r.text).includes("hello") && r.text.includes("Operation not permitted"), r.text);
  r = await inWeb("computer_read_file", { path: `${meet}/notes.txt` });
  check("…nor through computer_read_file", r.isError && !r.text.includes("hello"), r.text);
  const loose = conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Loose" });
  r = await (await mcp(loose.id))("computer_exec", { command: `cat ${meet}/notes.txt` });
  check("…nor a chat in no project", !stdout(r.text).includes("hello") && r.text.includes("Operation not permitted"), r.text);

  r = await (await mcp(plainChat.id))("computer_exec", { command: "cat readme.txt", cwd: plain });
  check("a folder without git is readable in its chats", stdout(r.text).includes("plain text"), r.text);

  // --- Tasks: branches in the user's repo, their own worktree writable, nothing else ---------------
  const fix = tasks.create({ agentId: tot.id, parentId: meetChat.id, goal: "Fix the reminder bug" });
  check(
    "a task in a folder project works in the folder itself",
    fix.task.repo?.source === meet && fix.task.repo.folder === meet && fix.task.repo.worktree.startsWith(`${meet}/.tot-worktrees/tot-fix-the-reminder-bug-`),
    JSON.stringify(fix.task.repo),
  );
  const fixRepo = await prepareTask(taskStore.get(fix.id)!);
  taskStore.patch(fix.id, { repo: fixRepo });
  check(
    "its branch appears in the user's own `git branch`, from their main",
    git(meet, "branch", "--list", "tot/*").includes(fixRepo.branch) && fixRepo.baseBranch === "main" && fixRepo.headSha === mainSha,
    `${git(meet, "branch", "--list")} ${JSON.stringify(fixRepo)}`,
  );
  check(
    ".tot-worktrees stays out of the user's `git status`",
    git(meet, "status", "--porcelain") === "" && readFileSync(join(meet, ".git/info/exclude"), "utf8").includes(".tot-worktrees/"),
    git(meet, "status", "--porcelain"),
  );

  const inFix = await mcp(fix.id);
  r = await inFix("computer_exec", { command: `echo pwned >> ${meet}/notes.txt` });
  check("writing a tracked file in the folder from computer_exec fails", !r.text.includes("exit code 0") && readFileSync(join(meet, "notes.txt"), "utf8") === "hello\n", r.text);
  r = await inFix("computer_exec", { command: "echo fixed > reminder.txt && git add reminder.txt && git commit -qm 'Fix the reminder bug' && git log --format=%s -1" });
  check(
    "…while the task's own worktree takes files and commits, on its branch",
    r.text.includes("exit code 0") && git(meet, "log", "--format=%s", "-1", fixRepo.branch) === "Fix the reminder bug" && !/error|warning/i.test(r.text),
    r.text,
  );
  r = await inFix("computer_write_file", { path: "draft.md", content: "a draft" });
  const written = await inFix("computer_read_file", { path: "draft.md" });
  check("…and computer_write_file / computer_read_file work there", !r.isError && written.text.includes("a draft") && existsSync(join(meet, ".tot-worktrees", fixRepo.worktree.split("/").pop()!, "draft.md")), r.text);
  r = await inFix("computer_write_file", { path: `${meet}/notes.txt`, content: "pwned" });
  check("…but not on the user's files", r.isError && readFileSync(join(meet, "notes.txt"), "utf8") === "hello\n", r.text);

  const escapes = [
    `echo x > ${meet}/.git/hooks/post-checkout && echo HOOK`,
    `git -C ${meet} config core.fsmonitor 'touch /tmp/pwned' && echo CONFIG`,
    `echo '*' >> ${meet}/.git/info/exclude && echo EXCLUDE`,
    `echo x > ${meet}/.git/info/attributes && echo ATTRIBUTES`,
    `git -C ${meet} branch -f feature HEAD && echo MOVED`,
    `git -C ${meet} update-ref -d refs/heads/main && echo DELETED`,
    `git -C ${meet} branch tot/sneaky && echo NEWBRANCH`,
    `git -C ${meet} checkout -q feature && echo CHECKOUT`,
    `ln ${meet}/notes.txt ${meet}/.tot-worktrees/hardlink && echo HARDLINK`,
    `ln -s ${meet}/notes.txt sym && echo pwned > sym && echo SYMLINK`,
    `rm -rf ${meet}/.git/objects/?? ${meet}/.git/objects/pack 2>/dev/null; echo x > ${meet}/.git/objects/info/alternates && echo ALTERNATES`,
    `echo x > ${meet}/.git/objects/pack/pack-0000000000000000000000000000000000000000.pack && echo PACK`,
    `echo x > ${meet}/.git/worktrees/$(basename "$PWD")/config.worktree && echo WORKTREECONFIG`,
    `mv ${meet}/.tot-worktrees ${meet}/elsewhere && echo WIPED`,
    "true",
  ];
  r = await inFix("computer_exec", { command: escapes.join("; ") });
  const said = stdout(r.text);
  check(
    "…nor the user's hooks, git config, ignore rules, other branches, checkout, history or other worktrees",
    !/HOOK|CONFIG|EXCLUDE|ATTRIBUTES|MOVED|DELETED|NEWBRANCH|CHECKOUT|HARDLINK|SYMLINK|ALTERNATES|PACK|WORKTREECONFIG|WIPED/.test(said) &&
      readFileSync(join(meet, "notes.txt"), "utf8") === "hello\n" &&
      !existsSync(join(meet, ".git/hooks/post-checkout")) &&
      git(meet, "rev-parse", "feature") === mainSha &&
      git(meet, "rev-parse", "main") === mainSha &&
      git(meet, "branch", "--show-current") === "main" &&
      !git(meet, "branch", "--list", "tot/sneaky") &&
      !git(meet, "config", "--list").includes("fsmonitor"),
    `${said} | ${r.text.slice(-600)}`,
  );
  check("…and the user's repo is intact", git(meet, "fsck", "--no-progress", "--no-dangling").length === 0 && git(meet, "status", "--porcelain") === "");

  const tidy = tasks.create({ agentId: tot.id, parentId: meetChat.id, goal: "Tidy the notes" });
  const tidyRepo = await prepareTask(taskStore.get(tidy.id)!);
  taskStore.patch(tidy.id, { repo: tidyRepo });
  r = await inFix("computer_exec", { command: `echo meddle > ${tidyRepo.worktree}/meddle.txt; git -C ${meet} update-ref refs/heads/${tidyRepo.branch} ${fixRepo.branch} && echo MOVED; true` });
  check(
    "one task can't write another task's worktree or move its branch",
    !existsSync(join(tidyRepo.worktree, "meddle.txt")) && !stdout(r.text).includes("MOVED") && git(meet, "rev-parse", tidyRepo.branch) === mainSha,
    r.text,
  );
  const changes = await tasks.changes(fix.id);
  check("the task's changes are read through its grant", changes.files.some((f) => f.path === "reminder.txt" && f.status === "added") && changes.branch === fixRepo.branch, JSON.stringify(changes.files));
  await tasks.remove(tidy.id, { deleteBranch: true });
  check("deleting a task removes its worktree and its unpushed branch from the user's repo", !existsSync(tidyRepo.worktree) && !git(meet, "branch", "--list", tidyRepo.branch));
  check("…and leaves the other task's alone", git(meet, "branch", "--list", fixRepo.branch).includes(fixRepo.branch));

  // --- The grant is checked again before every command ------------------------------------------
  const swap = join(HOME, "playground/swap");
  makeRepo(swap);
  res = await request<Project>("POST", "/projects", { kind: "folder", source: swap, grant: true });
  const swapChat = conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Swap", projectId: res.data.id });
  renameSync(swap, `${swap}-real`);
  symlinkSync(join(HOME, ".ssh"), swap);
  r = await (await mcp(swapChat.id))("computer_exec", { command: `cat ${swap}/id_test` });
  check("a granted folder swapped for a symlink to ~/.ssh is refused at the next command", !r.text.includes("SECRET") && r.text.includes("can't be used"), r.text);
  const stale = await totPc.backend.exec(totPc.externalId, `cat ${swap}/id_test`, { timeoutMs: 10_000, grant: { folder: swap } }).then(
    (result) => result.stdout,
    (err: Error) => `refused: ${err.message}`,
  );
  check("…and the sandbox itself refuses a stale grant", stale.startsWith("refused:") && stale.includes("Hidden folders"), stale);
}

for (const client of clients) await client.close();
server.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
