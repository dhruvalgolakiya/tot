// Skills: "/dh-stack fix the cart" runs a turn with that skill's SKILL.md. Skill folders in a temp home (Claude, shared,
// Codex, an added account, an enabled plugin, broken files), GET /api/skills, the "/name" parsing, the prompt a turn
// gets (fake providers behind the real turn pipeline) and the skill_read tool. Never the real ~/.claude or a model.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx apps/server/skills.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import type { Message, ModelOption, SkillInfo } from "@tot/shared/types";

process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test
// A home of our own: every skill root resolves here, so the real ~/.claude, ~/.agents and ~/.codex are never read.
const HOME = mkdtempSync(join(tmpdir(), "tot-skills-home-"));
process.env.TOT_ACCOUNTS_HOME = HOME;
delete process.env.TOT_CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;

function skill(dir: string, frontmatter: string | null, body = "Do the thing.\n"): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), frontmatter === null ? body : `---\n${frontmatter}\n---\n${body}`);
  return dir;
}
const writeJson = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
};

const CLAUDE = join(HOME, ".claude", "skills");
const DH = skill(
  join(CLAUDE, "dh-stack"),
  "name: dh-stack\ndescription: >-\n  Engineering mode for coding agents.\n  Proves every change on the real app.\ndisable-model-invocation: true\nmetadata:\n  owner: me",
  "# dh-stack\n\nBODY-MARKER: pick a playbook, then read references/review.md.\n",
);
mkdirSync(join(DH, "references"));
writeFileSync(join(DH, "references", "review.md"), "REVIEW-MARKER: get a second opinion.\n");
writeFileSync(join(DH, ".env"), "TOKEN=dummy-skill-secret-91\n");
writeFileSync(join(DH, "logo.bin"), Buffer.from([0, 1, 2, 3]));
skill(join(CLAUDE, "quoted"), 'name: "quoted"\ndescription: "Says \\"hi\\" — with escapes"');
skill(join(CLAUDE, "single"), "name: 'single'\ndescription: 'It''s single-quoted' # trailing comment");
skill(join(CLAUDE, "folder-name"), "description: Named after its folder");
skill(join(CLAUDE, "long"), `name: long\ndescription: ${"word ".repeat(80)}`);
skill(join(CLAUDE, "broken"), null, "No frontmatter here.\n");
mkdirSync(join(CLAUDE, "unclosed"));
writeFileSync(join(CLAUDE, "unclosed", "SKILL.md"), "---\nname: unclosed\ndescription: never ends\n");
mkdirSync(join(CLAUDE, "no-skill-md"));
writeFileSync(join(CLAUDE, "notes.txt"), "not a skill");
skill(join(CLAUDE, ".hidden"), "name: hidden\ndescription: dot folders are skipped");
const LOCKED = skill(join(CLAUDE, "locked"), "name: locked\ndescription: unreadable");
chmodSync(join(LOCKED, "SKILL.md"), 0o000);
skill(join(HOME, "elsewhere", "linked-skill"), "name: linked\ndescription: Through a symlink");
symlinkSync(join(HOME, "elsewhere", "linked-skill"), join(CLAUDE, "linked"));
// Shared and Codex folders: their dh-stack loses to Claude's, their own skills count.
skill(join(HOME, ".agents", "skills", "dh-stack"), "name: dh-stack\ndescription: agents copy");
skill(join(HOME, ".agents", "skills", "shared-only"), "name: shared-only\ndescription: From ~/.agents");
skill(join(HOME, ".codex", "skills", "codex-only"), "name: codex-only\ndescription: From ~/.codex");
skill(join(HOME, ".codex", "skills", "dh-stack"), "name: dh-stack\ndescription: codex copy");
// An added Claude account with its own skills (one clashing with the built-in's), and a Codex account.
skill(join(HOME, ".claude-work", "skills", "quoted"), "name: quoted\ndescription: work account copy");
skill(join(HOME, ".claude-work", "skills", "work-only"), "name: work-only\ndescription: From the work account");
skill(join(HOME, ".codex-work", "skills", "codex-work-only"), "name: codex-work-only\ndescription: From a Codex account");
// Plugins enabled in ~/.claude: one with a manifest name, one named by its id, one disabled.
const DEMO = join(HOME, ".claude", "plugins", "cache", "local", "demo", "1.0.0");
writeJson(join(DEMO, ".claude-plugin", "plugin.json"), { name: "demo" });
skill(join(DEMO, "skills", "make-thing"), "name: make-thing\ndescription: A plugin's skill");
const BARE = join(HOME, ".claude", "plugins", "cache", "local", "bare", "2.0.0");
skill(join(BARE, "skills", "tidy"), "name: tidy\ndescription: Plugin without a manifest");
const OFF = join(HOME, ".claude", "plugins", "cache", "local", "off", "1.0.0");
skill(join(OFF, "skills", "nope"), "name: nope\ndescription: disabled plugin");
writeJson(join(HOME, ".claude", "settings.json"), { enabledPlugins: { "demo@local": true, "bare-plugin@local": true, "off@local": false } });
writeJson(join(HOME, ".claude", "plugins", "installed_plugins.json"), {
  version: 2,
  plugins: {
    "demo@local": [{ scope: "user", installPath: DEMO }],
    "bare-plugin@local": [{ scope: "user", installPath: BARE }],
    "off@local": [{ scope: "user", installPath: OFF }],
  },
});

