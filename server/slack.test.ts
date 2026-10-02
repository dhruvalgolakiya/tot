// The Slack bot against a fake Slack (Web API + Socket Mode) and a fake model turn.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/slack.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Message, SendMessageRequest, SendMessageResponse } from "../shared/types.ts";

process.env.TOT_ACCESS_TOKEN = "";

const { slack } = await import("./slack.ts");
const { makeElicitor } = await import("./agent/approvals.ts");
const { MessageBuilder } = await import("./agent/message-builder.ts");
const { runRegistry } = await import("./agent/runs.ts");
const { agents } = await import("./data/agents.ts");
const { conversations } = await import("./data/conversations.ts");
const { messages } = await import("./data/messages.ts");
const { getSecret } = await import("./config.ts");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 200)}` : ""}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end && !condition(); ) await sleep(20);
}

// --- Fake Slack -------------------------------------------------------------
const posted: { channel: string; thread_ts?: string; text?: string; blocks?: any[]; ts: string }[] = [];
const updated: { ts: string; text?: string }[] = [];
const reactions: string[] = [];
let tsCounter = 2000;
const nextTs = () => `17900${String(tsCounter++).padStart(5, "0")}.000100`;
const said = (p: { blocks?: any[] }, text: string) => JSON.stringify(p.blocks ?? []).includes(text);
const threadReplies = new Map<string, any[]>();
const api = {
  auth: { test: async () => ({ team: "Acme", user: "tot", user_id: "UBOT" }) },
  chat: {
    postMessage: async (args: any) => {
      const ts = nextTs();
      posted.push({ ...args, ts });
      return { ts };
    },
    update: async (args: any) => updated.push({ ts: args.ts, text: args.text }),
    getPermalink: async (args: any) => ({ permalink: `https://acme.slack.com/archives/${args.channel}/p${args.message_ts.replace(".", "")}` }),
  },
  conversations: {
    replies: async (args: any) => ({ messages: threadReplies.get(`${args.channel}:${args.ts}`) ?? [] }),
    info: async (args: any) => ({ channel: args.channel.startsWith("D") ? { is_im: true } : { name: "eng" } }),
  },
  users: { info: async (args: any) => ({ user: { profile: { display_name: { UALICE: "Alice", UBOB: "Bob", UEVE: "Eve" }[args.user as string] ?? args.user } } }) },
  reactions: {
    add: async (args: any) => reactions.push(`+${args.name}`),
    remove: async (args: any) => reactions.push(`-${args.name}`),
  },
};
class FakeSocket extends EventEmitter {
  async start() {
    this.emit("connected");
    return {};
  }
  async disconnect() {}
}
const socket = new FakeSocket();
const deliver = (type: string, event: any) => socket.emit(type, { ack: async () => {}, event });
const press = (actionId: string, value: string, user: string) =>
  socket.emit("interactive", { ack: async () => {}, body: { type: "block_actions", user: { id: user }, actions: [{ action_id: actionId, value }] } });

// --- Fake model turn: optionally asks for approval, then answers -------------
const sent: { conversationId: string; text: string; preamble: string }[] = [];
let askApproval = false;
slack.useSender(async (conversationId: string, request: SendMessageRequest, options: { preamble?: string } = {}) => {
  sent.push({ conversationId, text: request.text, preamble: options.preamble ?? "" });
  const conversation = conversations.get(conversationId)!;
  const assistant: Message = { id: randomUUID(), conversationId, role: "assistant", parts: [], status: "streaming", createdAt: Date.now() };
  messages.insert(assistant);
  const run = runRegistry.create(conversationId, assistant.id);
  const builder = new MessageBuilder(assistant, (event) => run.push(event));
  void (async () => {
    let answer = `Done: ${request.text}`;
    if (askApproval) {
      const elicit = makeElicitor({ run, builder, agentId: conversation.agentId, unattended: false, waitMs: 1500 });
      const result = await elicit({ source: "apps", message: "Send the email to bob@acme.com?", mode: "form" });
      answer = `Approval: ${result.action}`;
    }
    builder.apply({ type: "text-delta", blockId: "b1", delta: answer });
    const final = builder.finish("complete");
    messages.save(final);
    run.push({ type: "run-end", status: "complete", message: final });
    runRegistry.finish(run);
  })();
  return { runId: run.id, userMessage: assistant, conversation } as unknown as SendMessageResponse;
});

