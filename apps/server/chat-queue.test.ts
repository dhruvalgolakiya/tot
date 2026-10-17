// The composer's queue: messages sent while a chat's turn runs wait and go out in order when it ends; "send now" hands
// one to the running turn (or stops it at its next step and sends it right after). Fake providers, no network.
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { serve } from "@hono/node-server";
import type { Message, QueuedMessage, SendNowResult } from "@tot/shared/types";

process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test
const PORT = 38_000 + Math.floor(Math.random() * 2000);

const { providers } = await import("./agent/providers/index.ts");
const { runRegistry } = await import("./agent/runs.ts");
const { agents } = await import("./data/agents.ts");
const { conversations } = await import("./data/conversations.ts");
const { messages } = await import("./data/messages.ts");
const { settings } = await import("./data/settings.ts");
const { createApp } = await import("./app.ts");
type AgentProvider = import("./agent/providers/types.ts").AgentProvider;
type TurnInput = import("./agent/providers/types.ts").TurnInput;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 300)}` : ""}`);
}
settings.patch({ computer: { mode: "off" }, memory: { enabled: false } });

// A provider whose turns wait at a gate (when `hold` is on) until the test lets them finish, or they're stopped.
const turns: TurnInput[] = [];
const gates: (() => void)[] = [];
const steered: string[] = [];
let hold = true;
let steerMode: "takes" | "refuses" | "none" = "takes";
let askFirst = false;
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
    if (steerMode !== "none") {
      input.onSteerable?.(async (text) => {
        if (steerMode === "refuses") return false;
        steered.push(text);
        return true;
      });
    }
    if (askFirst) void input.elicit?.({ source: "apps", message: "Send it?", mode: "form", schema: { type: "object", properties: {} } }, input.signal);
    yield { type: "text-delta", blockId: "b1", delta: `Reply ${turns.length}.` };
    if (!hold) return;
    await new Promise<void>((resolve) => {
      gates.push(resolve);
      // A stopped turn's gate goes, so the next release reaches the turn that's running.
      input.signal.addEventListener("abort", () => (gates.splice(gates.indexOf(resolve), 1), resolve()), { once: true });
    });
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
async function waitFor(what: string, ok: () => boolean, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (ok()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  console.log(`      (timed out waiting for ${what})`);
  return false;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
const queued = async (chatId: string) => (await request<QueuedMessage[]>("GET", `/conversations/${chatId}/queue`)).data.map((item) => item.request.text);
const userTexts = (chatId: string) =>
  messages
    .listByConversation(chatId)
    .filter((m) => m.role === "user")
    .map((m) => (m.parts.find((p) => p.type === "text") as { text: string } | undefined)?.text ?? "");
const running = (chatId: string) => Boolean(runRegistry.activeFor(chatId));
/** Lets the turn running in the chat finish, and waits for it to be over (a queued one may start right after). */
async function finish(chatId: string): Promise<void> {
  const run = runRegistry.activeFor(chatId);
  await waitFor("a gate", () => gates.length > 0);
  gates.shift()!();
  await waitFor("the turn to end", () => !run || run.done);
}

const agent = agents.first();
const newChat = (title: string) => conversations.create({ agentId: agent.id, modelId: "claude:claude-opus-5-5", title });

// --- Queued while nothing runs: it goes at once ---------------------------------------------------------------------
const idle = newChat("Idle");
hold = false;
let r = await request<QueuedMessage>("POST", `/conversations/${idle.id}/queue`, { text: "  hello there  " });
check("queueing answers 201 with the item", r.status === 201 && r.data.request.text === "hello there", JSON.stringify(r.data));
await waitFor("the turn", () => turns.length === 1 && !running(idle.id));
check("with nothing running, it goes at once", turns.at(-1)?.prompt === "hello there", turns.at(-1)?.prompt);
check("…and leaves the queue", (await queued(idle.id)).length === 0);
r = await request("POST", `/conversations/${idle.id}/queue`, { text: "   " });
check("an empty message is a 400", r.status === 400);

// --- Queued while a turn runs: in order, one turn after another -----------------------------------------------------
hold = true;
const chat = newChat("Queue");
r = await request("POST", `/conversations/${chat.id}/messages`, { text: "build it" });
check("the first turn starts", r.status === 200 && running(chat.id), JSON.stringify(r.data));
await request("POST", `/conversations/${chat.id}/queue`, { text: "then the tests" });
await request("POST", `/conversations/${chat.id}/queue`, { text: "then the docs" });
check("both wait, in order", JSON.stringify(await queued(chat.id)) === JSON.stringify(["then the tests", "then the docs"]));
check("…while the turn still runs", running(chat.id) && turns.length === 2);
await finish(chat.id);
await waitFor("the next turn", () => turns.length === 3 && running(chat.id));
check("when the turn completes, the first queued one goes", turns.at(-1)?.prompt === "then the tests", turns.at(-1)?.prompt);
check("…and the other still waits", JSON.stringify(await queued(chat.id)) === JSON.stringify(["then the docs"]));
await finish(chat.id);
await waitFor("the last turn", () => turns.length === 4 && running(chat.id));
check("then the next", turns.at(-1)?.prompt === "then the docs", turns.at(-1)?.prompt);
await finish(chat.id);
await settle();
check("the transcript has them in order", JSON.stringify(userTexts(chat.id)) === JSON.stringify(["build it", "then the tests", "then the docs"]), JSON.stringify(userTexts(chat.id)));
check("nothing more starts once the queue is empty", turns.length === 4 && !running(chat.id));

// --- Removing one -----------------------------------------------------------------------------------------------------
await request("POST", `/conversations/${chat.id}/messages`, { text: "one more" });
const item = (await request<QueuedMessage>("POST", `/conversations/${chat.id}/queue`, { text: "never mind" })).data;
r = await request("DELETE", `/conversations/${chat.id}/queue/${item.id}`);
check("a queued message can be removed", r.status === 200 && (await queued(chat.id)).length === 0);
const before = turns.length;
await finish(chat.id);
await settle();
check("…and doesn't go", turns.length === before && !userTexts(chat.id).includes("never mind"));

// --- A turn the user stopped holds the queue ---------------------------------------------------------------------------
const started = (await request<{ runId: string }>("POST", `/conversations/${chat.id}/messages`, { text: "long job" })).data;
const held = (await request<QueuedMessage>("POST", `/conversations/${chat.id}/queue`, { text: "after the stop" })).data;
await request("POST", `/runs/${started.runId}/stop`, {});
await waitFor("the stop", () => !running(chat.id));
await settle();
check("after a stop, the queue waits", JSON.stringify(await queued(chat.id)) === JSON.stringify(["after the stop"]) && !running(chat.id));
let sent = await request<SendNowResult>("POST", `/conversations/${chat.id}/queue/${held.id}/send`, {});
check("send now with nothing running sends it", sent.status === 200 && sent.data.outcome === "sent" && running(chat.id), JSON.stringify(sent.data));
check("…as the next turn", turns.at(-1)?.prompt === "after the stop" && (await queued(chat.id)).length === 0);
await finish(chat.id);

// --- Send now: steered into the running turn ----------------------------------------------------------------------------
steerMode = "takes";
await request("POST", `/conversations/${chat.id}/messages`, { text: "refactor the cart" });
await waitFor("the turn", () => running(chat.id));
const reply = messages.listByConversation(chat.id).at(-1)!;
const note = (await request<QueuedMessage>("POST", `/conversations/${chat.id}/queue`, { text: "use tabs" })).data;
let turnsBefore = turns.length;
sent = await request<SendNowResult>("POST", `/conversations/${chat.id}/queue/${note.id}/send`, {});
await waitFor("the note", () => steered.includes("use tabs"));
const steerMessage = sent.data.outcome === "steered" ? sent.data.message : null;
check("a running turn that takes notes gets it", sent.status === 200 && sent.data.outcome === "steered" && steered.includes("use tabs"), JSON.stringify(sent.data));
check("…saved as a note inside the reply", steerMessage?.steered === true && steerMessage.steeredInto?.messageId === reply.id && messages.get(steerMessage.id)?.steered === true);
check("…out of the queue, and the turn keeps going", (await queued(chat.id)).length === 0 && running(chat.id));
await finish(chat.id);
await settle();
check("…with no turn of its own", turns.length === turnsBefore, `${turns.length} vs ${turnsBefore}`);

// --- Send now: a turn that can't take input stops at its next step, and the message goes right after ---------------------
steerMode = "none";
await request("POST", `/conversations/${chat.id}/messages`, { text: "write the report" });
await waitFor("the turn", () => running(chat.id));
const first = (await request<QueuedMessage>("POST", `/conversations/${chat.id}/queue`, { text: "later one" })).data;
const urgent = (await request<QueuedMessage>("POST", `/conversations/${chat.id}/queue`, { text: "stop, do this instead" })).data;
turnsBefore = turns.length;
sent = await request<SendNowResult>("POST", `/conversations/${chat.id}/queue/${urgent.id}/send`, {});
check("a turn that can't take it is interrupted", sent.status === 200 && sent.data.outcome === "interrupting", JSON.stringify(sent.data));
await waitFor("the interrupting turn", () => turns.length === turnsBefore + 1);
check("…and it goes next, before older ones", turns.at(-1)?.prompt === "stop, do this instead", turns.at(-1)?.prompt);
const interrupted = messages.listByConversation(chat.id).filter((m) => m.role === "assistant").at(-2);
check("…the interrupted reply counts as complete", interrupted?.status === "complete", interrupted?.status);
await finish(chat.id);
await waitFor("the older one", () => turns.at(-1)?.prompt === "later one");
check("the older one still goes after", turns.at(-1)?.prompt === "later one" && (await queued(chat.id)).length === 0);
await finish(chat.id);
void first;

// --- Send now: words only steer; anything that changes the turn goes as its own ------------------------------------------
steerMode = "takes";
await request("POST", `/conversations/${chat.id}/messages`, { text: "plan the move" });
await waitFor("the turn", () => running(chat.id));
const harder = (await request<QueuedMessage>("POST", `/conversations/${chat.id}/queue`, { text: "think harder about it", thinkHarder: true })).data;
turnsBefore = turns.length;
sent = await request<SendNowResult>("POST", `/conversations/${chat.id}/queue/${harder.id}/send`, {});
check("a message with options isn't steered in", sent.data.outcome === "interrupting" && !steered.includes("think harder about it"), JSON.stringify(sent.data));
await waitFor("its turn", () => turns.length === turnsBefore + 1);
check("…it goes as its own turn", turns.at(-1)?.prompt === "think harder about it" && turns.at(-1)?.effort === "xhigh", `${turns.at(-1)?.prompt} ${turns.at(-1)?.effort}`);
await finish(chat.id);

// --- Send now: a turn that couldn't take the note after all: it stops and the note follows as TOT's own turn ----------------
steerMode = "refuses";
await request("POST", `/conversations/${chat.id}/messages`, { text: "migrate the db" });
await waitFor("the turn", () => running(chat.id));
const missed = (await request<QueuedMessage>("POST", `/conversations/${chat.id}/queue`, { text: "back it up first" })).data;
turnsBefore = turns.length;
sent = await request<SendNowResult>("POST", `/conversations/${chat.id}/queue/${missed.id}/send`, {});
check("the note is saved straight away", sent.data.outcome === "steered", JSON.stringify(sent.data));
await waitFor("the follow-up turn", () => turns.length === turnsBefore + 1);
const followUp = messages.listByConversation(chat.id).filter((m) => m.role === "user").at(-1) as Message;
check("…and reaches the model on the next turn", turns.at(-1)!.prompt.includes("back it up first"), turns.at(-1)!.prompt);
check("…as TOT's own quiet turn", followUp.auto === true);
await finish(chat.id);

// --- Not while an approval waits ------------------------------------------------------------------------------------------
steerMode = "takes";
askFirst = true;
const asking = (await request<{ runId: string }>("POST", `/conversations/${chat.id}/messages`, { text: "email bob" })).data;
await waitFor("the turn", () => running(chat.id));
await settle();
const waiting = (await request<QueuedMessage>("POST", `/conversations/${chat.id}/queue`, { text: "and cc alice" })).data;
sent = await request("POST", `/conversations/${chat.id}/queue/${waiting.id}/send`, {});
check("send now waits for the user's answer first (409)", sent.status === 409 && !steered.includes("and cc alice"), JSON.stringify(sent.data));
check("…and the message stays queued", JSON.stringify(await queued(chat.id)) === JSON.stringify(["and cc alice"]));
askFirst = false;
await request("POST", `/runs/${asking.runId}/stop`, {});
await waitFor("the stop", () => !running(chat.id));
await request("DELETE", `/conversations/${chat.id}/queue/${waiting.id}`);

// --- Tasks steer instead, and a gone chat is a 404 -------------------------------------------------------------------------
const task = conversations.create({ agentId: agent.id, modelId: "claude:claude-opus-5-5", title: "A task", kind: "task" });
r = await request("POST", `/conversations/${task.id}/queue`, { text: "hi" });
check("a task has no queue (400)", r.status === 400);
r = await request("GET", `/conversations/no-such-chat/queue`);
check("an unknown chat is a 404", r.status === 404);
r = await request("POST", `/conversations/${chat.id}/queue/no-such-item/send`, {});
check("an unknown item is a 404", r.status === 404);

server.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
