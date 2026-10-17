// Organizing chats: archive, snooze and unread through PATCH /api/conversations/:id, and what changes them on its own —
// a finished reply makes a chat unread, a new turn brings it back, needing the user wakes it, and so does a snooze
// running out.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx apps/server/chat-organize.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import type { AppEvent, Conversation, TaskInfo } from "@tot/shared/types";

process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test

const { createApp } = await import("./app.ts");
const { agents } = await import("./data/agents.ts");
const { conversations, toPublicConversation } = await import("./data/conversations.ts");
const { appEvents } = await import("./app-events.ts");
const { chatOrganizer } = await import("./chats/organize.ts");
const app = createApp();
chatOrganizer.start();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 200)}` : ""}`);
}

const request = (method: string, path: string, body?: unknown) =>
  app.request(
    `http://127.0.0.1:8787/api${path}`,
    {
      method,
      headers: { host: "127.0.0.1:8787", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 50000, remoteFamily: "IPv4" } } },
  );
const patch = async (id: string, body: unknown) => {
  const res = await request("PATCH", `/conversations/${id}`, body);
  return { status: res.status, body: (await res.json()) as Conversation & { error?: string } };
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const get = (id: string) => conversations.get(id)!;

const published: Conversation[] = [];
appEvents.subscribe((event) => {
  if (event.type === "conversation") published.push(event.conversation);
});

const agent = agents.first();
const newChat = (title: string) => conversations.create({ agentId: agent.id, modelId: "auto", title });

// --- 1. Archive ---

const chat = newChat("Groceries");
let res = await patch(chat.id, { archived: true });
check("archiving sets archivedAt", res.status === 200 && typeof res.body.archivedAt === "number", JSON.stringify(res.body));
check("…and tells every tab", published.at(-1)?.id === chat.id && typeof published.at(-1)?.archivedAt === "number");
let list = (await (await request("GET", "/conversations?slim=1")).json()) as Conversation[];
check("the slim list carries it", typeof list.find((c) => c.id === chat.id)?.archivedAt === "number");
res = await patch(chat.id, { archived: false });
check("unarchiving brings it back", res.status === 200 && res.body.archivedAt === undefined, JSON.stringify(res.body));
const plain = toPublicConversation(get(newChat("Plain").id));
check(
  "a chat that's none of these carries none of the fields",
  !("archivedAt" in plain) && !("snoozedUntil" in plain) && !("unread" in plain),
  JSON.stringify(plain),
);

// --- 2. Snooze ---

const later = Date.now() + 3_600_000;
res = await patch(chat.id, { snoozedUntil: later });
check("snoozing sets snoozedUntil", res.status === 200 && res.body.snoozedUntil === later, JSON.stringify(res.body));
res = await patch(chat.id, { archived: true });
check("archiving ends the snooze", res.body.snoozedUntil === undefined && typeof res.body.archivedAt === "number", JSON.stringify(res.body));
res = await patch(chat.id, { snoozedUntil: later });
check("snoozing ends the archive", res.body.archivedAt === undefined && res.body.snoozedUntil === later, JSON.stringify(res.body));
res = await patch(chat.id, { snoozedUntil: null });
check("null ends the snooze", res.status === 200 && res.body.snoozedUntil === undefined);
res = await patch(chat.id, { snoozedUntil: Date.now() - 1000 });
check("a time that has passed is refused", res.status === 400 && /passed/.test(res.body.error ?? ""), JSON.stringify(res.body));
res = await patch(chat.id, { snoozedUntil: "tomorrow" });
check("so is something that isn't a time", res.status === 400, JSON.stringify(res.body));
res = await patch(chat.id, { snoozedUntil: later, archived: true });
check("and archive and snooze at once", res.status === 400, JSON.stringify(res.body));
check("refused requests change nothing", get(chat.id).snoozedUntil == null && get(chat.id).archivedAt == null);

// --- 3. Unread ---

res = await patch(chat.id, { unread: true });
check("mark unread", res.status === 200 && res.body.unread === true);
res = await patch(chat.id, { unread: false });
check("mark read", res.status === 200 && res.body.unread === undefined);

// --- 4. Replies, turns, needing the user ---

const run = (conversationId: string, status: "running" | "complete" | "error" | "stopped") =>
  appEvents.publish({ type: "run", runId: "r1", conversationId, agentId: agent.id, status });

const replied = newChat("Replied");
run(replied.id, "complete");
check("a finished reply makes the chat unread", get(replied.id).unread === true);
check("…and every tab hears it", published.at(-1)?.id === replied.id && published.at(-1)?.unread === true);
const stopped = newChat("Stopped");
run(stopped.id, "stopped");
check("a reply the user stopped doesn't", !get(stopped.id).unread);

const archived = newChat("Archived");
await patch(archived.id, { archived: true });
run(archived.id, "running");
check("a new turn brings an archived chat back", get(archived.id).archivedAt == null && !get(archived.id).unread);
const snoozed = newChat("Snoozed");
await patch(snoozed.id, { snoozedUntil: later });
run(snoozed.id, "running");
check("…and a snoozed one", get(snoozed.id).snoozedUntil == null);

const failing = newChat("Failing");
await patch(failing.id, { snoozedUntil: later });
run(failing.id, "error");
check("a failed reply wakes a snoozed chat, unread", get(failing.id).snoozedUntil == null && get(failing.id).unread === true);

const asking = newChat("Asking");
await patch(asking.id, { archived: true });
appEvents.publish({ type: "approval", agentId: agent.id, conversationId: asking.id, runId: "r", partId: "p", message: "OK to run rm?", pending: true });
check("an approval wakes an archived chat, unread", get(asking.id).archivedAt == null && get(asking.id).unread === true);
const answered = newChat("Answered");
await patch(answered.id, { snoozedUntil: later });
appEvents.publish({ type: "approval", agentId: agent.id, conversationId: answered.id, runId: "r", partId: "p", message: "", pending: false });
check("an approval answered elsewhere doesn't", get(answered.id).snoozedUntil === later);

const parent = newChat("Parent");
await patch(parent.id, { snoozedUntil: later });
const task = conversations.create({ agentId: agent.id, modelId: "auto", title: "Task", kind: "task", parentId: parent.id });
await patch(task.id, { snoozedUntil: later });
const needsInput = { ...toPublicConversation(get(task.id)), task: { status: "needs-input" } as TaskInfo };
appEvents.publish({ type: "task", conversation: needsInput } satisfies AppEvent);
check("a task that needs input wakes, and the chat it came from", get(task.id).snoozedUntil == null && get(parent.id).snoozedUntil == null && get(parent.id).unread === true);
const quiet = newChat("Quiet");
await patch(quiet.id, { snoozedUntil: later });
appEvents.publish({ type: "task", conversation: { ...toPublicConversation(get(quiet.id)), task: { status: "running" } as TaskInfo } });
check("a task that's just working doesn't", get(quiet.id).snoozedUntil === later);

// --- 5. Snoozes running out ---

const soon = newChat("Soon");
const notYet = newChat("Not yet");
await patch(soon.id, { snoozedUntil: Date.now() + 60_000 });
await patch(notYet.id, { snoozedUntil: Date.now() + 7_200_000 });
const woken = chatOrganizer.wakeDue(Date.now() + 120_000);
check("a snooze that ran out wakes its chat", woken.includes(soon.id) && get(soon.id).snoozedUntil == null && get(soon.id).unread === true, woken.join());
check("one that hasn't stays snoozed", !woken.includes(notYet.id) && get(notYet.id).snoozedUntil !== null);

const timed = newChat("Timed");
res = await patch(timed.id, { snoozedUntil: Date.now() + 200 });
check("the timer is armed by a PATCH", res.status === 200);
await sleep(600);
check("…and wakes the chat when its time comes", get(timed.id).snoozedUntil == null && get(timed.id).unread === true);

chatOrganizer.stop();
list = (await (await request("GET", "/conversations")).json()) as Conversation[];
check("the full list carries the fields too", list.find((c) => c.id === replied.id)?.unread === true);

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