const { HttpError, invokedSkill, sendMessage } = await import("./agent/orchestrator.ts");
const { providers } = await import("./agent/providers/index.ts");
const { accounts } = await import("./accounts/accounts.ts");
const { agents } = await import("./data/agents.ts");
const { conversations } = await import("./data/conversations.ts");
const { messages } = await import("./data/messages.ts");
const { settings } = await import("./data/settings.ts");
const { createApp } = await import("./app.ts");
const { MCP_TOKEN } = await import("./config.ts");
const { mcpRoutes } = await import("./mcp/server.ts");
const { runEnd } = await import("./tasks/run-loop.ts");
const { parseFrontmatter, skillBlock, skills, slashSkill } = await import("./skills/skills.ts");
type AgentProvider = import("./agent/providers/types.ts").AgentProvider;
type TurnInput = import("./agent/providers/types.ts").TurnInput;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 240)}` : ""}`);
}

settings.patch({ computer: { mode: "off" } });
accounts.add({ driver: "claude", name: "Claude Work", configDir: "~/.claude-work" });
accounts.add({ driver: "chatgpt", name: "Codex Work", configDir: "~/.codex-work" });

// --- Frontmatter ------------------------------------------------------------------------------------------------
const parsed = parseFrontmatter('name: x\ndescription: |\n  line one\n  line two\nother: "a \\u00e9 b"\nplain: words\n  continued here\nlist:\n  - a');
check("block, quoted and multi-line plain scalars", parsed.description === "line one\nline two" && parsed.other === "a é b" && parsed.plain === "words continued here", JSON.stringify(parsed));
check("nested values are skipped", !("list" in parsed));

// --- Discovery --------------------------------------------------------------------------------------------------
const list = skills.list();
const byName = Object.fromEntries(list.map((s) => [s.name, s]));
check("sorted by name", list.map((s) => s.name).join() === [...list.map((s) => s.name)].sort((a, b) => a.localeCompare(b)).join(), list.map((s) => s.name).join());
check("frontmatter name and a folded description", byName["dh-stack"]?.description === "Engineering mode for coding agents. Proves every change on the real app.", JSON.stringify(byName["dh-stack"]));
check("the first root wins a name (Claude's dh-stack, not ~/.agents' or ~/.codex')", byName["dh-stack"]?.source === "claude" && byName["dh-stack"]!.dir === DH);
check("double- and single-quoted values, comments dropped", byName.quoted?.description === 'Says "hi" — with escapes' && byName.single?.description === "It's single-quoted", `${byName.quoted?.description} | ${byName.single?.description}`);
check("no name: the folder's", byName["folder-name"]?.description === "Named after its folder");
check("long descriptions are cut to about 200 characters", (byName.long?.description.length ?? 0) <= 200 && byName.long!.description.endsWith("…"));
check("a symlinked folder counts", byName.linked?.description === "Through a symlink");
check("~/.agents and ~/.codex skills, with their source", byName["shared-only"]?.source === "agents" && byName["codex-only"]?.source === "codex");
check("other accounts' folders are read", byName["work-only"]?.source === "claude" && byName["codex-work-only"]?.source === "codex");
check("the default account's copy wins over another account's", byName.quoted?.description.startsWith("Says"));
check("enabled plugins' skills are plugin:skill", byName["demo:make-thing"]?.source === "plugin" && byName["demo:make-thing"]?.pluginName === "demo");
check("a plugin without a manifest is named by its id", Boolean(byName["bare-plugin:tidy"]));
check("a disabled plugin's skills are left out", !list.some((s) => s.name.includes("nope")));
const skipped = ["broken", "unclosed", "no-skill-md", "notes.txt", "hidden", ".hidden"].filter((name) => byName[name]);
check("files without frontmatter, folders without SKILL.md and dot folders are skipped", skipped.length === 0, skipped.join());
check("an unreadable SKILL.md is skipped", process.getuid?.() === 0 || !byName.locked);

