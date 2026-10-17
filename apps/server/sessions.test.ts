// Importing a project's local Claude Code and Codex sessions as chats. Fake config folders and session files in a temp
// home (the real ~/.claude*, ~/.codex* and ~/.ccs are never read), a folder project with real git worktrees, and fake
// providers behind the real turn pipeline: discovery by project path (worktrees, path encoding, decoys), what's left
// out (meta, sidechain, subagent threads), how each kind of record maps, account binding and copying, dedupe, the
// resume options a continued chat's turn gets, and a large session importing quickly with its outputs clipped.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx apps/server/sessions.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImportSessionsResult, LocalSessionList, Message, MessagePart, ModelOption, Project } from "@tot/shared/types";

process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test
const HOME = realpathSync.native(mkdtempSync(join(tmpdir(), "tot-sessions-home-")));
process.env.HOME = HOME;
process.env.TOT_ACCOUNTS_HOME = HOME;
// TOT's built-in accounts use folders of their own here, so ~/.claude and ~/.codex are folders no account uses.
process.env.TOT_CLAUDE_CONFIG_DIR = join(HOME, ".claude-tot");
process.env.CODEX_HOME = join(HOME, ".codex-tot");
process.on("exit", () => rmSync(HOME, { recursive: true, force: true }));

const { sendMessage } = await import("./agent/orchestrator.ts");
const { accountProviders, providers } = await import("./agent/providers/index.ts");
const { accounts } = await import("./accounts/accounts.ts");
const { agents } = await import("./data/agents.ts");
const { conversations } = await import("./data/conversations.ts");
const { messages } = await import("./data/messages.ts");
const { settings } = await import("./data/settings.ts");
const { createApp } = await import("./app.ts");
const { projects } = await import("./projects/projects.ts");
const { runEnd } = await import("./tasks/run-loop.ts");
const { claudeProjectDirName, mayHoldFolder, promptText } = await import("./sessions/claude.ts");
const { gitWorktrees, sessionSources } = await import("./sessions/discovery.ts");
const { sessionImports } = await import("./sessions/imports.ts");
type AgentProvider = import("./agent/providers/types.ts").AgentProvider;
type TurnInput = import("./agent/providers/types.ts").TurnInput;
type ToolPart = Extract<MessagePart, { type: "tool" }>;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 300)}` : ""}`);
}
settings.patch({ computer: { mode: "off" }, memory: { enabled: false } });

// --- Fake providers, recording each turn's input -------------------------------------------------------------------
const turns: { account: string; input: TurnInput }[] = [];
function fakeProvider(account: string, driver: "claude" | "chatgpt", models: string[]): AgentProvider {
  return {
    id: driver,
    label: account,
    status: async () => ({
      id: driver,
      accountId: account,
      label: account,
      installed: true,
      loggedIn: true,
      models: models.map((model): ModelOption => ({ id: `${account}:${model}`, provider: driver, accountId: account, model, label: model, available: true })),
    }),
    async *runTurn(input) {
      turns.push({ account, input });
      yield { type: "session", sessionId: input.sessionId ?? `${account}-fresh-${turns.length}` };
      yield { type: "text-delta", blockId: "b1", delta: "Picked up where we left off." };
    },
    complete: async () => "A title",
  };
}
providers.claude = fakeProvider("claude", "claude", ["claude-opus-5-5", "claude-sonnet-5-5"]);
providers.chatgpt = fakeProvider("chatgpt", "chatgpt", ["gpt-6.1-sol"]);
const work = accounts.add({ driver: "claude", name: "Claude Work", configDir: "~/.claude-work" });
accountProviders.use(work.id, fakeProvider(work.id, "claude", ["claude-opus-5-5"]));

