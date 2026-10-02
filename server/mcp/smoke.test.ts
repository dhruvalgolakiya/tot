// In-process smoke test of TOT's MCP server with a real MCP client and the local computer.
// Run: TOT_DATA_DIR=/tmp/tot-mcp-test npx tsx server/mcp/smoke.test.ts
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import { computerManager } from "../computer/manager.ts";
import { MCP_TOKEN } from "../config.ts";
import { planProgress, repoName } from "../agent/learn-repo.ts";
import { buildSystemPrompt } from "../agent/prompts.ts";
import { keepConversation, parseUpdates } from "../agent/wiki-keeper.ts";
import { agents } from "../data/agents.ts";
import { chatSearch } from "../data/chat-search.ts";
import { conversations } from "../data/conversations.ts";
import { memories } from "../data/memories.ts";
import { messages } from "../data/messages.ts";
import { db } from "../db.ts";
import { wiki } from "../data/wiki.ts";
import { settings } from "../data/settings.ts";
import { bus } from "../events.ts";
import { mcpRoutes } from "./server.ts";

const PORT = 8798;
settings.patch({ computer: { mode: "local" }, memory: { enabled: true } });
const app = new Hono().route("/mcp", mcpRoutes);
const server = serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" });
const agent = agents.create({ name: "Smoke", mascot: { shape: "frog", color: "#4ade80", accessory: "none", eyes: "dots" } });
const conversation = conversations.create({ agentId: agent.id, modelId: "auto" });
const url = new URL(`http://127.0.0.1:${PORT}/mcp/${conversation.id}`);

const states: string[] = [];
bus.subscribe(agent.id, (event) => states.push(event.computer.state));

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 170)}` : ""}`);
}

