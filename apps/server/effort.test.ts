// A chat's reasoning effort: kept per chat (PATCH, or when it's created), used for a picked model's turns, raised by
// "Think harder", ignored by Auto; and left to TOT, as before, when the chat has none.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx apps/server/effort.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import type { Conversation, ProviderStatus } from "@tot/shared/types";

process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test

const { createApp } = await import("./app.ts");
const { agents } = await import("./data/agents.ts");
const { conversations } = await import("./data/conversations.ts");
const { resolveRoute, CLAUDE_OPUS, CLAUDE_SONNET } = await import("./agent/router.ts");
const app = createApp();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 200)}` : ""}`);
}

const request = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(
    `http://127.0.0.1:8787/api${path}`,
    {
      method,
      headers: { host: "127.0.0.1:8787", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 50000, remoteFamily: "IPv4" } } },
  );
  return { status: res.status, body: (await res.json()) as Conversation & { error?: string } };
};

// --- 1. Kept per chat ---

const agent = agents.first();
const chat = conversations.create({ agentId: agent.id, modelId: "claude:claude-opus-5-5", title: "Effort" });
check("a new chat has no effort of its own", conversations.get(chat.id)!.effort == null);
let res = await request("PATCH", `/conversations/${chat.id}`, { effort: "max" });
check("PATCH sets it", res.status === 200 && res.body.effort === "max", JSON.stringify(res.body).slice(0, 200));
check("…and it's kept", conversations.get(chat.id)!.effort === "max");
const listed = ((await request("GET", "/conversations?slim=1")).body as unknown as Conversation[]).find((c) => c.id === chat.id);
check("the slim list carries it", listed?.effort === "max");
res = await request("PATCH", `/conversations/${chat.id}`, { effort: "ludicrous" });
check("something that isn't an effort is refused", res.status === 400 && conversations.get(chat.id)!.effort === "max", JSON.stringify(res.body));
res = await request("PATCH", `/conversations/${chat.id}`, { title: "Renamed" });
check("other changes leave it alone", res.status === 200 && res.body.effort === "max");
res = await request("PATCH", `/conversations/${chat.id}`, { effort: null });
check("null hands it back to TOT", res.status === 200 && res.body.effort === undefined && conversations.get(chat.id)!.effort == null);
res = await request("POST", "/conversations", { agentId: agent.id, modelId: "claude:claude-sonnet-5-5", effort: "low" });
check("a chat can be created with one", res.status === 201 && res.body.effort === "low", JSON.stringify(res.body).slice(0, 200));
res = await request("POST", "/conversations", { agentId: agent.id, effort: "turbo" });
check("…but not with something else", res.status === 201 && res.body.effort === undefined);

// --- 2. Used for its turns ---

const claude: ProviderStatus = {
  id: "claude",
  accountId: "claude",
  label: "Claude",
  installed: true,
  loggedIn: true,
  models: [
    { id: `claude:${CLAUDE_OPUS}`, provider: "claude", accountId: "claude", model: CLAUDE_OPUS, label: "Claude Opus 5.5", available: true },
    { id: `claude:${CLAUDE_SONNET}`, provider: "claude", accountId: "claude", model: CLAUDE_SONNET, label: "Claude Sonnet 5.5", available: true },
  ],
};
const route = (modelId: string, opts: { effort?: "low" | "medium" | "high" | "xhigh" | "max"; thinkHarder?: boolean; text?: string } = {}) => {
  const result = resolveRoute(modelId, opts.text ?? "hello", { statuses: [claude], accounts: [claude], limited: new Set(), effort: opts.effort, thinkHarder: opts.thinkHarder });
  return result.ok ? result.route : null;
};

check("without one, a picked Claude model runs at high, as before", route(`claude:${CLAUDE_OPUS}`)?.effort === "high");
check("a picked model runs at the chat's effort", route(`claude:${CLAUDE_OPUS}`, { effort: "low" })?.effort === "low");
check("…max included", route(`claude:${CLAUDE_OPUS}`, { effort: "max" })?.effort === "max");
check("Think harder raises it to xhigh", route(`claude:${CLAUDE_OPUS}`, { effort: "low", thinkHarder: true })?.effort === "xhigh");
check("…but never lowers it", route(`claude:${CLAUDE_OPUS}`, { effort: "max", thinkHarder: true })?.effort === "max");
const auto = route("auto", { effort: "max" });
check("Auto picks its own effort", auto?.effort === "low" && auto.model === CLAUDE_SONNET, JSON.stringify(auto));

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