// --- A folder project with dots, an underscore and a space in its path, and real git worktrees ----------------------
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
const FOLDER = join(HOME, "code", "my.app_v2 beta");
mkdirSync(FOLDER, { recursive: true });
git(FOLDER, "init", "-q", "-b", "main");
writeFileSync(join(FOLDER, "notes.txt"), "hello\n");
git(FOLDER, "add", ".");
git(FOLDER, "commit", "-qm", "init");
const FEATURE = join(HOME, "code", "my.app_v2 beta-feature"); // a plain worktree beside it, sharing its encoded prefix
git(FOLDER, "worktree", "add", "-q", "-b", "feature-x", FEATURE);
const TOT_TREE = join(FOLDER, ".tot-worktrees", "fix-thing-3f2a");
git(FOLDER, "worktree", "add", "-q", "-b", "tot/fix-thing-3f2a", TOT_TREE);
const SUBDIR = join(FOLDER, "apps", "web");
mkdirSync(SUBDIR, { recursive: true });
const DECOY = join(HOME, "code", "my.app_v2 beta-other"); // not the project: its encoded name starts the same

const agent = agents.create({ name: "Tot", mascot: { shape: "blob", color: "#60a5fa", accessory: "none", eyes: "dots" } });
const project: Project = projects.create({ kind: "folder", source: FOLDER, grant: true });

// --- Fixture sessions, in the CLIs' formats -----------------------------------------------------------------------
const writeLines = (path: string, records: unknown[]) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
};
const at = (iso: string, plusSeconds = 0) => new Date(Date.parse(iso) + plusSeconds * 1000).toISOString();
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function claudeFile(dir: string, cwd: string, id: string, records: unknown[]): string {
  const path = join(HOME, dir, "projects", claudeProjectDirName(cwd), `${id}.jsonl`);
  writeLines(path, records);
  return path;
}
function claudeRecords(id: string, cwd: string, start: string, branch = "main") {
  let n = 0;
  const base = (extra: Record<string, unknown>) => ({ parentUuid: null, isSidechain: false, uuid: `${id}-${++n}`, timestamp: at(start, n), cwd, sessionId: id, gitBranch: branch, version: "2.4.0", ...extra });
  return {
    user: (content: unknown, extra: Record<string, unknown> = {}) => base({ type: "user", message: { role: "user", content }, ...extra }),
    assistant: (messageId: string, block: unknown, extra: Record<string, unknown> = {}) =>
      base({ type: "assistant", message: { id: messageId, role: "assistant", model: "claude-opus-5-5", content: [block] }, ...extra }),
    result: (toolUseId: string, content: unknown, isError = false) => base({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] } }),
    system: (extra: Record<string, unknown>) => base({ type: "system", ...extra }),
  };
}

// A: in ~/.claude (no account uses it), in the project's folder: every kind of record.
const A = "11111111-1111-4111-8111-111111111111";
const a = claudeRecords(A, FOLDER, "2026-10-10T10:00:00Z");
const A_PATH = claudeFile(".claude", FOLDER, A, [
  { type: "file-history-snapshot", messageId: "x", snapshot: {} },
  a.user("<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>", { isMeta: true }),
  a.user("Fix the login bug in auth.ts"),
  a.assistant("m1", { type: "thinking", thinking: "Looking at auth first.", signature: "sig" }, { thinkingDurationMs: 1200 }),
  a.assistant("m1", { type: "text", text: "I'll look at auth.ts." }),
  a.assistant("m1", { type: "tool_use", id: "tu1", name: "Read", input: { file_path: `${FOLDER}/src/auth.ts` } }),
  a.result("tu1", "export function login() {}"),
  a.assistant("m2", { type: "tool_use", id: "tu2", name: "Bash", input: { command: "npm test", description: "Run the tests" } }),
  a.result("tu2", [{ type: "text", text: "x".repeat(50_000) }], true),
  a.assistant("m3", { type: "tool_use", id: "tu3", name: "mcp__github__create_issue", input: { owner: "acme", repo: "web", title: "Login" } }),
  a.result("tu3", "Created #12"),
  a.assistant("m3", { type: "tool_use", id: "tu4", name: "Edit", input: { file_path: `${FOLDER}/src/auth.ts`, old_string: "a", new_string: "b" } }),
  a.result("tu4", "Edited"),
  a.assistant("m3", { type: "tool_use", id: "tu5", name: "FancyTool", input: { level: 3 } }),
  a.result("tu5", "ok"),
  a.assistant("sub", { type: "text", text: "A subagent's own words." }, { isSidechain: true }),
  a.user("Subagent prompt", { isSidechain: true }),
  a.system({ subtype: "compact_boundary", content: "Conversation compacted", compactMetadata: { trigger: "auto" } }),
  a.user("This session is being continued from a previous conversation that ran out of context.", { isCompactSummary: true }),
  a.user([{ type: "text", text: "And add a test" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }]),
  a.user("<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>PR 12</command-args>"),
  a.user("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>"),
  a.user("<local-command-stdout>Set model to opus</local-command-stdout>"),
  a.assistant("m4", { type: "text", text: "Done." }),
  a.assistant("err", { type: "text", text: "API Error: overloaded" }, { isApiErrorMessage: true }),
  a.user("[Request interrupted by user]"),
  { type: "ai-title", aiTitle: "Fixing the login", sessionId: A },
  { type: "custom-title", customTitle: "Login bug fix", sessionId: A },
  { type: "ai-title", aiTitle: "A later machine title", sessionId: A },
]);
const A_HASH = createHash("sha256").update(readFileSync(A_PATH)).digest("hex");