// Settings → Models picks another default Claude account: its folder comes first.
settings.patch({ models: { accounts: { claude: "claude-work", chatgpt: "chatgpt" } } });
skills.refresh();
check("the active Claude account's folder comes first", skills.find("quoted")?.description === "work account copy");
settings.patch({ models: { accounts: { claude: "claude", chatgpt: "chatgpt" } } });
skills.refresh();

// Cache: a scan within 30 s is reused; after it, a changed SKILL.md is read again.
const now = Date.now();
skills.list(now);
skill(join(CLAUDE, "fresh"), "name: fresh\ndescription: Installed just now");
writeFileSync(join(CLAUDE, "quoted", "SKILL.md"), '---\nname: "quoted"\ndescription: "Edited"\n---\n');
utimesSync(join(CLAUDE, "quoted", "SKILL.md"), new Date(), new Date(Date.now() + 5_000));
check("within the TTL the list is cached", !skills.list(now + 1_000).some((s) => s.name === "fresh"));
const later = skills.list(now + 31_000);
check("after it, new and changed skills show", later.some((s) => s.name === "fresh") && later.find((s) => s.name === "quoted")?.description === "Edited");
skills.refresh();
skills.list();
skill(join(CLAUDE, "newest"), "name: newest\ndescription: Found on a miss");
check("a miss right after a scan doesn't scan again", skills.find("newest") === null);
await sleep(2_100);
check("a name that's missing looks again (after a moment)", skills.find("newest")?.description === "Found on a miss");

// --- GET /api/skills ----------------------------------------------------------------------------------------------
const app = createApp();
const res = await app.request("http://localhost:8787/api/skills", { headers: { Host: "localhost:8787" } });
const body = await res.text();
const api = JSON.parse(body) as SkillInfo[];
check("GET /api/skills lists them by name", res.status === 200 && api.map((s) => s.name).join() === skills.list().map((s) => s.name).join(), body.slice(0, 200));
check("…with name, description, source and pluginName only", api.every((s) => Object.keys(s).every((key) => ["name", "description", "source", "pluginName"].includes(key))) && api.find((s) => s.name === "demo:make-thing")?.pluginName === "demo");
check("…never a path, a body or a secret", !body.includes(HOME) && !body.includes("BODY-MARKER") && !body.includes("dummy-skill-secret"));

// --- "/name" parsing ----------------------------------------------------------------------------------------------
check("/name and the rest", JSON.stringify(slashSkill("/dh-stack fix the cart")) === JSON.stringify({ name: "dh-stack", rest: "fix the cart" }));
check("a bare /name", slashSkill("/dh-stack")?.rest === "" && slashSkill("/dh-stack\n\nmore lines")?.rest === "more lines");
check("plugin names with a colon", slashSkill("/demo:make-thing a cat")?.name === "demo:make-thing");
check("only at the very start", slashSkill("please /dh-stack") === null && slashSkill(" /dh-stack") === null);
check("a path isn't a skill", slashSkill("/Users/me/notes.md is broken") === null && slashSkill("/dh-stack/x") === null);
const known = invokedSkill(undefined, "/dh-stack fix the cart");
check("a known /name invokes it, without the prefix", known?.skill.name === "dh-stack" && known.text === "fix the cart" && known.body.includes("BODY-MARKER") && !known.body.includes("disable-model-invocation"));
check("an unknown /word is an ordinary message", invokedSkill(undefined, "/nope hello") === null);
check("case doesn't matter", invokedSkill(undefined, "/DH-Stack go")?.skill.name === "dh-stack");
const picked = invokedSkill("dh-stack", "just this");
check("the composer's skill without a /name keeps the text", picked?.skill.name === "dh-stack" && picked.text === "just this");
check("the composer's skill strips its own /name", invokedSkill("dh-stack", "/dh-stack go")?.text === "go");
check("a skill the composer sent that's gone is a 400", (() => {
  try {
    invokedSkill("gone-skill", "hi");
    return false;
  } catch (err) {
    return err instanceof HttpError && err.status === 400;
  }
})());
const block = skillBlock({ name: "dh-stack", dir: DH }, "Body");
check("the block names the skill and its folder", block.startsWith(`<skill name="dh-stack" path="${DH}">\nBody\n</skill>\n`) && block.includes("skill_read"));

