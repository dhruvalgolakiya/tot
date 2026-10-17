// The workspace panel: a chat's folder (its project's main checkout, or its own worktree) and what the panel may
// do in it. Covers finding the folder, paths kept inside it (no "..", no git's own files, no symlink out of it),
// who may read, change and open terminals, and each tab's routes. Real git and the macOS sandbox in a temp HOME,
// the local computer backend, a fake GitHub; no network.
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Conversation, Project } from "@tot/shared/types";
import type { WorkspaceInfo } from "@tot/shared/workspace";

// A temp home in the repo's git-ignored .scratch (folder projects must be in the home folder).
const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".scratch");
mkdirSync(SCRATCH, { recursive: true });
const HOME = realpathSync.native(mkdtempSync(join(SCRATCH, "home-")));
process.env.HOME = HOME;
process.on("exit", () => rmSync(HOME, { recursive: true, force: true }));
// Sign-in set up, so other devices can be told apart from this computer.
process.env.TOT_ACCESS_TOKEN = "Workspace-Test-Token-1234";
// A fake GitHub API (started below): nothing here talks to the real one.
const GITHUB_PORT = 39_000 + Math.floor(Math.random() * 900) * 2;
process.env.TOT_GITHUB_API_URL = `http://127.0.0.1:${GITHUB_PORT}`;
// The user's own git name and address, which the panel's commits carry.
writeFileSync(join(HOME, ".gitconfig"), "[user]\n\tname = Pat User\n\temail = pat@example.com\n");

const { createApp } = await import("./app.ts");
const { chatWorkspaces } = await import("./chats/workspace.ts");
const { computerManager } = await import("./computer/manager.ts");
const { agents } = await import("./data/agents.ts");
const { conversations } = await import("./data/conversations.ts");
const { settings } = await import("./data/settings.ts");
const { peers } = await import("./devices/peers.ts");
const { cleanPath, inside } = await import("./workspace/root.ts");
const { providers } = await import("./agent/providers/index.ts");
const { setSecret } = await import("./config.ts");
const { db } = await import("./db.ts");
const { workspaceWatch } = await import("./workspace/watch.ts");
const { terminals } = await import("./workspace/terminal.ts");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 300)}` : ""}`);
}
const throws = (run: () => unknown, status: number) => {
  try {
    run();
    return false;
  } catch (err) {
    return (err as { status?: number }).status === status;
  }
};
const mascot = { shape: "blob" as const, color: "#60a5fa", accessory: "none" as const, eyes: "dots" as const };
settings.patch({ computer: { mode: "local" }, memory: { enabled: false } });