// A2: also in ~/.claude, below the project's folder; imported without picking an account.
const A2 = "22222222-2222-4222-8222-222222222222";
const a2 = claudeRecords(A2, SUBDIR, "2026-10-09T09:00:00Z");
claudeFile(".claude", SUBDIR, A2, [a2.user("Tidy the web app"), a2.assistant("m1", { type: "text", text: "Tidied." })]);

// B: in the Claude Work account's folder, in the plain worktree beside the project.
const B = "33333333-3333-4333-8333-333333333333";
const b = claudeRecords(B, FEATURE, "2026-10-11T11:00:00Z", "feature-x");
claudeFile(".claude-work", FEATURE, B, [b.user("Build the feature"), b.assistant("m1", { type: "text", text: "Built." })]);
// C: only meta and subagent records; plus a subagent's own file and folder beside B.
const C = "44444444-4444-4444-8444-444444444444";
const c = claudeRecords(C, FOLDER, "2026-10-11T12:00:00Z");
claudeFile(".claude-work", FOLDER, C, [c.user("<system-reminder>x</system-reminder>", { isMeta: true }), c.user("Subagent work", { isSidechain: true })]);
writeLines(join(HOME, ".claude-work", "projects", claudeProjectDirName(FOLDER), "agent-a1b2c3.jsonl"), [c.user("A sidechain's prompt")]);
writeLines(join(HOME, ".claude-work", "projects", claudeProjectDirName(FEATURE), B, "subagents", "agent-1.jsonl"), [b.user("Inside a subagent")]);

// D: TOT's built-in Claude folder, in the decoy folder (its projects folder name starts like the project's).
const D = "55555555-5555-4555-8555-555555555555";
const d = claudeRecords(D, DECOY, "2026-10-12T08:00:00Z");
claudeFile(".claude-tot", DECOY, D, [d.user("Not this project"), d.assistant("m1", { type: "text", text: "No." })]);
// E: TOT's built-in Claude folder, in the project's TOT worktree.
const E = "66666666-6666-4666-8666-666666666666";
const e = claudeRecords(E, TOT_TREE, "2026-10-12T12:00:00Z", "tot/fix-thing-3f2a");
claudeFile(".claude-tot", TOT_TREE, E, [e.user("Fix the thing in the worktree"), e.assistant("m1", { type: "text", text: "Fixed." })]);

