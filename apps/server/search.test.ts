// Searching every chat's messages (the command palette's Messages): every word must match, as a prefix; snippets mark
// the words; the index follows saves and deletes; at most 3 hits per chat; one agent's chats; symbols match as text.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx apps/server/search.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { randomUUID } from "node:crypto";
import type { Message, SearchResults } from "@tot/shared/types";

process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test

const { createApp } = await import("./app.ts");
const { agents } = await import("./data/agents.ts");
const { conversations } = await import("./data/conversations.ts");
const { messages } = await import("./data/messages.ts");
const { messageSearch, snippetParts, toPaletteQuery } = await import("./data/message-search.ts");
const app = createApp();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 200)}` : ""}`);
}

const send = (path: string) =>
  app.request(
    `http://127.0.0.1:8787/api${path}`,
    { headers: { host: "127.0.0.1:8787" } },
    { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 50000, remoteFamily: "IPv4" } } },
  );

let clock = Date.now() - 60_000;
function say(conversationId: string, role: Message["role"], text: string, status: Message["status"] = "complete"): Message {
  const message: Message = {
    id: randomUUID(),
    conversationId,
    role,
    parts: [{ type: "text", id: randomUUID(), text }],
    status,
    createdAt: (clock += 1000),
  };
  messages.insert(message);
  return message;
}

const agent = agents.first();
const other = agents.create({ name: "Scout", mascot: agent.mascot, instructions: "", modelId: "auto" });
const deployChat = conversations.create({ agentId: agent.id, modelId: "auto", title: "Release day" });
const recipeChat = conversations.create({ agentId: agent.id, modelId: "auto", title: "Dinner" });
const scoutChat = conversations.create({ agentId: other.id, modelId: "auto", title: "Scouting" });

const ask = say(deployChat.id, "user", "Can you deploy the staging server tonight?");
const answer = say(deployChat.id, "assistant", "I deployed staging. The production rollout waits for your OK.");
say(recipeChat.id, "user", "A quick recipe for lentil soup, please");
say(scoutChat.id, "user", "Scout the staging logs for errors");

// --- 1. Matching ---

const ids = (hits: { messageId: string }[]) => hits.map((h) => h.messageId);
check("a word finds the messages that have it", ids(messageSearch.search("staging")).includes(ask.id));
check("words match as prefixes", ids(messageSearch.search("depl")).includes(ask.id) && ids(messageSearch.search("depl")).includes(answer.id));
check("every word must be there", ids(messageSearch.search("staging tonight")).join() === ask.id, ids(messageSearch.search("staging tonight")).join());
check("a missing word means no hit", messageSearch.search("staging lasagna").length === 0);
check("case doesn't matter", ids(messageSearch.search("LENTIL")).length === 1);
check("no words, no FTS query", toPaletteQuery("  ?! ") === null && toPaletteQuery("Deploy deploy") === `"deploy"*`);

const hit = messageSearch.search("production")[0];
check(
  "a hit says which chat, agent, title, message and role",
  hit?.conversationId === deployChat.id && hit.agentId === agent.id && hit.title === "Release day" && hit.messageId === answer.id && hit.role === "assistant",
  JSON.stringify(hit),
);
const marked = hit?.snippet.filter((p) => p.match).map((p) => p.text.toLowerCase()) ?? [];
check("the snippet marks the matched word", marked.join() === "production", JSON.stringify(hit?.snippet));
check("the snippet keeps the words around it", hit?.snippet.map((p) => p.text).join("").includes("rollout waits"), JSON.stringify(hit?.snippet));
check(
  "snippet marks become parts",
  JSON.stringify(snippetParts("a \u0001b\u0002 c")) === JSON.stringify([{ text: "a " }, { text: "b", match: true }, { text: " c" }]),
);

// --- 2. One agent's chats ---

const scoutOnly = messageSearch.search("staging", { agentId: other.id });
check("agentId keeps to that agent's chats", scoutOnly.length === 1 && scoutOnly[0].conversationId === scoutChat.id, JSON.stringify(scoutOnly));
check("without it, every agent's chats", new Set(messageSearch.search("staging").map((h) => h.agentId)).size === 2);

// --- 3. The index follows the messages ---

const streaming = say(recipeChat.id, "assistant", "Lentils need about thirty minutes", "streaming");
check("a reply still being written isn't searched", !ids(messageSearch.search("thirty")).includes(streaming.id));
messages.save({ ...streaming, parts: [{ type: "text", id: "t", text: "Lentils need about twenty minutes, then blend" }], status: "complete" });
check("once it's saved finished, it is", ids(messageSearch.search("twenty blend")).includes(streaming.id));
check("…with its final text, not the earlier one", !ids(messageSearch.search("thirty")).includes(streaming.id));
messages.save({ ...streaming, parts: [{ type: "text", id: "t", text: "Lentils need forty minutes" }], status: "complete" });
check("a later save replaces its text", ids(messageSearch.search("forty")).includes(streaming.id) && !ids(messageSearch.search("twenty")).includes(streaming.id));

// --- 4. At most 3 hits per chat ---

const chatty = conversations.create({ agentId: agent.id, modelId: "auto", title: "Chatty" });
for (let i = 0; i < 6; i++) say(chatty.id, i % 2 ? "assistant" : "user", `Kubernetes question number ${i}`);
const kube = messageSearch.search("kubernetes");
check("one chat gives at most 3 hits", kube.length === 3 && kube.every((h) => h.conversationId === chatty.id), String(kube.length));
check("limit caps the hits", messageSearch.search("staging", { limit: 1 }).length === 1);

// --- 5. Text FTS can't tokenize ---

const arrows = say(recipeChat.id, "user", "Order: soup → bread → salad");
const symbol = messageSearch.search("→");
check("a query of symbols matches as plain text", ids(symbol).includes(arrows.id), JSON.stringify(symbol));
check("…and marks it in the snippet", symbol[0]?.snippet.some((p) => p.match && p.text === "→"), JSON.stringify(symbol[0]?.snippet));
check("% and _ are literal in that match", messageSearch.search("%").length === 0 && messageSearch.search("_").length === 0);
check("an empty query finds nothing", messageSearch.search("   ").length === 0);

// --- 6. A deleted chat's messages go with it ---

conversations.delete(chatty.id);
check("a deleted chat's messages aren't found", messageSearch.search("kubernetes").length === 0);

// --- 7. The route ---

let res = await send(`/search?q=${encodeURIComponent("staging tonight")}`);
const body = (await res.json()) as SearchResults;
check("GET /api/search answers with the hits", res.status === 200 && body.messages.length === 1 && body.messages[0].messageId === ask.id, JSON.stringify(body));
res = await send(`/search?q=staging&agentId=${other.id}`);
check("…keeps to an agent with agentId", ((await res.json()) as SearchResults).messages.every((h) => h.agentId === other.id));
res = await send(`/search`);
check("…and without q answers with none", res.status === 200 && ((await res.json()) as SearchResults).messages.length === 0);

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