const app = createApp();
/** This computer by default; another device's address for the rest. */
async function call<T = any>(method: string, path: string, { body, headers = {}, from = "127.0.0.1" }: { body?: unknown; headers?: Record<string, string>; from?: string } = {}) {
  const res = await app.request(
    `http://127.0.0.1:8787/api${path}`,
    {
      method,
      headers: { host: "127.0.0.1:8787", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { incoming: { socket: { remoteAddress: from, remotePort: 50000, remoteFamily: "IPv4" } } },
  );
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  return { status: res.status, data: data as T, headers: res.headers };
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const tot = agents.create({ name: "Tot", mascot });
await computerManager.ensure(tot.id);

// The user's repo, with a secret beside it that nothing in the panel may reach.
const web = join(HOME, "code/web");
mkdirSync(join(web, "src"), { recursive: true });
git(web, "init", "-q", "-b", "main");
writeFileSync(join(web, "README.md"), "# Web\n");
writeFileSync(join(web, "src/app.ts"), "export const answer = 41;\n");
writeFileSync(join(web, ".gitignore"), "dist/\n");
git(web, "add", ".");
git(web, "commit", "-qm", "init");
writeFileSync(join(HOME, "secret.txt"), "the user's secret\n");
symlinkSync(join(HOME, "secret.txt"), join(web, "leak.txt"));
symlinkSync(join(HOME), join(web, "home"));
symlinkSync("src/app.ts", join(web, "alias.ts"));

let res: { status: number; data: any; headers: Headers } = await call<Project>("POST", "/projects", { body: { kind: "folder", source: web, grant: true } });
const project: Project = res.data;
check("the folder project is made", res.status === 201, JSON.stringify(res.data));
const create = (body: Record<string, unknown>) => call<Conversation>("POST", "/conversations", { body: { agentId: tot.id, ...body } });
const checkoutChat: Conversation = (await create({ projectId: project.id, workspace: "checkout" })).data;
const worktreeChat: Conversation = (await create({ projectId: project.id, workspace: "worktree" })).data;
const plainChat: Conversation = (await create({ projectId: project.id })).data;

// =============================================================================
console.log("\n# Finding the chat's folder");
res = await call<WorkspaceInfo>("GET", `/conversations/${checkoutChat.id}/workspace`);
check("a checkout chat's folder is the project's", res.status === 200 && res.data.available && res.data.mode === "checkout" && res.data.git && res.data.label === "~/code/web", JSON.stringify(res.data));
check("…and this computer may change it and open terminals", res.data.canWrite && res.data.canTerminal, JSON.stringify(res.data));
res = await call<WorkspaceInfo>("GET", `/conversations/${plainChat.id}/workspace`);
check("a chat that didn't pick a workspace has none", res.status === 200 && !res.data.available && /doesn't work in a project folder/.test(res.data.reason ?? ""), JSON.stringify(res.data));
res = await call<WorkspaceInfo>("GET", `/conversations/${worktreeChat.id}/workspace`);
check("a worktree chat has none until its worktree is made", !res.data.available && /first message/.test(res.data.reason ?? ""), JSON.stringify(res.data));
check("an unknown chat is a 404", (await call("GET", "/conversations/nope/workspace")).status === 404);

const prepared = await chatWorkspaces.prepare(conversations.get(worktreeChat.id)!, "Raise the answer");
check("the worktree chat's worktree is made", Boolean(prepared.chat.workspace?.mode === "worktree" && prepared.chat.workspace.created), prepared.notice ?? "");
const worktree = prepared.chat.workspace?.mode === "worktree" ? prepared.chat.workspace.worktree! : "";
res = await call<WorkspaceInfo>("GET", `/conversations/${worktreeChat.id}/workspace`);
check("…and is its folder then", res.data.available && res.data.mode === "worktree" && res.data.label === `~/code/web/.tot-worktrees/${worktree.split("/").pop()}`, JSON.stringify(res.data));

// =============================================================================
console.log("\n# Paths stay inside the folder");
check("a plain path is kept", cleanPath("src/app.ts") === "src/app.ts" && cleanPath("./src//app.ts") === "src/app.ts" && cleanPath("") === "");
check("“..” out of the folder is refused", throws(() => cleanPath("../secret.txt"), 400) && throws(() => cleanPath("src/../../secret.txt"), 400));
check("…but “..” that stays inside is fine", cleanPath("src/../README.md") === "README.md");
check("an absolute path is refused", throws(() => cleanPath("/etc/passwd"), 400) && throws(() => cleanPath(join(HOME, "secret.txt")), 400));
check("git's own files are refused", throws(() => cleanPath(".git/config"), 403) && throws(() => cleanPath("src/.git/hooks/pre-commit"), 403));
check("other chats' worktrees are refused", throws(() => cleanPath(".tot-worktrees/x/README.md"), 403));
check("control characters and a NUL are refused", throws(() => cleanPath("a\0b"), 400) && throws(() => cleanPath("a\nb"), 400));
check("a non-string is refused", throws(() => cleanPath(42), 400));
check("a symlink to a file outside is refused", throws(() => inside(web, "leak.txt"), 403));
check("…and a path through a symlinked folder outside", throws(() => inside(web, "home/secret.txt"), 403) && throws(() => inside(web, "home/new.txt", { exists: false }), 403));
check("a symlink that stays inside resolves to its target", inside(web, "alias.ts").path === join(web, "src/app.ts"));
check("a missing file is a 404, unless it's to be made", throws(() => inside(web, "src/nope.ts"), 404) && inside(web, "src/new/nope.ts", { exists: false }).path === join(web, "src/new/nope.ts"));

// =============================================================================
console.log("\n# Who may do what");
const deviceToken = `totd_${"a".repeat(40)}`;
peers.save({ id: "11111111-2222-4333-8444-555555555555", name: "Laptop", address: "http://192.168.1.80:8787" }, { inbound: deviceToken, outbound: `totd_${"b".repeat(40)}` });
const asDevice = { headers: { authorization: `Bearer ${deviceToken}` }, from: "192.168.1.80" };
res = await call<WorkspaceInfo>("GET", `/conversations/${checkoutChat.id}/workspace`, asDevice);
check("a paired device can see the folder, but not change it or open terminals", res.status === 200 && res.data.available && !res.data.canWrite && !res.data.canTerminal, JSON.stringify(res.data));
res = await call<WorkspaceInfo>("GET", `/conversations/${checkoutChat.id}/workspace`, { headers: { authorization: `Bearer ${process.env.TOT_ACCESS_TOKEN}` }, from: "192.168.1.70" });
check("the access token may change it, but gets no terminal", res.data.canWrite && !res.data.canTerminal, JSON.stringify(res.data));
res = await call("GET", `/conversations/${checkoutChat.id}/workspace`, { from: "192.168.1.70" });
check("another device that isn't signed in gets nothing", res.status === 401);

// =============================================================================
console.log("\n# Diff");
type Diff = import("@tot/shared/workspace").WorkspaceDiff;
type FileDiff = import("@tot/shared/workspace").WorkspaceFileDiff;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let changes = 0;
const unwatch = workspaceWatch.subscribe(web, () => changes++);
writeFileSync(join(web, "src/app.ts"), "export const answer = 42;\nexport const question = '?';\n");
writeFileSync(join(web, "NOTES.md"), "one\ntwo\nthree\n");
mkdirSync(join(web, "dist"), { recursive: true });
writeFileSync(join(web, "dist/bundle.js"), "ignored\n");
git(web, "mv", "README.md", "README.txt");
await sleep(800);
check("changing files in the folder tells its watchers, once per burst", changes >= 1 && changes <= 2, String(changes));
unwatch();
check("…and the watcher closes with its last listener", workspaceWatch.count() === 0);
res = await call<Diff>("GET", `/conversations/${checkoutChat.id}/workspace/diff`);
const byPath = new Map((res.data.files as Diff["files"]).map((file) => [file.path, file]));
check("the diff names the branch", res.status === 200 && res.data.branch === "main", JSON.stringify(res.data).slice(0, 200));
check("a changed file has its counts", byPath.get("src/app.ts")?.status === "modified" && byPath.get("src/app.ts")?.added === 2 && byPath.get("src/app.ts")?.removed === 1, JSON.stringify(byPath.get("src/app.ts")));
check("a new file is untracked, with its lines counted", byPath.get("NOTES.md")?.status === "untracked" && byPath.get("NOTES.md")?.added === 3, JSON.stringify(byPath.get("NOTES.md")));
check("a moved file is one rename", byPath.get("README.txt")?.status === "renamed" && byPath.get("README.txt")?.oldPath === "README.md" && !byPath.has("README.md"), JSON.stringify([...byPath.keys()]));
check("ignored files aren't listed", !byPath.has("dist/bundle.js"));
check("a link out of the folder is listed but not read", byPath.get("leak.txt")?.status === "untracked" && byPath.get("leak.txt")?.added === 0, JSON.stringify(byPath.get("leak.txt")));
res = await call<FileDiff>("GET", `/conversations/${checkoutChat.id}/workspace/diff/file?path=src/app.ts`);
check("a file's diff is git's unified diff", res.status === 200 && res.data.patch.includes("-export const answer = 41;") && res.data.patch.includes("+export const answer = 42;"), res.data.patch);
res = await call<FileDiff>("GET", `/conversations/${checkoutChat.id}/workspace/diff/file?path=NOTES.md`);
check("an untracked file's diff adds every line", res.data.patch.includes("@@ -0,0 +1,3 @@") && res.data.patch.includes("+three"), res.data.patch);
res = await call<FileDiff>("GET", `/conversations/${checkoutChat.id}/workspace/diff/file?path=README.txt&old=README.md`);
check("a rename's diff shows it as one", /rename from README.md/.test(res.data.patch), res.data.patch);
check("a diff out of the folder is refused", (await call("GET", `/conversations/${checkoutChat.id}/workspace/diff/file?path=../secret.txt`)).status === 400);
res = await call("GET", `/conversations/${checkoutChat.id}/workspace/diff/file?path=leak.txt`);
check("…and of a link out of it", res.status === 403 && !JSON.stringify(res.data).includes("the user's secret"), JSON.stringify(res.data));
check("a paired device may read the diff", (await call("GET", `/conversations/${checkoutChat.id}/workspace/diff`, asDevice)).status === 200);

writeFileSync(join(worktree, "src/app.ts"), "export const answer = 43;\n");
res = await call<Diff>("GET", `/conversations/${worktreeChat.id}/workspace/diff`);
const mine = (res.data.files as Diff["files"]).find((file) => file.path === "src/app.ts");
check("a worktree's diff comes from its computer, its branch named", res.status === 200 && /^tot\//.test(res.data.branch ?? "") && mine?.added === 1 && mine.removed === 1, JSON.stringify(res.data).slice(0, 300));
check("…and holds only its own changes", !(res.data.files as Diff["files"]).some((file) => file.path === "NOTES.md"));
res = await call<FileDiff>("GET", `/conversations/${worktreeChat.id}/workspace/diff/file?path=src/app.ts`);
check("…as does a file's diff there", res.data.patch.includes("+export const answer = 43;"), res.data.patch);

// =============================================================================
console.log("\n# Files");
type Files = import("@tot/shared/workspace").WorkspaceFiles;
type File = import("@tot/shared/workspace").WorkspaceFile;
type Search = import("@tot/shared/workspace").WorkspaceSearch;
writeFileSync(join(web, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
writeFileSync(join(web, "data.bin"), Buffer.from([1, 2, 0, 3]));
writeFileSync(join(web, "page.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
git(web, "add", "src/app.ts");
git(web, "commit", "-qm", "two");
rmSync(join(web, "README.txt"));
res = await call<Files>("GET", `/conversations/${checkoutChat.id}/workspace/files`);
const listed: string[] = res.data.files;
check("the folder's files are listed, new ones too", res.status === 200 && listed.includes("src/app.ts") && listed.includes("NOTES.md"), JSON.stringify(listed));
check("…but not what git ignores, nor files deleted from disk", !listed.includes("dist/bundle.js") && !listed.includes("README.txt") && !listed.includes("README.md"), JSON.stringify(listed));
res = await call<File>("GET", `/conversations/${checkoutChat.id}/workspace/file?path=src/app.ts`);
check("a text file is read", res.status === 200 && res.data.kind === "text" && res.data.content.startsWith("export const answer = 42;") && res.data.mtime > 0, JSON.stringify(res.data));
const opened: File = res.data;
check("an image is named as one", (await call<File>("GET", `/conversations/${checkoutChat.id}/workspace/file?path=logo.png`)).data.kind === "image");
check("a binary file isn't sent as text", (await call<File>("GET", `/conversations/${checkoutChat.id}/workspace/file?path=data.bin`)).data.kind === "binary");
res = await call("GET", `/conversations/${checkoutChat.id}/workspace/raw?path=page.svg`);
check("an image comes as it is, never runnable as a page", res.status === 200 && res.headers.get("content-type") === "image/svg+xml" && /sandbox/.test(res.headers.get("content-security-policy") ?? "") && res.headers.get("x-content-type-options") === "nosniff");
check("…and nothing but images does", (await call("GET", `/conversations/${checkoutChat.id}/workspace/raw?path=src/app.ts`)).status === 400);
for (const path of ["leak.txt", "home/secret.txt", "../secret.txt", ".git/config", join(HOME, "secret.txt")]) {
  res = await call("GET", `/conversations/${checkoutChat.id}/workspace/file?path=${encodeURIComponent(path)}`);
  check(`reading ${path} is refused`, [400, 403].includes(res.status) && !JSON.stringify(res.data).includes("the user's secret"), `${res.status} ${JSON.stringify(res.data)}`);
}

const save = (body: Record<string, unknown>, options: { headers?: Record<string, string>; from?: string } = {}) =>
  call("PUT", `/conversations/${checkoutChat.id}/workspace/file`, { body, ...options });
res = await save({ path: "src/app.ts", content: "export const answer = 44;\n", baseMtime: opened.mtime });
check("a file is saved", res.status === 200 && readFileSync(join(web, "src/app.ts"), "utf8") === "export const answer = 44;\n" && res.data.mtime >= opened.mtime, JSON.stringify(res.data));
res = await save({ path: "src/app.ts", content: "stale\n", baseMtime: opened.mtime - 5000 });
check("a save over a change made since is refused", res.status === 409 && readFileSync(join(web, "src/app.ts"), "utf8") === "export const answer = 44;\n", JSON.stringify(res.data));
res = await save({ path: "src/new.ts", content: "export {};\n" });
check("a new file can be made in a folder that's there", res.status === 200 && readFileSync(join(web, "src/new.ts"), "utf8") === "export {};\n");
check("…but not in one that isn't", (await save({ path: "nope/new.ts", content: "x" })).status === 400);
res = await save({ path: "leak.txt", content: "overwritten" });
check("saving through a link out of the folder is refused", res.status === 403 && readFileSync(join(HOME, "secret.txt"), "utf8") === "the user's secret\n", JSON.stringify(res.data));
check("…and into a linked folder outside it", (await save({ path: "home/planted.txt", content: "x" })).status === 403);
check("…and into git's own files", (await save({ path: ".git/hooks/pre-commit", content: "#!/bin/sh\n" })).status === 403);
check("…and out with “..”", (await save({ path: "../planted.txt", content: "x" })).status === 400);
res = await save({ path: "src/app.ts", content: "from a device\n" }, asDevice);
check("a paired device can't save", res.status === 403 && readFileSync(join(web, "src/app.ts"), "utf8") === "export const answer = 44;\n", JSON.stringify(res.data));
check("…but can read", (await call("GET", `/conversations/${checkoutChat.id}/workspace/file?path=src/app.ts`, asDevice)).status === 200);

const search = (query: string, flags = "") => call<Search>("GET", `/conversations/${checkoutChat.id}/workspace/search?q=${encodeURIComponent(query)}${flags}`);
res = await search("ANSWER");
check("search finds text in any case, with its line and column", res.status === 200 && res.data.hits.some((hit: any) => hit.path === "src/app.ts" && hit.line === 1 && hit.column === 14), JSON.stringify(res.data));
check("…not in any case when asked", (await search("ANSWER", "&case=1")).data.hits.length === 0);
check("…as a regular expression when asked", (await search("answer = \\d+", "&regex=1")).data.hits.some((hit: any) => hit.path === "src/app.ts"));
check("…and literally otherwise", (await search("answer = \\d+")).data.hits.length === 0);
check("a bad regular expression is a 400", (await search("(", "&regex=1")).status === 400);
check("search skips ignored files", !(await search("ignored")).data.hits.some((hit: any) => hit.path.startsWith("dist/")));
check("…and never reads through a link out of the folder", (await search("secret")).data.hits.every((hit: any) => !hit.text.includes("the user's secret")));

// =============================================================================
console.log("\n# Terminals");
type Terminal = import("@tot/shared/workspace").WorkspaceTerminal;
type TerminalEvent = import("@tot/shared/workspace").TerminalEvent;
async function until(condition: () => boolean, ms = 8000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (condition()) return true;
  return condition();
}
res = await call<Terminal>("POST", `/conversations/${checkoutChat.id}/workspace/terminals`, { body: { cols: 100, rows: 30 } });
const terminal: Terminal = res.data;
check("a terminal opens in the chat's folder", res.status === 201 && terminal.conversationId === checkoutChat.id && terminal.exitCode === null, JSON.stringify(res.data));
let printed = "";
const stopListening = terminals.subscribe(terminal.id, (event: TerminalEvent) => {
  if (event.type === "output") printed += event.data;
});
check("…and lists with the chat's terminals", (await call<Terminal[]>("GET", `/conversations/${checkoutChat.id}/workspace/terminals`)).data.some((t: Terminal) => t.id === terminal.id));
await call("POST", `/workspace/terminals/${terminal.id}/input`, { body: { data: "pwd; echo sum-$((40+2))\r" } });
check("typed commands run in a real shell, in the folder", await until(() => printed.includes("sum-42") && printed.includes(realpathSync.native(web))), printed.slice(-300));
check("…and it can be resized", (await call("POST", `/workspace/terminals/${terminal.id}/resize`, { body: { cols: 120, rows: 40 } })).status === 200);
check("…not to a size that isn't one", (await call("POST", `/workspace/terminals/${terminal.id}/resize`, { body: { cols: "wide" } })).status === 400);
let replayed = "";
const stopReplay = terminals.subscribe(terminal.id, (event: TerminalEvent) => {
  if (event.type === "output") replayed += event.data;
});
check("whoever opens it later gets what it printed", replayed.includes("sum-42"));
stopReplay();
stopListening();
res = await call("GET", `/workspace/terminals/${terminal.id}/stream`, asDevice);
check("a paired device can't watch a terminal", res.status === 403);
check("…nor open one", (await call("POST", `/conversations/${checkoutChat.id}/workspace/terminals`, { body: {}, ...asDevice })).status === 403);
check("…nor type into one", (await call("POST", `/workspace/terminals/${terminal.id}/input`, { body: { data: "touch pwned\r" }, ...asDevice })).status === 403);
res = await call("POST", `/conversations/${checkoutChat.id}/workspace/terminals`, { body: {}, headers: { authorization: `Bearer ${process.env.TOT_ACCESS_TOKEN}` }, from: "192.168.1.70" });
check("the access token gets no terminal", res.status === 403);
const login = await app.request(
  "http://127.0.0.1:8787/login",
  { method: "POST", body: new URLSearchParams({ password: process.env.TOT_ACCESS_TOKEN!, next: "/" }).toString(), headers: { host: "127.0.0.1:8787", "content-type": "application/x-www-form-urlencoded" } },
  { incoming: { socket: { remoteAddress: "192.168.1.70", remotePort: 50000, remoteFamily: "IPv4" } } },
);
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
res = await call<Terminal[]>("GET", `/conversations/${checkoutChat.id}/workspace/terminals`, { headers: { cookie }, from: "192.168.1.70" });
check("the owner signed in on another device may use terminals", Boolean(cookie) && res.status === 200 && res.data.length === 1, `${res.status} ${cookie.slice(0, 20)}`);
check("closing a terminal ends its shell", (await call("DELETE", `/workspace/terminals/${terminal.id}`)).status === 200 && terminals.count() === 0);
check("a closed terminal is gone", (await call("POST", `/workspace/terminals/${terminal.id}/input`, { body: { data: "x" } })).status === 404);

const another: Conversation = (await create({ projectId: project.id, workspace: "checkout" })).data;
const shell: Terminal = (await call<Terminal>("POST", `/conversations/${another.id}/workspace/terminals`, { body: {} })).data;
let exited: number | null = null;
terminals.subscribe(shell.id, (event: TerminalEvent) => {
  if (event.type === "exit") exited = event.exitCode;
});
await call("POST", `/workspace/terminals/${shell.id}/input`, { body: { data: "exit 3\r" } });
check("a shell that exits says so, and its terminal goes", (await until(() => exited === 3)) && terminals.list(another.id).length === 0, String(exited));
await call<Terminal>("POST", `/conversations/${another.id}/workspace/terminals`, { body: {} });
check("…and a chat can open another", terminals.list(another.id).length === 1);
await call("DELETE", `/conversations/${another.id}`);
check("deleting the chat ends its terminals", terminals.list(another.id).length === 0 && terminals.count() === 0);

// =============================================================================
console.log("\n# Dev servers");
type Server = import("@tot/shared/workspace").WorkspaceServer;
const SERVE = "require('http').createServer((q, r) => r.end('ok')).listen(Number(process.argv[1]), '127.0.0.1')";
const port = 37_000 + Math.floor(Math.random() * 2000) * 2;
const inFolder = spawn(process.execPath, ["-e", SERVE, String(port)], { cwd: web, stdio: "ignore" });
const elsewhere = spawn(process.execPath, ["-e", SERVE, String(port + 1)], { cwd: HOME, stdio: "ignore" });
process.on("exit", () => {
  inFolder.kill();
  elsewhere.kill();
});
const answers = async (p: number) => {
  try {
    return (await fetch(`http://127.0.0.1:${p}`)).ok;
  } catch {
    return false;
  }
};
await sleep(300);
for (let i = 0; i < 40 && !((await answers(port)) && (await answers(port + 1))); i++) await sleep(100);
res = await call<Server[]>("GET", `/conversations/${checkoutChat.id}/workspace/servers`);
check("a dev server running from the folder is found", res.status === 200 && res.data.some((server: Server) => server.port === port && server.source === "process" && server.url === `http://localhost:${port}`), JSON.stringify(res.data));
check("…but not one running from elsewhere", !res.data.some((server: Server) => server.port === port + 1));
const printer: Terminal = (await call<Terminal>("POST", `/conversations/${checkoutChat.id}/workspace/terminals`, { body: {} })).data;
await call("POST", `/workspace/terminals/${printer.id}/input`, { body: { data: `echo "ready on http://localhost:${port + 1}/"\r` } });
await until(() => terminals.get(printer.id).scrollback.includes(`ready on http`), 5000);
res = await call<Server[]>("GET", `/conversations/${checkoutChat.id}/workspace/servers`);
check("an address the chat's terminal printed counts too, when it answers", res.data.some((server: Server) => server.port === port + 1 && server.source === "terminal"), JSON.stringify(res.data));
await call("DELETE", `/workspace/terminals/${printer.id}`);
check("another device can't list them", (await call("GET", `/conversations/${checkoutChat.id}/workspace/servers`, { headers: { cookie }, from: "192.168.1.70" })).status === 403);
inFolder.kill();
elsewhere.kill();

// =============================================================================
console.log("\n# Git");
type Git = import("@tot/shared/workspace").WorkspaceGit;
type GitResult = import("@tot/shared/workspace").WorkspaceGitResult;
type AgentProvider = import("./agent/providers/types.ts").AgentProvider;
// Models that write commit messages without leaving this machine.
const prompts: string[] = [];
const claude = providers.claude as AgentProvider;
providers.claude = {
  ...claude,
  status: async () => ({ id: "claude", label: "Claude", installed: true, loggedIn: true, models: [] }),
  complete: async (prompt: string) => {
    prompts.push(prompt);
    return "Raise the answer\n\nRead it once and keep it.";
  },
} as AgentProvider;
providers.chatgpt = { ...providers.chatgpt, status: async () => ({ id: "chatgpt", label: "ChatGPT", installed: false, loggedIn: false, models: [] }) } as AgentProvider;
const pulls: { path: string; body: any; auth: string }[] = [];
const fakeGitHub = createServer((req, res) => {
  let text = "";
  req.on("data", (chunk) => (text += chunk));
  req.on("end", () => {
    pulls.push({ path: req.url ?? "", body: text ? JSON.parse(text) : null, auth: String(req.headers.authorization ?? "") });
    if (req.method === "POST" && req.url === "/repos/acme/web/pulls") {
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ number: 7, html_url: "https://github.example/acme/web/pull/7" }));
    } else res.writeHead(404, { "content-type": "application/json" }).end("{}");
  });
});
await new Promise<void>((resolve) => fakeGitHub.listen(GITHUB_PORT, "127.0.0.1", resolve));
process.on("exit", () => fakeGitHub.close());

// The checkout's origin names GitHub, but pushes go to a bare repo on this machine.
const remote = join(HOME, "remote/web.git");
mkdirSync(remote, { recursive: true });
git(remote, "init", "-q", "--bare", "-b", "main");
git(web, "remote", "add", "origin", "https://github.com/acme/web.git");
git(web, "config", "remote.origin.pushurl", remote);
git(web, "add", "-A");
git(web, "commit", "-qm", "before the panel");
const gitPath = `/conversations/${checkoutChat.id}/workspace/git`;
res = await call<Git>("GET", gitPath);
check("git's state: branch, default branch, GitHub repo", res.status === 200 && res.data.branch === "main" && res.data.defaultBranch === "main" && res.data.github === "acme/web" && res.data.changes === 0, JSON.stringify(res.data));
check("…and why a pull request can't be opened yet", !res.data.canOpenPr && /Connect GitHub/.test(res.data.prProblem ?? ""), JSON.stringify(res.data));
writeFileSync(join(web, "src/app.ts"), "export const answer = 45;\n");
writeFileSync(join(web, "CHANGES.md"), "- answer\n");
check("changed and new files count", (await call<Git>("GET", gitPath)).data.changes === 2);
res = await call<{ message: string }>("POST", `${gitPath}/message`);
check("a commit message is suggested from the diff", res.status === 200 && res.data.message.startsWith("Raise the answer") && prompts.at(-1)!.includes("answer = 45") && prompts.at(-1)!.includes("CHANGES.md"), JSON.stringify(res.data));
res = await call("POST", `${gitPath}/commit`, { body: { message: "From a device" }, ...asDevice });
check("a paired device can't commit", res.status === 403 && (await call<Git>("GET", gitPath)).data.changes === 2);
check("a commit needs a message", (await call("POST", `${gitPath}/commit`, { body: { message: "  " } })).status === 400);
res = await call<GitResult>("POST", `${gitPath}/commit`, { body: { message: "Raise the answer", push: true } });
check("pushing to the default branch needs an OK, and nothing is committed without it", res.status === 409 && /needs your OK/.test(JSON.stringify(res.data)) && (await call<Git>("GET", gitPath)).data.changes === 2, JSON.stringify(res.data));
res = await call<GitResult>("POST", `${gitPath}/commit`, { body: { message: "Raise the answer\n\nRead it once." } });
check("everything is committed, as the user", res.status === 200 && res.data.git.changes === 0 && /Committed 2 files/.test(res.data.summary) && git(web, "log", "-1", "--format=%an <%ae>|%s") === "Pat User <pat@example.com>|Raise the answer", JSON.stringify(res.data));
check("…and with nothing left, a commit is refused", (await call("POST", `${gitPath}/commit`, { body: { message: "x" } })).status === 409);
res = await call<GitResult>("POST", `${gitPath}/push`, { body: { confirmDefault: true } });
check("with the OK, it's pushed (and tracks it)", res.status === 200 && git(remote, "rev-parse", "main") === git(web, "rev-parse", "HEAD") && res.data.git.upstream === "origin/main" && res.data.git.ahead === 0, JSON.stringify(res.data));

git(web, "checkout", "-q", "-b", "feature/cache");
writeFileSync(join(web, "src/app.ts"), "export const answer = 46;\n");
res = await call<GitResult>("POST", `${gitPath}/commit`, { body: { message: "Cache the answer", pr: true } });
check("a pull request needs GitHub connected", res.status === 409 && /Connect GitHub/.test(JSON.stringify(res.data)) && (await call<Git>("GET", gitPath)).data.changes === 1, JSON.stringify(res.data));
setSecret("githubToken", "ghp_testtokenthatisnotreal000000000000");
const connection = { login: "pat", name: "Pat", avatarUrl: "", source: "token", scopes: ["repo"], connectedAt: Date.now(), id: 1 };
db.prepare(`INSERT INTO settings (key, value) VALUES ('github', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify({ connection, allowWrites: false }));
check("…allowed to write", /GitHub writes/.test((await call<Git>("GET", gitPath)).data.prProblem ?? ""));
db.prepare(`UPDATE settings SET value = ? WHERE key = 'github'`).run(JSON.stringify({ connection, allowWrites: true }));
res = await call<GitResult>("POST", `${gitPath}/commit`, { body: { message: "Cache the answer\n\nOnce read, kept.", pr: true } });
const draft = pulls.find((pull) => pull.path === "/repos/acme/web/pulls");
check("commit, push and a draft pull request, in one", res.status === 200 && res.data.pr?.number === 7 && /opened draft PR #7/.test(res.data.summary) && git(remote, "rev-parse", "feature/cache") === git(web, "rev-parse", "HEAD"), JSON.stringify(res.data));
check("…a draft from the branch into the default one, through the fake GitHub only", draft?.body?.draft === true && draft.body.head === "feature/cache" && draft.body.base === "main" && draft.body.title === "Cache the answer" && draft.body.body.startsWith("Once read, kept.") && draft.auth === "Bearer ghp_testtokenthatisnotreal000000000000", JSON.stringify(draft));
git(web, "checkout", "-q", "main");

// Pull and sync, with a remote that's a folder on this machine.
const libRemote = join(HOME, "remote/lib.git");
mkdirSync(libRemote, { recursive: true });
git(libRemote, "init", "-q", "--bare", "-b", "main");
const lib = join(HOME, "code/lib");
mkdirSync(lib, { recursive: true });
git(lib, "init", "-q", "-b", "main");
writeFileSync(join(lib, "lib.txt"), "one\n");
git(lib, "add", ".");
git(lib, "commit", "-qm", "one");
git(lib, "remote", "add", "origin", libRemote);
git(lib, "push", "-q", "-u", "origin", "main");
const other = join(HOME, "elsewhere/lib");
execFileSync("git", ["clone", "-q", libRemote, other], { env: GIT_ENV });
writeFileSync(join(other, "lib.txt"), "one\ntwo\n");
git(other, "commit", "-qam", "two");
git(other, "push", "-q", "origin", "main");
const libProject: Project = (await call<Project>("POST", "/projects", { body: { kind: "folder", source: lib, grant: true } })).data;
const libChat: Conversation = (await create({ projectId: libProject.id, workspace: "checkout" })).data;
const libGit = `/conversations/${libChat.id}/workspace/git`;
await call("POST", `${libGit}/sync`, { body: { confirmDefault: true } });
check("pull fast-forwards to what was pushed elsewhere", readFileSync(join(lib, "lib.txt"), "utf8") === "one\ntwo\n");
writeFileSync(join(lib, "lib.txt"), "one\ntwo\nthree\n");
await call("POST", `${libGit}/commit`, { body: { message: "three" } });
res = await call<GitResult>("POST", `${libGit}/sync`);
check("sync won't push to the default branch without an OK", res.status === 409 && /needs your OK/.test(JSON.stringify(res.data)), JSON.stringify(res.data));
res = await call<GitResult>("POST", `${libGit}/sync`, { body: { confirmDefault: true } });
check("…and with it, pulls then pushes", res.status === 200 && git(libRemote, "rev-parse", "main") === git(lib, "rev-parse", "HEAD") && res.data.git.ahead === 0, JSON.stringify(res.data));
git(other, "pull", "-q", "--ff-only");
writeFileSync(join(other, "lib.txt"), "elsewhere\n");
git(other, "commit", "-qam", "elsewhere");
git(other, "push", "-q", "origin", "main");
writeFileSync(join(lib, "lib.txt"), "here\n");
git(lib, "commit", "-qam", "here");
res = await call<GitResult>("POST", `${libGit}/pull`);
check("a pull that can't fast-forward is refused, nothing merged", res.status === 409 && /both moved on/.test(JSON.stringify(res.data)) && readFileSync(join(lib, "lib.txt"), "utf8") === "here\n", JSON.stringify(res.data));

// A worktree's git runs on the chat's computer, in its sandbox.
writeFileSync(join(worktree, "WORKTREE.md"), "made in the worktree\n");
const worktreeGit = `/conversations/${worktreeChat.id}/workspace/git`;
res = await call<GitResult>("POST", `${worktreeGit}/commit`, { body: { message: "Note the worktree" } });
check("a worktree chat commits on its own branch, as the user", res.status === 200 && /^tot\//.test(res.data.git.branch ?? "") && git(worktree, "log", "-1", "--format=%an|%s") === "Pat User|Note the worktree", JSON.stringify(res.data));
check("…and the main checkout doesn't see it", !git(web, "log", "--format=%s", "-5").includes("Note the worktree"));

console.log(failures ? `\n${failures} check(s) failed` : "\nAll workspace checks passed");
process.exit(failures ? 1 : 0);
