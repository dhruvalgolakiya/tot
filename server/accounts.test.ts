// Provider accounts: several Claude / ChatGPT sign-ins as config folders, like T3 Code's provider instances. Fake
// config folders in a temp home (a CCS-style proxy account with dummy env values and MCP servers, a Codex home),
// fake providers behind the real turn pipeline, and a fake T3 Code settings file. Never the real folders or models.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/accounts.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountStatus, Message, ModelOption, ProviderAccount, T3ImportCandidate } from "../shared/types.ts";

process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test
// A home of our own: "~" and the default folders resolve here, so the real ~/.claude, ~/.codex and ~/.t3 are never read.
const HOME = mkdtempSync(join(tmpdir(), "tot-accounts-home-"));
process.env.TOT_ACCOUNTS_HOME = HOME;
process.env.TOT_T3_SETTINGS = join(HOME, "t3-settings.json");
delete process.env.TOT_CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
// Something a parent shell might export: the built-in account must never pass it on.
process.env.ANTHROPIC_BASE_URL = "http://parent-shell.invalid";

// Dummy values that must never show up in an API answer.
const SECRET_TOKEN = "dummy-proxy-token-5f1c";
const SECRET_URL = "http://127.0.0.1:9/dummy-ccs";
const SECRET_HEADER = "Bearer dummy-mcp-header-77aa";

const writeJson = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
};

// A CCS-style Claude folder: an env block pointing Claude Code at a proxy, its own MCP servers, an enabled plugin.
const MIX = join(HOME, ".claude-mix");
const PLUGIN = join(MIX, "plugins", "cache", "local", "demo", "1.0.0");
mkdirSync(PLUGIN, { recursive: true });
writeJson(join(MIX, "settings.json"), {
  env: { ANTHROPIC_BASE_URL: SECRET_URL, ANTHROPIC_AUTH_TOKEN: SECRET_TOKEN, ANTHROPIC_MODEL: "claude-opus-5-5" },
  enabledPlugins: { "demo@local": true, "missing@local": true },
});
writeJson(join(MIX, ".claude.json"), {
  mcpServers: {
    linear: { type: "http", url: "https://mcp.example.invalid/linear", headers: { Authorization: SECRET_HEADER } },
    tot: { type: "http", url: "https://mcp.example.invalid/not-tot" },
    blender: { command: "uvx", args: ["blender-mcp"] },
    "bad name": { command: "nope" },
  },
});
writeJson(join(MIX, "plugins", "installed_plugins.json"), { version: 2, plugins: { "demo@local": [{ scope: "user", installPath: PLUGIN }] } });
// The default folder's global config (~/.claude.json): its servers only count when the built-in's tools are on.
writeJson(join(HOME, ".claude.json"), { mcpServers: { paper: { type: "http", url: "https://mcp.example.invalid/paper" } } });
// A second Codex home with its own MCP server.
const WORK = join(HOME, ".codex-work");
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, "config.toml"), 'model = "gpt-6.1-sol"\n\n[mcp_servers.docs]\nurl = "https://mcp.example.invalid/docs"\n\n[mcp_servers."quoted-name"]\ncommand = "x"\n');
// T3 Code's settings: a default Claude (empty homePath), a CCS one, a Codex one with its own home, and other drivers.
writeJson(process.env.TOT_T3_SETTINGS, {
  providerInstances: {
    claudeAgent: { driver: "claudeAgent", displayName: "Cladue 20x", enabled: true, config: { binaryPath: "claude", homePath: "" } },
    claudeAgent_ccs: { driver: "claudeAgent", displayName: "Claude Mix", enabled: true, config: { homePath: "~/.claude-mix" } },
    codex: { driver: "codex", enabled: true, config: { shadowHomePath: "", launchArgs: "" } },
    codex_work: { driver: "codex", displayName: "Codex Work", enabled: true, config: { shadowHomePath: "~/.codex-work", binaryPath: "codex" } },
    grok: { driver: "grok", enabled: false, config: { binaryPath: "grok" } },
  },
});