// --- Connect -------------------------------------------------------------------
const bad = await slack.connect({ appToken: "nope", botToken: "xoxb-1" }, { api, socket }).catch((err: Error) => err);
check("token formats checked", bad instanceof Error && /xapp-/.test(bad.message));
let status = await slack.connect({ appToken: "xapp-1-test", botToken: "xoxb-test" }, { api, socket });
check("connects", status.state === "connected" && status.workspace === "Acme" && status.botName === "tot", JSON.stringify(status).slice(0, 120));
check("tokens saved privately", getSecret("slackBotToken") === "xoxb-test" && !JSON.stringify(status).includes("xoxb-test"));
check("manifest has socket mode + events", status.manifest.includes('"socket_mode_enabled": true') && status.manifest.includes("app_mention") && status.createAppUrl.startsWith("https://api.slack.com/apps?new_app=1&manifest_json="));

const puddin = agents.create({ name: "Puddin", mascot: { shape: "cat", color: "#f97316", accessory: "none", eyes: "dots" } });

// --- Not allowed yet ---------------------------------------------------------
deliver("message", { channel: "DALICE", channel_type: "im", user: "UALICE", text: "hi", ts: "1790000001.000100" });
await until(() => posted.length > 0);
status = slack.status();
check("stranger becomes a request", status.requests.some((p) => p.id === "UALICE" && p.name === "Alice"));
check("stranger gets one polite note", posted.length === 1 && /allowed in TOT/.test(posted[0]!.blocks?.[0]?.text ?? ""));
deliver("message", { channel: "DALICE", channel_type: "im", user: "UALICE", text: "hello?", ts: "1790000001.000200" });
await sleep(200);
check("no repeated notes", posted.length === 1 && sent.length === 0);

status = slack.patch({ allow: "UALICE" });
check("allow moves request to people", status.allowedUsers.some((p) => p.id === "UALICE") && !status.requests.length);

// --- A DM picks an agent by name and gets an answer in the thread -----------
posted.length = 0;
deliver("message", { channel: "DALICE", channel_type: "im", user: "UALICE", text: "Puddin: summarize <https://acme.dev|the docs> for <@UBOB>", ts: "1790000002.000100" });
await until(() => posted.length > 0);
const chat = conversations.get(sent[0]?.conversationId ?? "")!;
check("Puddin handles it", chat?.agentId === puddin.id && sent[0]!.text === "summarize the docs (https://acme.dev) for @Bob", sent[0]?.text);
check("chat remembers it came from Slack", chat?.origin?.kind === "slack" && chat.origin.label === "DM with Alice" && chat.origin.url?.includes("archives/DALICE") === true);
check("preamble says where it's from", /came from Slack \(DM with Alice\), from Alice/.test(sent[0]!.preamble));
check("answer posted in the thread", posted[0]?.thread_ts === "1790000002.000100" && posted[0]?.blocks?.[0]?.type === "markdown" && posted[0]?.blocks?.[0]?.text.includes("Done: summarize"));
check("with a link to the chat in TOT", JSON.stringify(posted[0]?.blocks).includes(`/c/${chat.id}|TOT ↗`));
check("eyes then check", reactions.join(",") === "+eyes,-eyes,+white_check_mark", reactions.join(","));

// --- Mentioned inside an existing channel thread: the thread is context -------
posted.length = 0;
threadReplies.set("CENG:1790000003.000100", [
  { ts: "1790000003.000100", user: "UBOB", text: "Checkout is failing for gift cards" },
  { ts: "1790000003.000200", user: "UEVE", text: "Started after yesterday's deploy" },
  { ts: "1790000003.000250", bot_id: "B1", text: "some other bot" },
  { ts: "1790000003.000300", user: "UALICE", text: "<@UBOT> can you look into it?" },
]);
deliver("app_mention", { channel: "CENG", user: "UALICE", text: "<@UBOT> can you look into it?", ts: "1790000003.000300", thread_ts: "1790000003.000100" });
await until(() => posted.length > 0);
const threadRun = sent.at(-1)!;
check("thread so far is context", threadRun.preamble.includes("Bob: Checkout is failing") && threadRun.preamble.includes("Eve: Started after") && !threadRun.preamble.includes("other bot"), threadRun.preamble);
check("default agent answers", conversations.get(threadRun.conversationId)?.agentId === agents.list()[0]!.id);
check("channel label", conversations.get(threadRun.conversationId)?.origin?.label === "#eng");