const client = new Client({ name: "tot-smoke", version: "0.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } }),
);
const text = (result: Awaited<ReturnType<typeof client.callTool>>) =>
  (result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  return { text: text(result), isError: Boolean(result.isError) };
};

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
check("tools listed", tools.length === 19 && tools.includes("routine_create") && tools.includes("wiki_edit"), tools.join(", "));

let r = await call("computer_exec", { command: "echo hi && pwd && node -v" });
check("exec starts computer", !r.isError && r.text.includes("Started a new computer") && r.text.includes("hi"), r.text);
check("computer events published", states.join(",") === "starting,running", states.join(","));

r = await call("computer_write_file", { path: "site/index.html", content: "<h1>TOT works</h1>" });
check("write file", !r.isError && r.text.includes("Wrote"), r.text);
r = await call("computer_read_file", { path: "site/index.html" });
check("read file", r.text.includes("<h1>TOT works</h1>"), r.text);
r = await call("computer_read_file", { path: "../../tot.db" });
check("read escape refused", r.isError, r.text);
r = await call("computer_exec", { command: `cat ${process.env.HOME}/.ssh/known_hosts` });
check("sandbox blocks ~/.ssh", r.text.includes("Operation not permitted"), r.text);

r = await call("computer_exec", { command: "cd site && nohup python3 -m http.server 8124 > server.log 2>&1 & sleep 1; echo started" });
check("background server", r.text.includes("started"), r.text);
r = await call("computer_expose_port", { port: 8124 });
const shared = /(http:\/\/\S+)/.exec(r.text)?.[1];
check("expose port", !r.isError && Boolean(shared), r.text);
const page = shared ? await fetch(shared).then((res) => res.text(), () => "") : "";
check("shared URL serves the page", page.includes("TOT works"), page.slice(0, 60));
check("exposed URL recorded", computerManager.get(agent.id)?.exposedUrls.some((e) => e.port === 8124) ?? false);

r = await call("computer_exec", { command: "sleep 5", timeout_seconds: 1 });
check("timeout", r.text.includes("timed out"), r.text);

r = await call("computer_info");
check("info", r.text.includes("Local workspace") && r.text.includes("port 8124"), r.text);

// Memory is about the user; workspace knowledge lives in the wiki.
const other = agents.create({ name: "Other", mascot: { shape: "cat", color: "#f97316", accessory: "none", eyes: "dots" } });
r = await call("memory_save", { content: "Prefers TypeScript over Python" });
check("memory save", !r.isError && r.text.startsWith("Saved"), r.text);
r = await call("memory_save", { content: "prefers typescript over python" });
check("memory dedupe", r.text.startsWith("Already remembered"), r.text);
r = await call("memory_search", { query: "typescript" });
const memoryId = /\(([0-9a-f-]{36})\)/.exec(r.text)?.[1];
check("memory search", Boolean(memoryId), r.text);
r = await call("memory_update", { id: memoryId ?? "x", content: "Prefers TypeScript; avoids Python" });
check("memory update", !r.isError && memories.get(memoryId ?? "x")?.content === "Prefers TypeScript; avoids Python", r.text);
r = await call("memory_delete", { id: memoryId ?? "x" });
check("memory delete", !r.isError, r.text);

// Wiki: every workspace starts with an Overview; pages nest, and titles only need to be unique among siblings.
check("overview exists", wiki.list(agent.id)[0]?.title === "Overview" && agents.get(agent.id)?.counts.pages === 1);
r = await call("wiki_write", { title: "web", content: "Next.js storefront in `~/repos/web`." });
check("new page needs a summary", r.isError, r.text);
r = await call("wiki_write", { title: "web", summary: "The storefront repo", content: "Next.js storefront in `~/repos/web`." });
const webId = /\(([0-9a-f-]{36})\)/.exec(r.text)?.[1] ?? "";
check("wiki create", !r.isError && r.text.startsWith("Created"), r.text);
await call("wiki_write", { title: "api", summary: "The backend repo", content: "Hono API in `~/repos/api`." });
r = await call("wiki_write", { title: "Architecture", summary: "How web fits together", content: "Pages call the API through `lib/client.ts`.", parent: "web" });
check("nested page", !r.isError && wiki.find(agent.id, "Architecture")?.parentId === webId, r.text);
r = await call("wiki_write", { title: "Architecture", summary: "How the API fits together", content: "Routes in `src/routes.ts` call services.", parent: "api" });
check("same title under another parent", !r.isError && r.text.startsWith("Created"), r.text);
r = await call("wiki_read", { page: "Architecture" });
check("ambiguous title asks for an id", r.isError && r.text.includes("Several pages"), r.text);
r = await call("wiki_write", { title: "Architecture", content: "Pages call the API through `lib/client.ts`; auth via middleware.", parent: "web" });
check("update by title + parent", r.text.startsWith("Updated") && wiki.withTitle(agent.id, "Architecture").length === 2, r.text);
r = await call("wiki_edit", { page: webId, old_text: "Next.js", new_text: "Next.js 16" });
check("wiki edit", !r.isError && wiki.get(webId)?.content.includes("Next.js 16") === true, r.text);
r = await call("wiki_edit", { page: "web", old_text: "", new_text: "## Gotchas\n- Run `pnpm i` first." });
check("wiki append", !r.isError && wiki.get(webId)?.content.endsWith("Run `pnpm i` first.") === true, r.text);
r = await call("wiki_edit", { page: "web", old_text: "not in the page", new_text: "x" });
check("wiki edit needs exact text", r.isError, r.text);
check("one revision per editing burst", wiki.revisions(webId).length === 1, String(wiki.revisions(webId).length));
r = await call("wiki_search", { query: "pnpm" });
check("wiki search", r.text.includes(webId) && r.text.includes("«pnpm»"), r.text);
r = await call("wiki_search");
check("wiki outline", r.text.includes("- Overview") && r.text.includes("  - Architecture"), r.text);
const othersPage = wiki.create(other.id, { title: "Billing", summary: "Other's secret", content: "Confidential pricing" }, "agent");
r = await call("wiki_read", { page: othersPage.id });
check("wiki stays in its workspace", r.isError, r.text);
r = await call("wiki_delete", { page: "Overview" });
check("overview can't be deleted", r.isError, r.text);
r = await call("wiki_delete", { page: "api" });
check("delete moves children up", !r.isError && wiki.withTitle(agent.id, "Architecture", null).length === 1, r.text);
check("page count", agents.get(agent.id)?.counts.pages === 4, JSON.stringify(agents.get(agent.id)?.counts));
const before = wiki.get(webId)!;
wiki.update(webId, { content: "oops" }, "user");
const restored = wiki.restore(webId, wiki.revisions(webId)[0]!.id, "user");
check("restore", restored.content === before.content && wiki.revisions(webId)[0]?.content === "oops");

// Earlier chats in the same workspace are searchable and readable; other agents' aren't.
const say = (conversationId: string, role: "user" | "assistant", body: string, at = Date.now()) =>
  messages.insert({ id: randomUUID(), conversationId, role, parts: [{ type: "text", id: randomUUID(), text: body }], status: "complete", createdAt: at });
const earlier = conversations.create({ agentId: agent.id, modelId: "auto", title: "Pricing page" });
say(earlier.id, "user", "Add a pricing section with three tiers to the landing page");
say(earlier.id, "assistant", "Done — the pricing tiers are Hobby, Pro and Team.");
const elsewhere = conversations.create({ agentId: other.id, modelId: "auto", title: "Secret pricing" });
say(elsewhere.id, "user", "Our internal pricing tiers are confidential");
say(conversation.id, "user", "What were the pricing tiers again?");
r = await call("chat_search", { query: "pricing tiers" });
check("chat search finds earlier chat", r.text.includes(earlier.id) && r.text.includes("Pricing page"), r.text);
check("chat search stays in workspace", !r.text.includes(elsewhere.id) && !r.text.includes(conversation.id), r.text);
r = await call("chat_read", { chatId: earlier.id });
check("chat read", !r.isError && r.text.includes("Hobby, Pro and Team"), r.text);
r = await call("chat_read", { chatId: elsewhere.id });
check("chat read refuses other workspace", r.isError, r.text);

// A new chat starts with the Overview, the page list, related pages in full, and recent chats.
const overview = wiki.overview(agent.id);
wiki.update(overview.id, { content: "Acme's storefront and API. Next: checkout redesign." }, "agent");
const request = "Fix the bug where pnpm install fails in the storefront";
const prompt = buildSystemPrompt({
  settings: settings.get(),
  agent,
  workspace: {
    userMemories: [],
    wiki: {
      overview: wiki.overview(agent.id),
      outline: wiki.outline(agent.id).filter((page) => !page.pinned),
      relevant: wiki.relevant(agent.id, request, 3),
    },
    recentChats: chatSearch.recent(agent.id, { exclude: conversation.id }),
  },
});
check("prompt has overview + index", prompt.includes("checkout redesign") && prompt.includes(`- web (${webId})`), "");
check("prompt includes related page", prompt.includes("## Pages related to this request") && prompt.includes("Run `pnpm i` first"), "");
check("prompt lists recent chats", prompt.includes(earlier.id), "");
check("small talk pulls in no pages", wiki.relevant(agent.id, "hey can you help me with this", 3).length === 0);
check("chat count", agents.get(agent.id)?.counts.chats === 2, JSON.stringify(agents.get(agent.id)?.counts));

// The keeper folds a quiet chat into the wiki through a (fake) model.
const ticket = conversations.create({ agentId: agent.id, modelId: "auto", title: "Checkout bug" });
const longAgo = Date.now() - 10 * 60_000;
say(ticket.id, "user", "Checkout fails with a 500 when the cart has a gift card. ".repeat(4), longAgo);
say(ticket.id, "assistant", "Fixed: gift cards are applied in `src/checkout/total.ts` before tax now; added a regression test. ".repeat(3), longAgo + 1);
let seenPrompt = "";
const fake = (updates: unknown) => async (p: string) => {
  seenPrompt = p;
  return "```json\n" + JSON.stringify({ updates }) + "\n```";
};
let changedPages = await keepConversation(
  ticket.id,
  fake([
    { page: overview.id, title: "Overview", summary: overview.summary, content: "Acme's storefront and API. Gift-card checkout bug fixed. Next: checkout redesign." },
    { title: "Checkout", summary: "How checkout totals work", content: "Gift cards apply before tax in `src/checkout/total.ts`.", parent: webId },
    { page: othersPage.id, title: "Billing", content: "hijacked" },
  ]),
);
check("keeper prompt has wiki + new messages", seenPrompt.includes("<page_index>") && seenPrompt.includes("gift card"), "");
check("keeper applied allowed updates", changedPages.length === 2 && wiki.withTitle(agent.id, "Checkout", webId).length === 1, changedPages.map((p) => p.title).join(","));
check("keeper can't touch other workspaces", wiki.get(othersPage.id)?.content === "Confidential pricing");
const notice = messages.listByConversation(ticket.id).at(-1)?.parts.find((part) => part.type === "notice");
check("keeper leaves a notice", notice?.type === "notice" && notice.kind === "wiki" && notice.pageIds?.length === 2, JSON.stringify(notice));
changedPages = await keepConversation(ticket.id, fake([{ title: "Again", summary: "x", content: "y" }]));
check("keeper reads each message once", changedPages.length === 0 && !wiki.withTitle(agent.id, "Again").length);
say(ticket.id, "user", "One more thing: the gift card endpoint is rate limited to 10 requests per minute per user. ".repeat(5), longAgo + 2);
const webBefore = wiki.get(webId)!.content;
wiki.update(webId, { content: `${webBefore}\n\n${"Detail. ".repeat(250)}` }, "user");
changedPages = await keepConversation(ticket.id, fake([{ page: webId, title: "web", content: "Too short." }]));
check("keeper won't shrink a long page", changedPages.length === 0 && wiki.get(webId)!.content.length > 1500);
check("parse tolerates prose", parseUpdates('Sure! {"updates": []} Done.').length === 0);
const sloppy = parseUpdates('{"updates": [{"page": 5, "title": "web", "summary": null, "content": "x", "parent": {}}, {"title": 3}]}');
check("parse drops bad fields", sloppy.length === 1 && sloppy[0]!.summary === undefined && sloppy[0]!.page === undefined && sloppy[0]!.parent === undefined);

// The keeper never overwrites a page edited while its model was working.
say(ticket.id, "user", "Also: refunds for gift cards go back to the original card, handled in `src/refunds.ts`. ".repeat(5), longAgo + 3);
changedPages = await keepConversation(ticket.id, async () => {
  wiki.update(overview.id, { content: "Edited by the user while the keeper was thinking." }, "user");
  return JSON.stringify({ updates: [{ page: overview.id, title: "Overview", content: "Keeper's version." }] });
});
check("keeper skips pages edited meanwhile", changedPages.length === 0 && wiki.get(overview.id)?.content === "Edited by the user while the keeper was thinking.");

// Moves and reorders keep who wrote the page; deleting keeps the page recoverable and children unique.
const authorBefore = wiki.get(webId)!.updatedBy;
wiki.update(webId, { position: 9 }, "agent");
check("reorder keeps attribution", wiki.get(webId)?.updatedBy === authorBefore && wiki.get(webId)?.position === 9);
wiki.create(agent.id, { title: "Runbook", summary: "Ops runbook", content: "Restart with `pm2 restart all`." }, "user");
const infra = wiki.create(agent.id, { title: "infra", summary: "Infra repo", content: "Terraform." }, "agent");
wiki.create(agent.id, { title: "Runbook", summary: "Infra runbook", content: "terraform apply", parentId: infra.id }, "agent");
const pagesBefore = agents.get(agent.id)!.counts.pages;
wiki.delete(infra.id);
check("delete renames clashing children", wiki.withTitle(agent.id, "Runbook (infra)", null).length === 1 && wiki.withTitle(agent.id, "Runbook", null).length === 1);
check("deleted pages are hidden but kept", wiki.get(infra.id) === null && agents.get(agent.id)!.counts.pages === pagesBefore - 1 && db.prepare("SELECT 1 FROM wiki_pages WHERE id = ?").get(infra.id) !== undefined);
check("titles compare across scripts", (() => {
  wiki.create(agent.id, { title: "Ärzte", summary: "Doctors", content: "x" }, "user");
  try {
    wiki.create(agent.id, { title: "ärzte", summary: "dup", content: "y" }, "user");
    return false;
  } catch {
    return true;
  }
})());
check("repo names", repoName("https://github.com/acme/web.git") === "web" && repoName("git@github.com:acme/api") === "api" && repoName("~/repos/site/") === "site");
{
  const progress = planProgress("Commit: abc\n## Areas\n- [x] Core — src/core → Core\n- [ ] API — src/api\n  * [X] Jobs — src/jobs\n## Open questions\n- why [ ] here");
  check("study plan progress", progress.done === 2 && progress.total === 3, JSON.stringify(progress));
}

agents.delete(other.id);

r = await call("routine_create", { name: "Standup", prompt: "Summarize yesterday", schedule: "daily", time: "09:30", days: [1, 2, 3, 4, 5] });
check("routine create", !r.isError && r.text.includes("every weekday at 09:30"), r.text);
r = await call("routine_create", { name: "Too often", prompt: "x", schedule: "interval", every_minutes: 5 });
check("routine validation", r.isError, r.text);
r = await call("routine_list");
const routineId = /\(([0-9a-f-]{36})\)/.exec(r.text)?.[1];
check("routine list", Boolean(routineId) && r.text.includes("Standup"), r.text);
r = await call("routine_delete", { id: routineId ?? "x" });
check("routine delete", !r.isError, r.text);

await computerManager.stop(agent.id);
check("stop", computerManager.get(agent.id)?.state === "stopped");
const alive = await fetch("http://localhost:8124").then(() => true, () => false);
check("stop killed server", !alive);
r = await call("computer_exec", { command: "ls site" });
check("resume on next use", r.text.includes("Woke the computer up") && r.text.includes("index.html"), r.text);

const unauthorized = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check("401 without token", unauthorized.status === 401);
const unknown = await fetch(`http://127.0.0.1:${PORT}/mcp/nope`, { method: "POST", headers: { Authorization: `Bearer ${MCP_TOKEN}` } });
check("404 for unknown chat", unknown.status === 404);

await client.close();
await computerManager.destroy(agent.id);
agents.delete(agent.id);
server.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