const { sameProviderFallback, sendMessage } = await import("./agent/orchestrator.ts");
const { limits } = await import("./agent/limits.ts");
const { parseModelId, resolveRoute } = await import("./agent/router.ts");
const { accountProviders, modelOptions, providers, routingStatuses } = await import("./agent/providers/index.ts");
const { accountTools, buildEnv, loginCommand } = await import("./agent/providers/claude.ts");
const { threadConfig } = await import("./agent/providers/chatgpt.ts");
const { accounts, accountDir } = await import("./accounts/accounts.ts");
const { claudeMcpServers, claudeSettingsEnv, codexMcpServerNames, mergeMcpServers } = await import("./accounts/config.ts");
const { parseT3Instances } = await import("./accounts/t3.ts");
const { agents } = await import("./data/agents.ts");
const { conversations } = await import("./data/conversations.ts");
const { messages } = await import("./data/messages.ts");
const { settings } = await import("./data/settings.ts");
const { createApp } = await import("./app.ts");
const { runEnd } = await import("./tasks/run-loop.ts");
type AgentProvider = import("./agent/providers/types.ts").AgentProvider;
type TurnInput = import("./agent/providers/types.ts").TurnInput;
type McpServerSpec = import("./agent/providers/types.ts").McpServerSpec;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 240)}` : ""}`);
}

settings.patch({ computer: { mode: "off" } });

// --- Fake providers: one per account, recording which account each turn ran on --------------------------------
const turns: { account: string; input: TurnInput }[] = [];
const limited = new Set<string>();
function fakeProvider(account: string, driver: "claude" | "chatgpt", label: string, models: string[]): AgentProvider {
  return {
    id: driver,
    label,
    status: async () => ({
      id: driver,
      accountId: account,
      label,
      installed: true,
      loggedIn: true,
      authMethod: "Fake plan",
      models: models.map((model): ModelOption => ({ id: `${account}:${model}`, provider: driver, accountId: account, model, label: model, available: true })),
    }),
    async *runTurn(input) {
      turns.push({ account, input });
      if (limited.has(account)) {
        yield { type: "error", message: `You've hit your ${label} usage limit.`, kind: "limit" };
        return;
      }
      yield { type: "session", sessionId: input.sessionId ?? `${account}-session-${turns.length}` };
      yield { type: "text-delta", blockId: "b1", delta: `Reply from ${label}.` };
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
    },
    complete: async () => "A title",
  };
}
providers.claude = fakeProvider("claude", "claude", "Claude", ["claude-opus-5-5", "claude-sonnet-5-5"]);
providers.chatgpt = fakeProvider("chatgpt", "chatgpt", "ChatGPT", ["gpt-6.1-sol", "gpt-6-luna"]);

// --- Built-ins: always there, and every older provider id is one -----------------------------------------------
const builtIns = accounts.list();
check("two built-in accounts exist", builtIns.length === 2 && builtIns.every((a) => a.builtIn) && builtIns.map((a) => a.id).join() === "claude,chatgpt");
check("built-ins use the default folders", accountDir(builtIns[0]!) === join(HOME, ".claude") && accountDir(builtIns[1]!) === join(HOME, ".codex"));
const oldClaude = parseModelId("claude:claude-opus-5-5");
const oldChatgpt = parseModelId("chatgpt:gpt-6.1-sol");
check("an old Claude model id resolves to the built-in account", oldClaude !== "auto" && oldClaude.provider === "claude" && oldClaude.account === "claude");
check("an old ChatGPT model id resolves to the built-in account", oldChatgpt !== "auto" && oldChatgpt.provider === "chatgpt" && oldChatgpt.account === "chatgpt");
check("an unknown account id is Auto", parseModelId("nobody:claude-opus-5-5") === "auto");
check("built-ins can't be removed", (() => {
  try {
    accounts.remove("claude");
    return false;
  } catch {
    return true;
  }
})());

// --- Adding accounts --------------------------------------------------------------------------------------------
const mix = accounts.add({ driver: "claude", name: "Claude Mix", configDir: "~/.claude-mix/" });
check("an added account gets a slug id", mix.id === "claude-mix" && !mix.builtIn && mix.useAccountTools, JSON.stringify(mix));
check("its folder is kept as typed, without the trailing slash", mix.configDir === "~/.claude-mix" && accountDir(mix) === MIX);
const parsedMix = parseModelId("claude-mix:claude-opus-5-5");
check("its model ids resolve to it", parsedMix !== "auto" && parsedMix.provider === "claude" && parsedMix.account === "claude-mix");
check("the same folder can't be added twice", (() => {
  try {
    accounts.add({ driver: "claude", name: "Again", configDir: MIX });
    return false;
  } catch {
    return true;
  }
})());
check("the default folder isn't a new account", (() => {
  try {
    accounts.add({ driver: "claude", name: "Default", configDir: "" });
    return false;
  } catch {
    return true;
  }
})());
const reserved = accounts.add({ driver: "chatgpt", name: "Auto", configDir: "~/.codex-auto" });
check("reserved names get another id", reserved.id !== "auto" && !reserved.id.includes(":"), reserved.id);
accounts.remove(reserved.id);