// --- Turns: the prompt each provider gets -------------------------------------------------------------------------
const turns: TurnInput[] = [];
function fakeProvider(id: "claude" | "chatgpt", label: string, model: string): AgentProvider {
  return {
    id,
    label,
    status: async () => ({
      id,
      accountId: id,
      label,
      installed: true,
      loggedIn: true,
      models: [{ id: `${id}:${model}`, provider: id, accountId: id, model, label: model, available: true } satisfies ModelOption],
    }),
    async *runTurn(input) {
      turns.push(input);
      yield { type: "session", sessionId: input.sessionId ?? `${id}-session-${turns.length}` };
      yield { type: "text-delta", blockId: "b1", delta: `Reply from ${label}.` };
    },
    complete: async () => "A title",
  };
}
providers.claude = fakeProvider("claude", "Claude", "claude-opus-5-5");
providers.chatgpt = fakeProvider("chatgpt", "ChatGPT", "gpt-6.1-sol");
const agent = agents.first();
async function turn(chatId: string, text: string, extra: { skill?: string; modelId?: string } = {}): Promise<{ user: Message; prompt: string }> {
  const { runId, userMessage } = await sendMessage(chatId, { text, modelId: extra.modelId ?? "claude:claude-opus-5-5", ...(extra.skill ? { skill: extra.skill } : {}) });
  await runEnd(runId);
  return { user: userMessage, prompt: turns.at(-1)!.prompt };
}

const chat = conversations.create({ agentId: agent.id, modelId: "auto", title: "Skills" });
let t = await turn(chat.id, "/dh-stack fix the cart");
check("Claude: the prompt has the skill block with its folder", t.prompt.includes(`<skill name="dh-stack" path="${DH}">`) && t.prompt.includes("BODY-MARKER"), t.prompt);
check("…without the frontmatter", !t.prompt.includes("disable-model-invocation") && !t.prompt.includes("description:"));
check("…then the user's text without the /name", t.prompt.endsWith("fix the cart") && !t.prompt.includes("/dh-stack fix") && t.prompt.indexOf("</skill>") < t.prompt.indexOf("fix the cart"));
check("the user message keeps its text and names the skill", t.user.skill === "dh-stack" && t.user.parts.some((p) => p.type === "text" && p.text === "/dh-stack fix the cart"));
const stored = messages.get(t.user.id)!;
check("…stored so it survives a reload, without the SKILL.md", stored.skill === "dh-stack" && !JSON.stringify(stored).includes("BODY-MARKER"));
check("the chat's title skips the /name", conversations.get(chat.id)?.title === "A title" || conversations.get(chat.id)?.title === "fix the cart", conversations.get(chat.id)?.title);
check("the turn's TOT server says the chat has skills", turns.at(-1)!.mcpServers[0]?.type === "http" && (turns.at(-1)!.mcpServers[0] as { url: string }).url.endsWith("?skills=1"));
t = await turn(chat.id, "thanks, now the header");
check("only that turn gets the skill", !t.prompt.includes("<skill") && t.user.skill === undefined && t.prompt === "thanks, now the header", t.prompt);