// --- Follow-up in the same thread: same chat, only what's new -----------------
posted.length = 0;
threadReplies.get("CENG:1790000003.000100")!.push(
  { ts: "1790000003.000400", user: "UBOB", text: "Also happens on mobile" },
  { ts: "1790000003.000500", user: "UALICE", text: "<@UBOT> any update?" },
);
deliver("app_mention", { channel: "CENG", user: "UALICE", text: "<@UBOT> any update?", ts: "1790000003.000500", thread_ts: "1790000003.000100" });
await until(() => posted.length > 0);
const followUp = sent.at(-1)!;
check("follow-up continues the chat", followUp.conversationId === threadRun.conversationId);
check("only new messages as context", followUp.preamble.includes("Bob: Also happens on mobile") && !followUp.preamble.includes("gift cards"), followUp.preamble);

// --- Approvals become buttons ---------------------------------------------------
posted.length = 0;
updated.length = 0;
askApproval = true;
deliver("message", { channel: "DALICE", channel_type: "im", user: "UALICE", text: "email Bob the notes", ts: "1790000004.000100" });
await until(() => posted.some((p) => JSON.stringify(p.blocks).includes("tot_approve")));
const card = posted.find((p) => JSON.stringify(p.blocks).includes("tot_approve"))!;
check("approval posted with buttons", Boolean(card) && card.thread_ts === "1790000004.000100" && JSON.stringify(card.blocks).includes("bob@acme.com"));
const value = card.blocks!.find((b: any) => b.type === "actions").elements[0].value as string;
press("tot_approve", value, "UEVE");
await sleep(150);
check("strangers can't approve", !updated.length);
press("tot_approve", value, "UALICE");
await until(() => posted.some((p) => said(p, "Approval: accept")));
check("approved from Slack", posted.some((p) => said(p, "Approval: accept")));
check("card shows who approved", updated.some((u) => /Approved by <@UALICE>/.test(u.text ?? "")), JSON.stringify(updated));

// Unanswered: expires, and the Slack card says so.
posted.length = 0;
updated.length = 0;
deliver("message", { channel: "DALICE", channel_type: "im", user: "UALICE", text: "email Bob again", ts: "1790000005.000100" });
await until(() => posted.some((p) => said(p, "Approval: decline")), 5000);
check("unanswered approval expires", updated.some((u) => /Expired/.test(u.text ?? "")) && posted.some((p) => said(p, "Approval: decline")));
askApproval = false;

// --- Ignored: the bot itself, edits, duplicates --------------------------------
const before = sent.length;
deliver("message", { channel: "DALICE", channel_type: "im", user: "UBOT", text: "my own reply", ts: "1790000006.000100" });
deliver("message", { channel: "DALICE", channel_type: "im", user: "UALICE", subtype: "message_changed", text: "edit", ts: "1790000006.000200" });
deliver("message", { channel: "DALICE", channel_type: "im", user: "UALICE", bot_id: "B9", text: "bot", ts: "1790000006.000300" });
deliver("message", { channel: "DALICE", channel_type: "im", user: "UALICE", text: "once", ts: "1790000006.000400" });
deliver("message", { channel: "DALICE", channel_type: "im", user: "UALICE", text: "once", ts: "1790000006.000400" });
await until(() => sent.length > before);
await sleep(200);
check("only real, new messages count", sent.length === before + 1, String(sent.length - before));

// --- A thread whose TOT chat was deleted starts a new chat --------------------
conversations.delete(chat.id);
deliver("message", { channel: "DALICE", channel_type: "im", user: "UALICE", text: "back again", ts: "1790000007.000100", thread_ts: "1790000002.000100" });
await until(() => sent.at(-1)?.text === "back again");
check("deleted chat → new chat", sent.at(-1)!.conversationId !== chat.id && Boolean(conversations.get(sent.at(-1)!.conversationId)));

status = slack.patch({ disallow: "UALICE" });
check("disallow", !status.allowedUsers.length);
status = await slack.disconnect();
check("disconnect forgets tokens", status.state === "not-set-up" && !getSecret("slackBotToken") && !getSecret("slackAppToken"));

agents.delete(puddin.id);
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