function codexFile(home: string, name: string, records: unknown[]): string {
  const path = join(HOME, home, name);
  writeLines(path, records);
  return path;
}
function rollout(id: string, cwd: string, start: string, body: unknown[], meta: Record<string, unknown> = {}) {
  let n = 0;
  const t = () => at(start, ++n);
  return [
    { timestamp: t(), type: "session_meta", payload: { id, timestamp: start, cwd, originator: "codex_cli_rs", cli_version: "0.160.0", source: "cli", git: { branch: "main", commit_hash: "abc" }, ...meta } },
    { timestamp: t(), type: "turn_context", payload: { turn_id: "t1", cwd, model: "gpt-6.1-sol", effort: "high" } },
    ...body.map((payload) => ({ timestamp: t(), type: (payload as { record?: string }).record ?? "response_item", payload })),
  ];
}
// F: in ~/.codex (no account uses it), below the project's folder.
const F = "01a14412-58f1-75c1-91fc-3e2dde7beb80";
const F_REL = join("sessions", "2026", "10", "13", `rollout-2026-10-13T09-00-00-${F}.jsonl`);
codexFile(".codex", F_REL, rollout(F, SUBDIR, "2026-10-13T09:00:00Z", [
  { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>sandboxed</permissions instructions>" }] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/x</cwd>\n</environment_context>" }] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /x\n\nUse pnpm." }] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "Why is the build slow?" }] },
  { record: "event_msg", type: "user_message", message: "Why is the build slow?" },
  { type: "reasoning", summary: [{ type: "summary_text", text: "Checking the build." }], encrypted_content: "zzz" },
  { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "npm run build", workdir: SUBDIR }), call_id: "c1" },
  { type: "function_call_output", call_id: "c1", output: "Process exited with code 1\nOutput:\nbundler took 90s" },
  { type: "custom_tool_call", status: "completed", call_id: "c2", name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch" },
  { type: "custom_tool_call_output", call_id: "c2", output: [{ type: "input_text", text: "Success." }] },
  { type: "web_search_call", status: "completed", action: { type: "search", query: "vite slow build" } },
  { type: "function_call", name: "computer_exec", namespace: "mcp__tot", arguments: JSON.stringify({ command: "ls" }), call_id: "c3" },
  { type: "function_call_output", call_id: "c3", output: "a.ts" },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "It's the bundler." }], phase: "final_answer" },
  { record: "compacted", message: "summary", replacement_history: [] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "Thanks" }] },
]));
writeLines(join(HOME, ".codex", "session_index.jsonl"), [
  { id: F, thread_name: "Slow build (old name)", updated_at: "2026-10-13T09:00:00Z" },
  { id: F, thread_name: "Slow build", updated_at: "2026-10-13T09:10:00Z" },
]);
// G: a subagent's thread in the project; H: a thread elsewhere; I: an archived thread in the project's folder.
const G = "01a14412-0000-7000-8000-00000000000a";
codexFile(".codex", join("sessions", "2026", "10", "13", `rollout-2026-10-13T10-00-00-${G}.jsonl`), rollout(G, FOLDER, "2026-10-13T10:00:00Z", [
  { type: "message", role: "user", content: [{ type: "input_text", text: "Helper task" }] },
], { source: { subagent: { thread_spawn: { parent_thread_id: F } } }, parent_thread_id: F }));
const H = "01a14412-0000-7000-8000-00000000000b";
codexFile(".codex", join("sessions", "2026", "10", "14", `rollout-2026-10-14T10-00-00-${H}.jsonl`), rollout(H, join(HOME, "elsewhere"), "2026-10-14T10:00:00Z", [
  { type: "message", role: "user", content: [{ type: "input_text", text: "Other project" }] },
]));
const I = "01a14412-0000-7000-8000-00000000000c";
codexFile(".codex-tot", join("archived_sessions", `rollout-2026-10-01T10-00-00-${I}.jsonl`), rollout(I, FOLDER, "2026-10-01T10:00:00Z", [
  { type: "message", role: "user", content: [{ type: "input_text", text: "An old question" }] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "An old answer." }] },
]));

