// The workspace panel: a chat's folder (its project's main checkout, or its own worktree) and what the panel may
// do in it. Covers finding the folder, paths kept inside it (no "..", no git's own files, no symlink out of it),
// who may read, change and open terminals, and each tab's routes. Real git and the macOS sandbox in a temp HOME,
// the local computer backend, a fake GitHub; no network.
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

const { createApp } = await import("./app.ts");
const { chatWorkspaces } = await import("./chats/workspace.ts");
const { computerManager } = await import("./computer/manager.ts");
const { agents } = await import("./data/agents.ts");
const { conversations } = await import("./data/conversations.ts");
const { settings } = await import("./data/settings.ts");
const { peers } = await import("./devices/peers.ts");
const { cleanPath, inside } = await import("./workspace/root.ts");
const { workspaceWatch } = await import("./workspace/watch.ts");

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

console.log(failures ? `\n${failures} check(s) failed` : "\nAll workspace checks passed");
process.exit(failures ? 1 : 0);