// --- Claude: env and folder -------------------------------------------------------------------------------------
const builtinEnv = buildEnv(accounts.get("claude"));
check("the built-in account strips ANTHROPIC_* and sets no CLAUDE_CONFIG_DIR", !("ANTHROPIC_BASE_URL" in builtinEnv) && !("CLAUDE_CONFIG_DIR" in builtinEnv));
const mixEnv = buildEnv(accounts.get("claude-mix"));
check("an account runs Claude Code on its folder", mixEnv.CLAUDE_CONFIG_DIR === MIX);
check("…with its settings.json env on top (the proxy)", mixEnv.ANTHROPIC_BASE_URL === SECRET_URL && mixEnv.ANTHROPIC_AUTH_TOKEN === SECRET_TOKEN && mixEnv.ANTHROPIC_MODEL === "claude-opus-5-5");
check("…not the parent shell's", mixEnv.ANTHROPIC_BASE_URL !== process.env.ANTHROPIC_BASE_URL);
check("settings env reads only string values", Object.keys(claudeSettingsEnv(mix)).length === 3);
check("sign-in command runs claude on the folder", loginCommand(mix) === "CLAUDE_CONFIG_DIR=~/.claude-mix claude", loginCommand(mix));

// --- MCP servers from the account -------------------------------------------------------------------------------
const tot: McpServerSpec[] = [{ name: "tot", type: "http", url: "http://127.0.0.1:1/mcp/x", headers: { Authorization: "Bearer tot" } }];
const own = claudeMcpServers(mix);
check("reads the folder's .claude.json servers (stdio and http, valid names)", own.map((s) => s.name).sort().join() === "blender,linear,tot", own.map((s) => s.name).join());
const merged = mergeMcpServers(tot, own, true);
check("TOT's server wins its name; the account's is renamed", merged[0] === tot[0] && merged.some((s) => s.name === "account_tot" && s.type === "http" && s.url.includes("not-tot")));
check("the account's other servers come along", merged.some((s) => s.name === "linear") && merged.some((s) => s.name === "blender" && s.type === "stdio"));
check("tools off: only TOT's", mergeMcpServers(tot, own, false).length === 1);
const onTools = accountTools(accounts.get("claude-mix")!, tot);
check("tools on: servers and enabled, installed plugins", onTools.servers.length === 4 && onTools.plugins.length === 1 && onTools.plugins[0]!.path === PLUGIN);
accounts.update("claude-mix", { useAccountTools: false });
const offTools = accountTools(accounts.get("claude-mix")!, tot);
check("tools off: nothing from the account", offTools.servers.length === 1 && offTools.plugins.length === 0);
accounts.update("claude-mix", { useAccountTools: true });
check("the built-in reads ~/.claude.json, but only with its tools on", accountTools(accounts.get("claude")!, tot).servers.length === 1 && claudeMcpServers(accounts.get("claude")!).map((s) => s.name).join() === "paper");

// --- Codex: per-account MCP servers -----------------------------------------------------------------------------
const work = accounts.add({ driver: "chatgpt", name: "Codex Work", configDir: "~/.codex-work", useAccountTools: false });
check("reads a Codex home's MCP server names", codexMcpServerNames(work).sort().join() === "docs,quoted-name");
const lockedDown = threadConfig(tot, false, { userMcpServers: ["docs"], useAccountTools: false });
const opened = threadConfig(tot, false, { userMcpServers: ["docs"], useAccountTools: true });
check("tools off: the account's config.toml servers are switched off", lockedDown["mcp_servers.docs.enabled"] === false);
check("tools on: they stay, pre-approved", opened["mcp_servers.docs.enabled"] === undefined && opened["mcp_servers.docs.default_tools_approval_mode"] === "approve");
check("TOT's own server is always on", opened["mcp_servers.tot.enabled"] === true && lockedDown["mcp_servers.tot.enabled"] === true);