const app = createApp();
async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await app.request(`http://localhost:8787/api${path}`, {
    method,
    headers: { Host: "localhost:8787", Origin: "http://localhost:8787", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

// =============================================================================
console.log("\n# Paths and sources");
check("Claude encodes every other character than a letter or digit as -", claudeProjectDirName("/Users/me/my.app_v2 beta") === "-Users-me-my-app-v2-beta", claudeProjectDirName("/Users/me/my.app_v2 beta"));
check("…a dot folder doubles the dash", claudeProjectDirName("/Users/me/.config/x") === "-Users-me--config-x");
const enc = claudeProjectDirName("/a/my.app");
check("a projects folder may hold the folder itself or one below it", mayHoldFolder(enc, "/a/my.app") && mayHoldFolder(`${enc}-src`, "/a/my.app"));
check("…not an unrelated one, nor a name that only starts the same without a separator", !mayHoldFolder(claudeProjectDirName("/a/other"), "/a/my.app") && !mayHoldFolder(`${enc}2`, "/a/my.app"));
const long = `/a/${"x".repeat(240)}`;
check("a very long folder matches by its cut name", mayHoldFolder(`${claudeProjectDirName(long).slice(0, 200)}-1a2b3c`, long));
check("slash commands keep their arguments; the CLI's own lines are dropped", promptText("<command-name>/review</command-name><command-args>PR 12</command-args>") === "/review PR 12" && promptText("<local-command-stdout>x</local-command-stdout>") === null && promptText("[Request interrupted by user]") === null && promptText("Plain words") === "Plain words");
const sources = sessionSources().map((s) => `${s.driver}:${s.dir.slice(HOME.length + 1)}:${s.account?.id ?? "-"}`).sort();
check(
  "sources: every account's folder, then the default ones no account uses",
  sources.join() === ["chatgpt:.codex-tot:chatgpt", "chatgpt:.codex:-", "claude:.claude-tot:claude", "claude:.claude-work:claude-work", "claude:.claude:-"].sort().join(),
  sources.join(),
);
const trees = gitWorktrees(FOLDER);
check(
  "worktrees come from git's own files, with their branches",
  trees.length === 3 && trees[0]!.main && trees.some((t) => t.path === FEATURE && t.branch === "feature-x") && trees.some((t) => t.path === TOT_TREE && t.branch === "tot/fix-thing-3f2a"),
  JSON.stringify(trees.map((t) => [t.path.slice(HOME.length), t.branch, t.main])),
);

// =============================================================================
console.log("\n# Listing a project's sessions");
let list = (await call<LocalSessionList>("GET", `/projects/${project.id}/sessions`)).data;
const keys = list.sessions.map((s) => s.key);
const expected = [`chatgpt:${F}`, `claude:${E}`, `claude:${B}`, `claude:${A}`, `claude:${A2}`, `chatgpt:${I}`];
check("finds the project's sessions in every folder, newest first", keys.join() === expected.join(), keys.join());
check("…not the decoy folder's, meta-only or sidechain files, subagent threads, or other projects'", ![D, C, G, H].some((id) => keys.some((k) => k.endsWith(id))) && !list.partial);
const byKey = new Map(list.sessions.map((s) => [s.key, s]));
const la = byKey.get(`claude:${A}`)!;
check("a row: its own title (the user's name beats the CLI's), first prompt, count, time", la.title === "Login bug fix" && la.firstPrompt === "Fix the login bug in auth.ts" && la.messageCount === 5 && la.lastActivityAt > Date.parse("2026-10-10T10:00:00Z"), JSON.stringify(la));
check("…in a folder no account uses: no account, its folder for a name", la.accountId === null && la.accountName === "~/.claude" && la.worktree === false && la.branch === null);
const lb = byKey.get(`claude:${B}`)!;
check("a plain worktree's session: its account and branch", lb.accountId === work.id && lb.accountName === "Claude Work" && lb.worktree && lb.branch === "feature-x" && lb.cwd === FEATURE, JSON.stringify(lb));
const le = byKey.get(`claude:${E}`)!;
check("a TOT worktree's session: its branch", le.worktree && le.branch === "tot/fix-thing-3f2a" && le.accountId === "claude");
const lf = byKey.get(`chatgpt:${F}`)!;
check("a Codex thread: its latest name from the index, below the main folder counts as the main folder", lf.title === "Slow build" && lf.firstPrompt === "Why is the build slow?" && lf.messageCount === 3 && !lf.worktree && lf.branch === null, JSON.stringify(lf));
check("…an archived thread is found too", byKey.get(`chatgpt:${I}`)?.accountId === "chatgpt");
check("accounts to continue on, with the provider's current one marked", list.accounts.some((x) => x.id === work.id && !x.isDefault) && list.accounts.some((x) => x.id === "claude" && x.isDefault) && list.lastImportAt === null);

// =============================================================================
console.log("\n# Importing");
const started = Date.now();
let res = await call<ImportSessionsResult>("POST", `/projects/${project.id}/sessions/import`, {
  keys: [`claude:${A}`, `claude:${B}`, `claude:${E}`, `chatgpt:${F}`, "claude:nope"],
  agentId: agent.id,
  accounts: { claude: work.id },
});
check("imports the picked sessions; an unknown one is skipped with why", res.status === 200 && res.data.imported.length === 4 && res.data.skipped.length === 1 && /isn't/.test(res.data.skipped[0]!.reason), JSON.stringify(res.data));
const chatOf = (id: string) => conversations.get(res.data.imported.find((x) => x.key.endsWith(id))!.conversationId)!;
const chatA = chatOf(A);
check("A: continues on the picked account", chatA.provider === "claude" && chatA.providerAccount === work.id && chatA.providerSessionId === A && chatA.modelId === `${work.id}:claude-opus-5-5`, JSON.stringify([chatA.provider, chatA.providerAccount, chatA.providerSessionId, chatA.modelId]));
const copied = join(HOME, ".claude-work", "projects", claudeProjectDirName(FOLDER), `${A}.jsonl`);
check("…its file copied into that account's projects folder; the original untouched", existsSync(copied) && readFileSync(copied).equals(readFileSync(A_PATH)) && createHash("sha256").update(readFileSync(A_PATH)).digest("hex") === A_HASH);
check("…titled, in the project, working in the main checkout, at the session's times", chatA.title === "Login bug fix" && chatA.projectId === project.id && chatA.workspace?.mode === "checkout" && chatA.agentId === agent.id && chatA.createdAt === Date.parse(at("2026-10-10T10:00:00Z", 2)) && chatA.updatedAt < started, `${chatA.createdAt} ${chatA.updatedAt}`);
const recordA = sessionImports.forChat(chatA.id)!;
check("…the import is recorded with its provider, account, session and both paths", recordA.driver === "claude" && recordA.account === work.id && recordA.sessionId === A && recordA.sourcePath === A_PATH && recordA.sessionPath === copied && recordA.cwd === FOLDER);

const msgsA = messages.listByConversation(chatA.id);
check("A's messages: prompts and replies in order", msgsA.map((m) => m.role).join() === "user,assistant,user,user,assistant", msgsA.map((m) => m.role).join());
const textOf = (m: Message) => m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("|");
check("…the user's words, a command with its arguments; nothing the CLI wrote itself", textOf(msgsA[0]!) === "Fix the login bug in auth.ts" && textOf(msgsA[2]!) === "And add a test" && textOf(msgsA[3]!) === "/review PR 12");
const all = JSON.stringify(msgsA);
check("…no meta, sidechain, compaction summary, API error or interruption", !/Caveat|subagent|Subagent prompt|continued from a previous|API Error|interrupted|Set model/.test(all));
const reply = msgsA[1]!;
const kinds = reply.parts.map((p) => (p.type === "tool" ? `tool:${p.name}` : p.type)).join();
check(
  "…one reply: a notice, reasoning, text, then its tool calls, and the compaction as a notice",
  kinds === "notice,reasoning,text,tool:computer_read_file,tool:computer_exec,tool:github/create_issue,tool:Edit,tool:FancyTool,notice",
  kinds,
);
check("…the opening notice says where it continues", /Imported from Claude Code, on Claude Work\. Your next message continues this session\./.test((reply.parts[0] as { text: string }).text));
check("…each reply names the model the session used", reply.model === "claude-opus-5-5" && msgsA[4]!.model === "claude-opus-5-5");
check("…reasoning keeps its time", reply.parts[1]!.type === "reasoning" && (reply.parts[1] as { durationMs?: number }).durationMs === 1200);
const tool = (name: string) => reply.parts.find((p): p is ToolPart => p.type === "tool" && p.name === name)!;
check("…Read becomes reading a file (relative to the session's folder), with its output", JSON.stringify(tool("computer_read_file").input) === JSON.stringify({ path: "src/auth.ts" }) && tool("computer_read_file").output === "export function login() {}" && tool("computer_read_file").status === "done");
const bash = tool("computer_exec");
check("…Bash becomes a command, its failure kept, its huge output cut as a live reply's", bash.status === "error" && bash.isError === true && (bash.input as { command: string }).command === "npm test" && bash.output!.length < 20_100 && /… \(30000 more characters\)$/.test(bash.output!), String(bash.output?.length));
check("…MCP tools are <server>/<tool>, edits get a title, unknown tools keep their name", tool("github/create_issue").output === "Created #12" && tool("Edit").title === "Edited `auth.ts`" && tool("FancyTool").title === undefined);
const image = msgsA[2]!.parts.find((p) => p.type === "file");
check("…an image the user attached comes along as a file", image?.type === "file" && image.attachment.mimeType === "image/png" && image.attachment.size > 0);

const chatB = chatOf(B);
check("B: bound to the account whose folder holds it, nothing copied", chatB.providerAccount === work.id && sessionImports.forChat(chatB.id)!.sessionPath.includes(".claude-work"));
check("…a plain worktree isn't one TOT can give a chat: no workspace, and the notice says so", !chatB.workspace && /start a task/.test(JSON.stringify(messages.listByConversation(chatB.id)[1]!.parts[0])));
const chatE = chatOf(E);
const ws = chatE.workspace;
check(
  "E: works in its TOT worktree, marked as found rather than made",
  chatE.providerAccount === "claude" && ws?.mode === "worktree" && ws.external === true && ws.created && ws.branch === "tot/fix-thing-3f2a" && ws.worktree === TOT_TREE,
  JSON.stringify(ws),
);
const second = await call<ImportSessionsResult>("POST", `/projects/${project.id}/sessions/import`, { keys: [`claude:${A2}`], agentId: agent.id });
const chatA2 = conversations.get(second.data.imported[0]?.conversationId ?? "")!;
check("A2: with no account picked, the provider's current account, the file copied into its folder", chatA2.providerAccount === "claude" && existsSync(join(HOME, ".claude-tot", "projects", claudeProjectDirName(SUBDIR), `${A2}.jsonl`)) && chatA2.workspace?.mode === "checkout");

const chatF = chatOf(F);
check("F: a Codex thread continues on the current ChatGPT account, its model kept", chatF.provider === "chatgpt" && chatF.providerAccount === "chatgpt" && chatF.providerSessionId === F && chatF.modelId === "chatgpt:gpt-6.1-sol" && chatF.title === "Slow build");
check("…its rollout copied into that Codex home at the same path", readFileSync(join(HOME, ".codex-tot", F_REL)).equals(readFileSync(join(HOME, ".codex", F_REL))));
const msgsF = messages.listByConversation(chatF.id);
check("…its reply names the thread's model", msgsF[1]!.model === "gpt-6.1-sol");
check("…the injected context and the developer message are left out", msgsF.map((m) => m.role).join() === "user,assistant,user" && textOf(msgsF[0]!) === "Why is the build slow?" && textOf(msgsF[2]!) === "Thanks");
const fKinds = msgsF[1]!.parts.map((p) => (p.type === "tool" ? `tool:${p.name}` : p.type)).join();
check("…reasoning, a command, a patch, a search, a TOT tool, the answer, the compaction", fKinds === "notice,reasoning,tool:computer_exec,tool:apply_patch,tool:web_search,tool:computer_exec,text,notice", fKinds);
const fTools = msgsF[1]!.parts.filter((p): p is ToolPart => p.type === "tool");
check(
  "…a failed command is an error; the patch names its file; the search keeps its query",
  fTools[0]!.isError === true && (fTools[0]!.input as { command: string }).command === "npm run build" && fTools[1]!.title === "Edited `a.ts`" && fTools[1]!.output === "Success." && JSON.stringify(fTools[2]!.input) === JSON.stringify({ query: "vite slow build" }),
);

// =============================================================================
console.log("\n# Never twice");
res = await call<ImportSessionsResult>("POST", `/projects/${project.id}/sessions/import`, { keys: [`claude:${A}`], agentId: agent.id });
check("importing again is skipped", res.data.imported.length === 0 && res.data.skipped[0]?.reason === "Imported already.");
list = (await call<LocalSessionList>("GET", `/projects/${project.id}/sessions`)).data;
const again = list.sessions.filter((s) => s.key === `claude:${A}`);
check("the list shows each once (the account's copy), marked with its chat", again.length === 1 && again[0]!.importedChatId === chatA.id && again[0]!.accountId === work.id, JSON.stringify(again));
check("…and when the project last imported", list.lastImportAt !== null && list.lastImportAt >= started);

// =============================================================================
console.log("\n# Continuing a session");
async function turn(chatId: string, text: string): Promise<{ account: string; input: TurnInput }> {
  const { runId } = await sendMessage(chatId, { text });
  await runEnd(runId);
  return turns.at(-1)!;
}
let next = await turn(chatA.id, "Keep going");
check("A's next turn resumes its session in place on its account", next.account === work.id && next.input.sessionId === A && !next.input.fork, JSON.stringify([next.account, next.input.sessionId]));
check("…running in the folder it ran in, with just the new message", next.input.workDir === FOLDER && next.input.prompt.includes("Keep going") && !next.input.prompt.includes("Here is the conversation so far"));
next = await turn(chatF.id, "And the tests?");
check("F's next turn resumes the Codex thread in its folder", next.account === "chatgpt" && next.input.sessionId === F && next.input.workDir === SUBDIR);
check("a chat no longer on the imported session runs in TOT's own folder", sessionImports.workDir({ id: chatA.id, provider: "claude", providerSessionId: "something-else" }) === null);
rmSync(SUBDIR, { recursive: true, force: true });
check("…as does one whose folder is gone", sessionImports.workDir({ id: chatF.id, provider: "chatgpt", providerSessionId: F }) === null);

// =============================================================================
console.log("\n# Deleting an imported chat");
res = await call("DELETE", `/conversations/${chatE.id}`);
check("deleting a chat on a found worktree leaves the worktree", res.status === 200 && existsSync(TOT_TREE) && git(FOLDER, "worktree", "list").includes("fix-thing-3f2a"));
check("…and its session can be imported again", !sessionImports.chats().has(`claude:${E}`));

// =============================================================================
console.log("\n# A large session");
const BIG = "77777777-7777-4777-8777-777777777777";
const big = claudeRecords(BIG, FOLDER, "2026-10-15T00:00:00Z");
const bigRecords: unknown[] = [];
for (let i = 0; i < 1500; i++) {
  bigRecords.push(big.user(`Step ${i}: carry on`));
  bigRecords.push(big.assistant(`m${i}`, { type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `make step-${i}` } }));
  bigRecords.push(big.result(`t${i}`, i % 100 === 0 ? "y".repeat(2_000_000) : "z".repeat(4_000)));
  bigRecords.push(big.assistant(`n${i}`, { type: "text", text: `Step ${i} done.` }));
}
const bigPath = claudeFile(".claude-work", FOLDER, BIG, bigRecords);
const bigSize = statSync(bigPath).size;
let clock = Date.now();
list = (await call<LocalSessionList>("GET", `/projects/${project.id}/sessions`)).data;
const listMs = Date.now() - clock;
check("a large session is listed with its count", list.sessions.find((s) => s.key === `claude:${BIG}`)?.messageCount === 3000, `${(bigSize / 1e6).toFixed(0)} MB, listed in ${listMs} ms`);
clock = Date.now();
res = await call<ImportSessionsResult>("POST", `/projects/${project.id}/sessions/import`, { keys: [`claude:${BIG}`], agentId: agent.id });
const importMs = Date.now() - clock;
const bigChat = res.data.imported[0]?.conversationId ?? "";
const bigMessages = messages.listByConversation(bigChat);
const stored = bigMessages.reduce((sum, m) => sum + JSON.stringify(m.parts).length, 0);
check("…imports fast", res.data.imported.length === 1 && importMs < 15_000, `${importMs} ms`);
check("…with its outputs cut, so the chat stays far smaller than the file", bigMessages.length === 3000 && stored < 12_000_000 && stored < bigSize / 3, `${(stored / 1e6).toFixed(1)} MB stored of ${(bigSize / 1e6).toFixed(0)} MB`);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
