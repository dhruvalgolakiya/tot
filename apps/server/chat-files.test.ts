// Files for the composer's "@": a chat's working folder listed (git-aware: tracked and untracked, minus what .gitignore
// leaves out), ranked for what's typed, kept briefly; and the files a message names going to the model. Real git in a
// temp HOME with a local (sandboxed) computer; fake providers, no network.
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { ChatFiles, Conversation, Project } from "@tot/shared/types";

// A temp home in the repo's git-ignored .scratch (not the system temp folder, which sandboxed commands may write).
const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".scratch");
mkdirSync(SCRATCH, { recursive: true });
const HOME = realpathSync.native(mkdtempSync(join(SCRATCH, "home-")));
process.env.HOME = HOME;
process.on("exit", () => rmSync(HOME, { recursive: true, force: true }));
process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test
const PORT = 40_000 + Math.floor(Math.random() * 2000);

const { sendMessage } = await import("./agent/orchestrator.ts");
const { providers } = await import("./agent/providers/index.ts");
const { chatFiles, rankFiles } = await import("./chats/files.ts");
const { computerManager } = await import("./computer/manager.ts");
const { agents } = await import("./data/agents.ts");
const { messages } = await import("./data/messages.ts");
const { settings } = await import("./data/settings.ts");
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

const turns: TurnInput[] = [];
const fake: AgentProvider = {
  id: "claude",
  label: "Claude",
  status: async () => ({
    id: "claude",
    accountId: "claude",
    label: "Claude",
    installed: true,
    loggedIn: true,
    models: [{ id: "claude:claude-opus-5-5", provider: "claude", accountId: "claude", model: "claude-opus-5-5", label: "Opus", available: true }],
  }),
  async *runTurn(input) {
    turns.push(input);
    yield { type: "session", sessionId: input.sessionId ?? "session-1" };
    yield { type: "text-delta", blockId: "b1", delta: "Done." };
  },
  complete: async () => "A title",
};
providers.claude = fake;

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
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

// --- Ranking ------------------------------------------------------------------------------------------------------------
const paths = ["src/components/Composer.tsx", "src/components/ComposerMenu.tsx", "src/lib/compose.ts", "docs/composer-notes.md", "README.md", "src/store.ts", "apps/web/src/main.tsx"];
check("an exact file name comes first", rankFiles(paths, "store.ts")[0] === "src/store.ts");
check("a name's start beats a match deeper in", rankFiles(paths, "compo")[0] === "src/lib/compose.ts" || rankFiles(paths, "compo")[0] === "src/components/Composer.tsx", rankFiles(paths, "compo").join(", "));
check("…and names beat folders", rankFiles(paths, "composer").slice(0, 2).every((path) => path.split("/").pop()!.toLowerCase().includes("composer")));
check("letters in order find a file", rankFiles(paths, "cmpmenu")[0] === "src/components/ComposerMenu.tsx", rankFiles(paths, "cmpmenu").join(", "));
check("a path with a slash matches the path", rankFiles(paths, "web/src")[0] === "apps/web/src/main.tsx");
check("no match, no result", rankFiles(paths, "zzzq").length === 0);
check("case doesn't matter", rankFiles(paths, "README")[0] === "README.md");
check("an empty query lists shallow files first", rankFiles(paths, "")[0] === "README.md");
check("the limit holds", rankFiles(paths, "s", 2).length === 2);

// --- Cleaning what a message names ----------------------------------------------------------------------------------------
check("paths stay relative and inside the folder", JSON.stringify(chatFiles.clean(["./src/a.ts", "/etc/passwd", "../up.txt", "a/../../b", "src/a.ts", 3, ""])) === JSON.stringify(["src/a.ts"]));
check("…at most 20", chatFiles.clean(Array.from({ length: 30 }, (_, i) => `f${i}.txt`)).length === 20);

// --- Listing a folder project's files ------------------------------------------------------------------------------------
const tot = agents.create({ name: "Tot", mascot });
await computerManager.ensure(tot.id);
const repo = join(HOME, "code/shop");
mkdirSync(repo, { recursive: true });
git(repo, "init", "-q", "-b", "main");
write(repo, ".gitignore", "dist/\n*.log\n");
write(repo, "src/cart.ts", "export const cart = [];\n");
write(repo, "src/checkout/pay.ts", "export function pay() {}\n");
write(repo, "README.md", "# Shop\n");
git(repo, "add", ".");
git(repo, "commit", "-qm", "init");
write(repo, "src/new-file.ts", "// not committed yet\n");
write(repo, "dist/bundle.js", "ignored");
write(repo, "debug.log", "ignored");
write(repo, "big.txt", "x".repeat(20_000));