// --- Import from T3 Code ----------------------------------------------------------------------------------------
const app = createApp();
async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T; text: string }> {
  const res = await app.request(`http://localhost:8787/api${path}`, {
    method,
    headers: { Host: "localhost:8787", Origin: "http://localhost:8787", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: JSON.parse(text) as T, text };
}
accounts.remove(work.id);
const candidates = await call<T3ImportCandidate[]>("GET", "/accounts/import/t3");
const byId = Object.fromEntries(candidates.data.map((c) => [c.t3Id, c]));
check("T3 import offers instances with their own folder", candidates.status === 200 && Object.keys(byId).sort().join() === "claudeAgent_ccs,codex_work", Object.keys(byId).join());
check("…named from displayName, folders from homePath / shadowHomePath", byId.claudeAgent_ccs?.name === "Claude Mix" && byId.codex_work?.configDir === "~/.codex-work" && byId.codex_work?.driver === "chatgpt");
check("…a bare CLI name isn't kept as a binary path", byId.codex_work?.binaryPath === null);
check("…the one already added is marked", byId.claudeAgent_ccs?.alreadyAdded === true && byId.codex_work?.alreadyAdded === false);
check("parsing skips other drivers and bad JSON throws", parseT3Instances('{"providerInstances":{"x":{"driver":"cursor","config":{"homePath":"~/a"}}}}').length === 0 && (() => {
  try {
    parseT3Instances("{");
    return false;
  } catch {
    return true;
  }
})());
const imported = await call<ProviderAccount[]>("POST", "/accounts/import/t3", { ids: ["claudeAgent_ccs", "codex_work"] });
check("importing adds the new one and skips the added one", imported.status === 200 && imported.data.length === 1 && imported.data[0]!.id === "codex-work" && imported.data[0]!.useAccountTools, imported.text);

// --- The API: statuses, never env values ------------------------------------------------------------------------
accountProviders.use("claude-mix", fakeProvider("claude-mix", "claude", "Claude Mix", ["claude-opus-5-5", "claude-sonnet-5-5"]));
accountProviders.use("codex-work", fakeProvider("codex-work", "chatgpt", "Codex Work", ["gpt-6.1-sol"]));
const listed = await call<AccountStatus[]>("GET", "/accounts?refresh=1");
const mixStatus = listed.data.find((a) => a.id === "claude-mix");
check("GET /accounts lists every account in order", listed.data.map((a) => a.id).join() === "claude,claude-mix,chatgpt,codex-work", listed.data.map((a) => a.id).join());
check("…a proxy account shows env key names and the proxy", Boolean(mixStatus?.proxy) && mixStatus!.envKeys.join() === "ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN,ANTHROPIC_MODEL" && mixStatus!.dir === "~/.claude-mix");
check("…its MCP servers and plugins by name", mixStatus?.mcpServers.length === 3 && mixStatus.plugins.join() === "demo");
check("…never an env value or a header", !listed.text.includes(SECRET_TOKEN) && !listed.text.includes(SECRET_URL) && !listed.text.includes(SECRET_HEADER) && !listed.text.includes("dummy"));
const models = await modelOptions();
check("the model list groups by account", models.some((m) => m.id === "claude-mix:claude-opus-5-5" && m.accountName === "Claude Mix") && models.some((m) => m.id === "claude:claude-opus-5-5" && m.accountId === "claude"));
const login = await call<{ kind: string; command?: string }>("POST", "/accounts/claude-mix/login");
check("Claude sign-in for a folder is a command to run", login.data.kind === "command" && login.data.command === "CLAUDE_CONFIG_DIR=~/.claude-mix claude");
check("removing a built-in over the API is refused", (await call("DELETE", "/accounts/chatgpt")).status === 400);
await call("PATCH", "/accounts/codex-work", { enabled: false });
check("a turned-off account offers no models", !(await call<ModelOption[]>("GET", "/models")).data.some((m) => m.accountId === "codex-work"));
await call("PATCH", "/accounts/codex-work", { enabled: true });

// --- Turns run on their account ---------------------------------------------------------------------------------
const agent = agents.first();
async function turn(chatId: string, modelId: string): Promise<Message> {
  const { runId } = await sendMessage(chatId, { text: "hello there", modelId });
  const end = await runEnd(runId);
  return end!.message;
}
const chat = conversations.create({ agentId: agent.id, modelId: "auto", title: "Accounts" });
let reply = await turn(chat.id, "claude-mix:claude-opus-5-5");
check("a picked account's model runs on that account", turns.at(-1)?.account === "claude-mix" && reply.account === "claude-mix" && reply.provider === "claude");
check("the session is kept with its account", conversations.get(chat.id)?.providerAccount === "claude-mix" && messages.get(reply.id)?.account === "claude-mix");
await turn(chat.id, "claude-mix:claude-opus-5-5");
check("the same account resumes its session", turns.at(-1)?.input.sessionId?.startsWith("claude-mix-session") === true);
await turn(chat.id, "claude:claude-opus-5-5");
check("another account of the same provider starts fresh with the transcript", turns.at(-1)?.account === "claude" && turns.at(-1)?.input.sessionId === undefined && turns.at(-1)!.input.prompt.includes("Reply from Claude Mix"));

// Auto runs on each provider's default account (Settings → Models).
settings.patch({ models: { accounts: { claude: "claude-mix", chatgpt: "chatgpt" } } });
const auto = conversations.create({ agentId: agent.id, modelId: "auto", title: "Auto" });
reply = await turn(auto.id, "auto");
check("Auto uses the default account Settings picks", reply.account === "claude-mix" && turns.at(-1)?.account === "claude-mix");
await call("PATCH", "/accounts/claude-mix", { enabled: false });
reply = await turn(conversations.create({ agentId: agent.id, modelId: "auto", title: "Auto off" }).id, "auto");
check("…and the built-in when that account is off", reply.account === "claude", reply.account);
await call("PATCH", "/accounts/claude-mix", { enabled: true });

// --- Usage limits: another account of the same provider first ---------------------------------------------------
limited.add("claude-mix");
const capped = conversations.create({ agentId: agent.id, modelId: "auto", title: "Limit" });
reply = await turn(capped.id, "claude-mix:claude-opus-5-5");
const notice = reply.parts.find((p) => p.type === "notice");
check("an account at its limit moves to another account of the same provider", reply.status === "complete" && reply.account === "claude" && reply.provider === "claude" && turns.at(-1)?.account === "claude", `${reply.status} ${reply.account} ${reply.error ?? ""}`);
check("…saying so", Boolean(notice && notice.type === "notice" && notice.text.includes("Claude Mix is at its usage limit") && notice.text.includes("switched to Claude")), JSON.stringify(notice));
check("…and the limit is kept for that account only", limits.active().has("claude-mix") && !limits.active().has("claude"));
const statusesNow = await routingStatuses();
const viaFallback = sameProviderFallback({ provider: "claude", account: "claude", model: "claude-opus-5-5", effort: "high", reason: "Picked by you" }, statusesNow, new Set(["claude", "claude-mix"]));
check("no same-provider fallback when every account of it is limited", viaFallback === null);
const toWork = sameProviderFallback({ provider: "chatgpt", account: "chatgpt", model: "gpt-6-luna", effort: "low", reason: "Auto" }, statusesNow, new Set(["chatgpt"]));
check("the fallback keeps the model when offered, else the account's first", toWork?.route.account === "codex-work" && toWork.route.model === "gpt-6.1-sol");
// Auto with Claude's default at its limit: a same-provider account before switching to ChatGPT.
reply = await turn(conversations.create({ agentId: agent.id, modelId: "auto", title: "Auto limit" }).id, "auto");
check("Auto stands in another Claude account for a limited default, before ChatGPT", reply.provider === "claude" && reply.account === "claude", `${reply.provider} ${reply.account}`);
limited.add("claude");
limits.clear("claude");
limits.clear("claude-mix");
reply = await turn(conversations.create({ agentId: agent.id, modelId: "auto", title: "Both limited" }).id, "claude-mix:claude-opus-5-5");
check("with every Claude account limited, a picked model fails as before", reply.status === "error" && turns.at(-1)?.account === "claude", `${reply.status} ${turns.at(-1)?.account}`);
limited.clear();
limits.clear("claude");
limits.clear("claude-mix");

// --- Routing reads accounts -------------------------------------------------------------------------------------
const routed = resolveRoute("claude-mix:claude-sonnet-5-5", "hi", { statuses: [], accounts: await routingStatuses(), limited: new Set() });
check("resolveRoute picks the account's status", routed.ok && routed.route.account === "claude-mix" && routed.route.provider === "claude");
const legacy = resolveRoute("auto", "hi", { statuses: (await routingStatuses()).filter((s) => s.accountId === "claude" || s.accountId === "chatgpt"), limited: new Set() });
check("without account statuses Auto stays on the built-ins", legacy.ok && legacy.route.account === "claude");

accounts.remove("claude-mix");
check("removing an account drops it", !accounts.get("claude-mix") && parseModelId("claude-mix:claude-opus-5-5") === "auto");

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
