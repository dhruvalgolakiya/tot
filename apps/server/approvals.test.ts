// Approval cards: a tool's elicitation pauses the turn until the user answers over the API.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx apps/server/approvals.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { randomUUID } from "node:crypto";
import type { AppEvent, Message, MessagePart, RunEvent } from "@tot/shared/types";

process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test

const { makeElicitor, toFields } = await import("./agent/approvals.ts");
const { MessageBuilder } = await import("./agent/message-builder.ts");
const { Run } = await import("./agent/runs.ts");
const { answerServerRequest } = await import("./agent/providers/chatgpt.ts");
const { appEvents } = await import("./app-events.ts");
const { agents } = await import("./data/agents.ts");
const { conversations } = await import("./data/conversations.ts");
const { messages } = await import("./data/messages.ts");
const { createApp } = await import("./app.ts");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 170)}` : ""}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const agent = agents.create({ name: "Asker", mascot: { shape: "blob", color: "#a78bfa", accessory: "none", eyes: "dots" } });
const conversation = conversations.create({ agentId: agent.id, modelId: "auto" });
const assistant: Message = { id: randomUUID(), conversationId: conversation.id, role: "assistant", parts: [], status: "streaming", createdAt: Date.now() };
messages.insert(assistant);
const run = new Run(conversation.id, assistant.id);
const events: RunEvent[] = [];
const builder = new MessageBuilder(assistant, (event) => {
  events.push(event);
  run.push(event);
});
const appSeen: AppEvent[] = [];
appEvents.subscribe((event) => appSeen.push(event));
const elicit = makeElicitor({ run, builder, agentId: agent.id, unattended: false });

const app = createApp();
const answer = (partId: string, body: unknown, runId: string = run.id) =>
  app.request(`http://localhost:8787/api/runs/${runId}/approvals/${partId}`, {
    method: "POST",
    headers: { Host: "localhost:8787", Origin: "http://localhost:8787", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const lastApproval = () => [...assistant.parts].reverse().find((p): p is Extract<MessagePart, { type: "approval" }> => p.type === "approval")!;

// Confirm → approve.
let pending = elicit({ source: "apps", message: "Send the email to bob@acme.com?", mode: "form", schema: { type: "object", properties: {} } });
await sleep(10);
let part = lastApproval();
check("card shown while waiting", part.kind === "confirm" && part.status === "pending" && part.source === "Apps" && events.some((e) => e.type === "part-start"));
check("app-wide nudge", appSeen.some((e) => e.type === "approval" && e.pending && e.partId === part.id));
check("card saved with the message", JSON.stringify(messages.listByConversation(conversation.id)).includes("bob@acme.com"));
check("wrong run can't answer", (await answer(part.id, { decision: "accept" }, "other-run")).status === 404);
check("bad body refused", (await answer(part.id, { decision: "maybe" })).status === 400);
check("answer accepted", (await answer(part.id, { decision: "accept" })).status === 200);
let result = await pending;
check("tool gets accept", result.action === "accept" && lastApproval().status === "accepted", JSON.stringify(result));
check("answering twice is refused", (await answer(part.id, { decision: "accept" })).status === 404);

// Deny.
pending = elicit({ source: "github", message: "Comment on #12?", mode: "form" });
await sleep(10);
await answer(lastApproval().id, { decision: "decline" });
result = await pending;
check("deny", result.action === "decline" && lastApproval().status === "declined" && lastApproval().source === "GitHub");

// Form: values are typed and only declared fields pass.
const schema = {
  type: "object",
  properties: {
    to: { type: "string", title: "To" },
    count: { type: "integer" },
    urgent: { type: "boolean", default: false },
    tone: { type: "string", enum: ["warm", "formal"] },
  },
  required: ["to"],
};
pending = elicit({ source: "apps", message: "Fill in", mode: "form", schema });
await sleep(10);
part = lastApproval();
check("form fields", part.kind === "form" && part.fields?.map((f) => `${f.name}:${f.type}`).join(",") === "to:string,count:number,urgent:boolean,tone:enum" && part.fields[0]!.required);
await answer(part.id, { decision: "accept", values: { to: "bob", count: "3", urgent: "true", tone: "rude", extra: "x" } });
result = await pending;
check("form values cleaned", JSON.stringify(result.content) === JSON.stringify({ to: "bob", count: 3, urgent: true }), JSON.stringify(result.content));
check("unrenderable form declined", toFields({ type: "object", properties: { list: { type: "array" } } }) === null);

// URL mode.
pending = elicit({ source: "apps", message: "Sign in to Gmail", mode: "url", url: "https://accounts.google.com/o/oauth2/auth?x=1" });
await sleep(10);
check("link card", lastApproval().kind === "url" && lastApproval().url?.startsWith("https://accounts.google.com") === true);
await answer(lastApproval().id, { decision: "accept" });
check("link done", (await pending).action === "accept");

// Timeout → declined, marked expired.
const quick = makeElicitor({ run, builder, agentId: agent.id, unattended: false, waitMs: 150 });
result = await quick({ source: "apps", message: "Anyone?", mode: "form" });
check("unanswered request expires", result.action === "decline" && lastApproval().status === "expired");
check("nudge cleared", appSeen.some((e) => e.type === "approval" && !e.pending && e.partId === lastApproval().id));

// Codex: elicitations for a thread with a running turn go to that turn's card.
const viaCodex = await answerServerRequest(
  "mcpServer/elicitation/request",
  { threadId: "t1", turnId: null, serverName: "apps", mode: "form", message: "Delete it?", _meta: null, requestedSchema: { type: "object", properties: {} } },
  new Map([["t1", async () => ({ action: "decline" as const })]]),
);
check("codex routes to the turn", JSON.stringify(viaCodex) === JSON.stringify({ action: "decline", content: null, _meta: null }), JSON.stringify(viaCodex));

// Stopping the chat cancels a waiting request.
pending = elicit({ source: "apps", message: "Still there?", mode: "form" });
await sleep(10);
run.controller.abort();
result = await pending;
check("stop cancels", result.action === "cancel" && lastApproval().status === "expired");

agents.delete(agent.id);
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