const project: Project = (await request<Project>("POST", "/projects", { kind: "folder", source: repo, grant: true })).data;
const chat: Conversation = (await request<Conversation>("POST", "/conversations", { agentId: tot.id, projectId: project.id, modelId: "claude:claude-opus-5-5" })).data;
let r = await request<ChatFiles>("GET", `/conversations/${chat.id}/files?q=`);
const all = r.data.files;
check("the chat's files are listed", r.status === 200 && all.includes("src/cart.ts") && all.includes("src/checkout/pay.ts") && all.includes("README.md"), JSON.stringify(r.data));
check("…untracked ones too", all.includes("src/new-file.ts"));
check("…without what .gitignore leaves out", !all.some((path) => path.startsWith("dist/") || path.endsWith(".log")), all.join(", "));
check("…and the total is counted", r.data.total === all.length && r.data.total >= 6, String(r.data.total));
check("the folder's real path comes along, for paths dragged in", r.data.root === realpathSync.native(repo), String(r.data.root));
r = await request<ChatFiles>("GET", `/conversations/${chat.id}/files?q=pay`);
check("a query narrows it, best first", r.data.files[0] === "src/checkout/pay.ts", r.data.files.join(", "));
write(repo, "src/later.ts", "// made after the listing\n");
r = await request<ChatFiles>("GET", `/conversations/${chat.id}/files?q=later`);
check("the listing is kept for a while (no relisting per keystroke)", r.data.files.length === 0);
chatFiles.reset();
r = await request<ChatFiles>("GET", `/conversations/${chat.id}/files?q=later`);
check("…and listed again after", r.data.files[0] === "src/later.ts", r.data.files.join(", "));
r = await request<ChatFiles>("GET", `/conversations/${chat.id}/files?q=s&limit=2`);
check("the limit is honoured", r.data.files.length === 2);

// A chat not sent yet, from the project's page.
r = await request<ChatFiles>("GET", `/projects/${project.id}/files?agentId=${tot.id}&q=cart`);
check("a new chat in the project lists the same files", r.status === 200 && r.data.files[0] === "src/cart.ts", JSON.stringify(r.data));
check("an unknown project is a 404", (await request("GET", "/projects/nope/files")).status === 404);

// A chat in no project, and a topic project: nothing to list, said so.
const loose: Conversation = (await request<Conversation>("POST", "/conversations", { agentId: tot.id })).data;
r = await request<ChatFiles>("GET", `/conversations/${loose.id}/files?q=a`);
check("a chat in no project has no files, and says why", r.status === 200 && r.data.files.length === 0 && Boolean(r.data.unavailable), JSON.stringify(r.data));
const topic: Project = (await request<Project>("POST", "/projects", { kind: "none", name: "Launch" })).data;
const topicChat: Conversation = (await request<Conversation>("POST", "/conversations", { agentId: tot.id, projectId: topic.id })).data;
r = await request<ChatFiles>("GET", `/conversations/${topicChat.id}/files`);
check("…nor does a topic project's", r.data.files.length === 0 && Boolean(r.data.unavailable));
check("an unknown chat is a 404", (await request("GET", "/conversations/nope/files")).status === 404);

// A plain folder, not a repo: every file, still without .git or node_modules.
const plain = join(HOME, "code/notes");
write(plain, "todo.md", "- ship\n");
write(plain, "node_modules/x/index.js", "skip");
const plainProject: Project = (await request<Project>("POST", "/projects", { kind: "folder", source: plain, grant: true })).data;
const plainChat: Conversation = (await request<Conversation>("POST", "/conversations", { agentId: tot.id, projectId: plainProject.id })).data;
r = await request<ChatFiles>("GET", `/conversations/${plainChat.id}/files`);
check("outside a repo, every file (but node_modules)", JSON.stringify(r.data.files) === JSON.stringify(["todo.md"]), JSON.stringify(r.data));

// --- A message naming files -----------------------------------------------------------------------------------------------
const { runId, userMessage } = await sendMessage(chat.id, { text: "why does @src/cart.ts break?", files: ["src/cart.ts", "big.txt", "../secret", "missing.ts"] });
await runEnd(runId);
const prompt = turns.at(-1)!.prompt;
check("the named files are kept on the message", JSON.stringify(userMessage.files) === JSON.stringify(["src/cart.ts", "big.txt", "missing.ts"]), JSON.stringify(userMessage.files));
check("…stored, so they survive a reload", JSON.stringify(messages.get(userMessage.id)?.files) === JSON.stringify(userMessage.files));
check("the model hears which files", prompt.includes("- src/cart.ts") && prompt.includes("- big.txt") && prompt.includes("- missing.ts"), prompt);
check("…with a small text file's contents", prompt.includes('<file path="src/cart.ts">\nexport const cart = [];'), prompt);
check("…but not a big one's", !prompt.includes("xxxxxxxxxx"));
check("…and the message after", prompt.endsWith("why does @src/cart.ts break?"));
check("a path outside the folder never reaches the model", !prompt.includes("secret"));
const quiet = await sendMessage(chat.id, { text: "and now?" });
await runEnd(quiet.runId);
check("a message naming none adds nothing", turns.at(-1)!.prompt === "and now?" && quiet.userMessage.files === undefined, turns.at(-1)!.prompt);

server.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