const codexChat = conversations.create({ agentId: agent.id, modelId: "auto", title: "Codex" });
t = await turn(codexChat.id, "/dh-stack review it", { modelId: "chatgpt:gpt-6.1-sol" });
check("ChatGPT gets the same block", t.prompt.includes(`<skill name="dh-stack"`) && t.prompt.includes("BODY-MARKER") && t.prompt.endsWith("review it"), t.prompt);

const bare = conversations.create({ agentId: agent.id, modelId: "auto", title: "Bare" });
t = await turn(bare.id, "/dh-stack");
check("a bare /name: 'Run the skill.'", t.prompt.includes("</skill>") && t.prompt.endsWith("Run the skill."), t.prompt.slice(-80));

const pickedChat = conversations.create({ agentId: agent.id, modelId: "auto", title: "Picked" });
t = await turn(pickedChat.id, "/dh-stack tidy up", { skill: "dh-stack" });
check("the composer's skill field: same block, prefix stripped", t.user.skill === "dh-stack" && t.prompt.endsWith("tidy up") && t.prompt.includes("BODY-MARKER"));
t = await turn(pickedChat.id, "/nope hello");
check("an unknown /word goes as typed", t.prompt === "/nope hello" && t.user.skill === undefined, t.prompt);
const sent = await sendMessage(pickedChat.id, { text: "hello", skill: "gone-skill" }).then(
  () => null,
  (err: unknown) => err,
);
check("the composer naming a missing skill gets a 400", sent instanceof HttpError && sent.status === 400);
const auto = await sendMessage(pickedChat.id, { text: "/dh-stack keep going" }, { auto: true });
await runEnd(auto.runId);
check("TOT's own turns never invoke a skill", !turns.at(-1)!.prompt.includes("<skill") && auto.userMessage.skill === undefined);

const plainChat = conversations.create({ agentId: agent.id, modelId: "auto", title: "Plain" });
await turn(plainChat.id, "hello");
check("a chat with no skill has a plain TOT server URL", !(turns.at(-1)!.mcpServers[0] as { url: string }).url.includes("?"));

// --- skill_read ---------------------------------------------------------------------------------------------------
const PORT = 8806;
const mcpServer = serve({ fetch: new Hono().route("/mcp", mcpRoutes).fetch, port: PORT, hostname: "127.0.0.1" });
async function mcp(chatId: string) {
  const client = new Client({ name: "tot-skills-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp/${chatId}`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } }),
  );
  return {
    tools: async () => (await client.listTools()).tools.map((tool) => tool.name),
    call: async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return { text: (result.content as { text?: string }[]).map((c) => c.text ?? "").join("\n"), isError: Boolean(result.isError) };
    },
    close: () => client.close(),
  };
}
const withSkill = await mcp(chat.id);
const without = await mcp(plainChat.id);
check("skill_read only in chats that invoked a skill", (await withSkill.tools()).includes("skill_read") && !(await without.tools()).includes("skill_read"));
let r = await withSkill.call("skill_read", { skill: "dh-stack" });
check("no path lists the folder", !r.isError && r.text.includes("SKILL.md") && r.text.includes("references/review.md") && !r.text.includes(".env"), r.text);
r = await withSkill.call("skill_read", { skill: "dh-stack", path: "references/review.md" });
check("reads a file in it", !r.isError && r.text.includes("REVIEW-MARKER"), r.text);
r = await withSkill.call("skill_read", { skill: "dh-stack", path: join(DH, "references", "review.md") });
check("…by its full path too", !r.isError && r.text.includes("REVIEW-MARKER"));
r = await withSkill.call("skill_read", { skill: "dh-stack", path: "../quoted/SKILL.md" });
check("never outside the folder", r.isError && !r.text.includes("Edited"), r.text);
r = await withSkill.call("skill_read", { skill: "dh-stack", path: ".env" });
check("never an .env file", r.isError && !r.text.includes("dummy-skill-secret"), r.text);
r = await withSkill.call("skill_read", { skill: "dh-stack", path: "logo.bin" });
check("a binary file is described, not dumped", !r.isError && r.text.includes("binary"));
r = await withSkill.call("skill_read", { skill: "shared-only" });
check("only skills this chat used", r.isError && r.text.includes("dh-stack"), r.text);
await withSkill.close();
await without.close();
mcpServer.close();

chmodSync(join(LOCKED, "SKILL.md"), 0o644);
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
