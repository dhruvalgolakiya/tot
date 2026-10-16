// Devices M2–M4 (roadmap module 07), with two real TOTs: "MacBook" runs in this process (fake models, so no
// real turn ever runs), "Mac mini" as a child process with its own data dir and port. Pairing both ways,
// what a paired device may do, chatting with the other device's agent through this one, live events,
// offline and back, renaming, a one-way pairing, and unpairing.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx apps/server/devices-pair.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import type { AppEvent, Conversation, DevicesStatus, RunEvent } from "@tot/shared/types";

const MINI_PORT = 18_000 + Math.floor(Math.random() * 1000) * 2;
const BOOK_PORT = MINI_PORT + 1;
const MINI_TOKEN = "Mini-Token-12345";
const BOOK_TOKEN = "Book-Token-12345";
const MINI = `http://127.0.0.1:${MINI_PORT}`;
const BOOK = `http://127.0.0.1:${BOOK_PORT}`;

process.env.TOT_ACCESS_TOKEN = BOOK_TOKEN;
process.env.TOT_PUBLIC_URL = BOOK;

const { providers } = await import("./agent/providers/index.ts");
const { agents } = await import("./data/agents.ts");
const { getSecret } = await import("./config.ts");
const { createApp } = await import("./app.ts");
const { deviceId } = await import("./devices/identity.ts");
const { relay } = await import("./devices/relay.ts");
const { deviceName } = await import("./devices/identity.ts");
const { conversations } = await import("./data/conversations.ts");
const { queueHolds } = await import("./data/queue-holds.ts");
type AgentProvider = import("./agent/providers/types.ts").AgentProvider;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 240)}` : ""}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test: () => Promise<boolean> | boolean, ms = 15_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (await test()) return true;
  return false;
}

function fakeProvider(id: "claude" | "chatgpt", label: string): AgentProvider {
  return {
    id,
    label,
    status: async () => ({ id, label, installed: true, loggedIn: true, models: [{ id: `${id}:m`, provider: id, model: "m", label: "m", available: true }] }),
    async *runTurn(input) {
      yield { type: "session", sessionId: input.sessionId ?? `${id}-${randomUUID().slice(0, 8)}` };
      yield { type: "text-delta", blockId: "b1", delta: `Reply from ${label} on the MacBook.` };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    },
    complete: async () => "A title",
  };
}
providers.claude = fakeProvider("claude", "Claude");
providers.chatgpt = fakeProvider("chatgpt", "ChatGPT");
const kiwi = agents.create({ name: "Kiwi", mascot: { shape: "blob", color: "#60a5fa", accessory: "none", eyes: "dots" } });

// --- The two devices -----------------------------------------------------------------------------
const app = createApp();
const book: ServerType = serve({ fetch: app.fetch, port: BOOK_PORT, hostname: "127.0.0.1" });
const stopBook = () =>
  new Promise<void>((resolve) => {
    book.close(() => resolve());
    (book as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  });

const miniData = mkdtempSync(join(tmpdir(), "tot-mini-"));
const miniLog = join(miniData, "server.log");
let mini: ChildProcess | null = null;
function startMini() {
  const env: NodeJS.ProcessEnv = { ...process.env, TOT_DATA_DIR: miniData, TOT_PORT: String(MINI_PORT), TOT_EXECUTOR_PORT: String(MINI_PORT + 3000), TOT_ACCESS_TOKEN: MINI_TOKEN, TOT_PUBLIC_URL: MINI };
  for (const name of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"]) delete env[name];
  // Set empty, not removed: the server also reads a .env in its working directory (a developer's own checkout may
  // have one), and only variables already set are kept from it. A legacy TOT_LAN there would put the Mac mini on the
  // network.
  env.TOT_LAN = "";
  env.TOT_HOST = "";
  const log = openSync(miniLog, "a");
  mini = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "index.ts")], { env, stdio: ["ignore", log, log] });
}
async function stopMini() {
  if (!mini) return;
  const child = mini;
  mini = null;
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
}
process.on("exit", () => mini?.kill("SIGKILL"));

const call = async (base: string, token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, text };
};
const onMini = (method: string, path: string, body?: unknown) => call(MINI, MINI_TOKEN, method, path, body);
const onBook = (method: string, path: string, body?: unknown) => call(BOOK, BOOK_TOKEN, method, path, body);

/** Collects a stream's SSE events (data lines, parsed) until stopped. */
function listen<T>(base: string, token: string, path: string) {
  const events: T[] = [];
  const controller = new AbortController();
  const done = (async () => {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const data = buffer.slice(0, end).split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
        buffer = buffer.slice(end + 2);
        if (data) events.push(JSON.parse(data) as T);
      }
    }
  })().catch(() => {});
  return { events, stop: () => controller.abort(), done };
}

startMini();
const miniUp = await until(async () => (await fetch(`${MINI}/.well-known/tot`).catch(() => null))?.ok ?? false, 30_000);
check("the Mac mini starts as its own TOT", miniUp, miniUp ? "" : readFileSync(miniLog, "utf8").slice(-600));
if (!miniUp) process.exit(1);
const miniId = ((await (await fetch(`${MINI}/.well-known/tot`)).json()) as { id: string }).id;
const bookId = deviceId();
check("the two devices have different ids", miniId !== bookId);

try {
  // --- M2 · Pairing -------------------------------------------------------------------------------
  console.log("\n# Pairing");
  let res = await onMini("POST", "/api/devices/pairing-link");
  const link: string = res.data?.link ?? "";
  check("the Mac mini makes a one-time link: its address and a code", res.status === 200 && new RegExp(`^${MINI}/pair#[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$`).test(link), link);
  const page = await fetch(link.split("#")[0]);
  check("opening the link shows where to paste it (the code never reaches the server)", page.ok && (await page.text()).includes("Settings → Devices"));

  res = await onBook("POST", "/api/devices/connect", { link });
  check("pasting it on the MacBook pairs them", res.status === 200 && res.data.deviceId === miniId && res.data.canReachYou === true, res.text);

  const bothOnline = await until(async () => {
    const [a, b] = await Promise.all([onMini("GET", "/api/devices"), onBook("GET", "/api/devices")]);
    const bookSeen = (a.data as DevicesStatus).devices.find((d) => d.id === bookId);
    const miniSeen = (b.data as DevicesStatus).devices.find((d) => d.id === miniId);
    return Boolean(bookSeen?.online && bookSeen.canReachUs && miniSeen?.online && miniSeen.canReachUs);
  });
  check("both list the other as online, and reachable both ways", bothOnline);
  const miniStatus = (await onMini("GET", "/api/devices")).data as DevicesStatus;
  check("the Mac mini knows the MacBook by name and address", miniStatus.devices[0]?.name === (await onBook("GET", "/api/devices")).data.self.name && miniStatus.devices[0]?.address === BOOK);

  res = await onBook("POST", "/api/devices/connect", { link });
  check("the same link doesn't work twice", res.status === 400 && /expired or was already used/.test(res.data?.error), res.text);
  res = await onBook("POST", "/api/devices/connect", { link: `${BOOK}/pair#AAAA-BBBB-CCCC` });
  check("a device can't pair with itself", res.status === 400 && /own link/.test(res.data?.error), res.text);

  // --- M2 · What a paired device may do ------------------------------------------------------------
  console.log("\n# What a paired device may do");
  const bookToMini = getSecret(`deviceToken:${miniId}`)!;
  check("the token for calling the Mac mini is kept as a secret", typeof bookToMini === "string" && bookToMini.startsWith("totd_"));
  const asBook = (method: string, path: string, body?: unknown) => call(MINI, bookToMini, method, path, body);
  check("it can use the Mac mini's agents", (await asBook("GET", "/api/agents")).status === 200);
  check("it can't manage devices there", (await asBook("GET", "/api/devices")).status === 403);
  check("…or make pairing links", (await asBook("POST", "/api/devices/pairing-link")).status === 403);
  check("…or see who's signed in", (await asBook("GET", "/api/sessions/current")).status === 403);
  check("…or reach a third device through it", (await asBook("GET", `/api/d/${bookId}/agents`)).status === 403);
  check("…or change its settings and logins", (await asBook("PATCH", "/api/settings", { userName: "x" })).status === 403);
  check("…but may read them", (await asBook("GET", "/api/settings")).status === 200);
  check("…and it can't use the agents' tool endpoint", [401, 403].includes((await asBook("POST", `/mcp/${randomUUID()}`)).status));
  const bodies = [(await onMini("GET", "/api/devices")).text, (await onBook("GET", "/api/devices")).text];
  check("no device token appears in any response", bodies.every((body) => !body.includes("totd_")));

  // --- M3 · Using the other device's agents ---------------------------------------------------------
  console.log("\n# Chatting with the MacBook's agent from the Mac mini");
  const miniEvents = listen<AppEvent>(MINI, MINI_TOKEN, "/api/events");
  const bookEvents = listen<AppEvent>(BOOK, BOOK_TOKEN, "/api/events");
  await sleep(300);
  res = await onMini("GET", `/api/d/${bookId}/agents`);
  check("the Mac mini lists the MacBook's agents through itself", res.status === 200 && res.data.some((a: { id: string }) => a.id === kiwi.id), res.text.slice(0, 200));
  check("…and they aren't the Mac mini's own", !(await onMini("GET", "/api/agents")).data.some((a: { id: string }) => a.id === kiwi.id));

  res = await onMini("POST", `/api/d/${bookId}/conversations`, { agentId: kiwi.id });
  const chat = res.data as Conversation;
  check("a chat with Kiwi is made on the MacBook", res.status === 201 || res.status === 200, res.text.slice(0, 200));
  res = await onMini("POST", `/api/d/${bookId}/conversations/${chat.id}/messages`, { text: "Hello from the Mac mini" });
  const runId: string = res.data?.runId;
  check("sending a message starts a turn on the MacBook", typeof runId === "string", res.text.slice(0, 200));
  const run = listen<RunEvent>(MINI, MINI_TOKEN, `/api/d/${bookId}/runs/${runId}/events`);
  await Promise.race([run.done, sleep(10_000)]);
  const text = run.events
    .map((e) => (e.type === "part-delta" ? e.delta : e.type === "part-start" && e.part.type === "text" ? e.part.text : ""))
    .join("");
  check("its reply streams to the Mac mini, through the Mac mini", text.includes("on the MacBook") && run.events.some((e) => e.type === "run-end"), text);

  const onBookDetail = await onBook("GET", `/api/conversations/${chat.id}`);
  check("the messages are kept on the MacBook", onBookDetail.status === 200 && onBookDetail.data.messages.length === 2);
  check("…and not on the Mac mini", (await onMini("GET", `/api/conversations/${chat.id}`)).status === 404);

  const sawRemote = await until(() =>
    miniEvents.events.some((e) => e.type === "remote" && e.deviceId === bookId && e.event.type === "conversation" && e.event.conversation.id === chat.id),
  );
  check("the Mac mini's screens get the MacBook's events, tagged with the device", sawRemote);
  check("the MacBook's own screens see the chat appear live", bookEvents.events.some((e) => e.type === "conversation" && e.conversation.id === chat.id));
  check("settings and mail events stay on their device", !miniEvents.events.some((e) => e.type === "remote" && ["slack", "github", "apps", "mail", "persona"].includes(e.event.type)));

  const prompt = conversations.get(chat.id)?.systemPrompt ?? "";
  check("the agent's prompt says which device it runs on", prompt.includes(`# Device\nYou run on ${deviceName()}.`), prompt.slice(0, 80));

  // --- M4 · Files, projects and tasks across devices ------------------------------------------------
  console.log("\n# Files, projects and tasks across devices");
  const form = new FormData();
  form.append("file", new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], "shot.png", { type: "image/png" }));
  const upload = await fetch(`${MINI}/api/d/${bookId}/uploads`, { method: "POST", headers: { authorization: `Bearer ${MINI_TOKEN}` }, body: form });
  const attachment = (await upload.json()) as { id: string; url: string };
  check("a file attached on the Mac mini is uploaded to the MacBook", upload.status === 201 && typeof attachment.url === "string", JSON.stringify(attachment));
  const file = await fetch(`${MINI}/api/d/${bookId}${attachment.url.slice(4)}`, { headers: { authorization: `Bearer ${MINI_TOKEN}` } });
  check("…and shows on the Mac mini through it", file.ok && (await file.arrayBuffer()).byteLength === 7);
  res = await onMini("POST", `/api/d/${bookId}/conversations/${chat.id}/messages`, { text: "Look at this", attachments: [attachment.id] });
  check("…and goes with a message to the MacBook's agent", typeof res.data?.runId === "string", res.text.slice(0, 160));
  await until(async () => !(await onBook("GET", `/api/conversations/${chat.id}`)).data.activeRunId);

  res = await onMini("POST", `/api/d/${bookId}/projects`, { kind: "none", name: "Q4 launch" });
  const launch = res.data as { id: string; name: string };
  check("a project made from the Mac mini lives on the MacBook", res.status === 201 || res.status === 200, res.text.slice(0, 160));
  check("…and isn't the Mac mini's", !(await onMini("GET", "/api/projects")).data.some((p: { id: string }) => p.id === launch.id));
  queueHolds.set(kiwi.id, null, "test"); // filed, never run
  res = await onMini("POST", `/api/d/${bookId}/tasks`, { agentId: kiwi.id, goal: "Draft the launch post", projectId: launch.id });
  const task = res.data as Conversation;
  check("a task started from the Mac mini runs on the MacBook, in its project", res.status === 201 && task.kind === "task" && task.projectId === launch.id, res.text.slice(0, 160));
  check(
    "…and its card reaches the Mac mini's screens live",
    await until(() => miniEvents.events.some((e) => e.type === "remote" && e.event.type === "task" && e.event.conversation.id === task.id)),
  );

  res = await onBook("GET", `/api/d/${miniId}/agents`);
  check("it works the other way too: the MacBook lists the Mac mini's agents", res.status === 200 && res.data.length >= 1 && !res.data.some((a: { id: string }) => a.id === kiwi.id));

  // --- M2 · Renaming, offline and back ---------------------------------------------------------------
  console.log("\n# Renaming, offline and back");
  res = await onMini("PATCH", "/api/devices/self", { name: "Studio" });
  check(
    "renaming the Mac mini shows on the MacBook",
    res.status === 200 && (await until(async () => ((await onBook("GET", "/api/devices")).data as DevicesStatus).devices[0]?.name === "Studio")),
  );

  await stopMini();
  const wentOffline = await until(async () => !((await onBook("GET", "/api/devices")).data as DevicesStatus).devices[0]?.online, 10_000);
  check("stopping the Mac mini shows it offline on the MacBook", wentOffline);
  res = await onBook("GET", `/api/d/${miniId}/agents`);
  check("using an offline device says so plainly (not a sign-in error)", res.status === 502 && /offline/.test(res.data?.error), res.text);

  startMini();
  const backOnline = await until(async () => {
    const seen = ((await onBook("GET", "/api/devices")).data as DevicesStatus).devices[0];
    return Boolean(seen?.online && seen.canReachUs);
  }, 30_000);
  check("starting it again brings it back without pairing again", backOnline);

  // --- A one-way pairing --------------------------------------------------------------------------
  console.log("\n# One way");
  miniEvents.stop();
  bookEvents.stop();
  res = await onBook("DELETE", `/api/devices/${miniId}`);
  check("unpairing on the MacBook forgets the Mac mini", res.status === 200 && (res.data as DevicesStatus).devices.length === 0);
  check("…and the Mac mini forgets the MacBook", await until(async () => ((await onMini("GET", "/api/devices")).data as DevicesStatus).devices.length === 0));
  check("…and the old token stops working", (await asBook("GET", "/api/agents")).status === 401);

  process.env.TOT_PUBLIC_URL = "http://127.0.0.1:9"; // nothing listens there
  res = await onMini("POST", "/api/devices/pairing-link");
  res = await onBook("POST", "/api/devices/connect", { link: res.data.link });
  check("when the Mac mini can't reach the MacBook back, pairing still works one way", res.status === 200 && res.data.canReachYou === false, res.text);
  const oneWay = ((await onMini("GET", "/api/devices")).data as DevicesStatus).devices[0];
  check("…and the Mac mini says why it can't reach the MacBook", Boolean(oneWay && !oneWay.online && oneWay.problem), JSON.stringify(oneWay?.problem));
  check("…while the MacBook still uses the Mac mini", (await onBook("GET", `/api/d/${miniId}/agents`)).status === 200);
  res = await onMini("DELETE", `/api/devices/${bookId}`);
  check("unpairing from the side that can't reach the other still forgets it here", res.status === 200 && (res.data as DevicesStatus).devices.length === 0);
  process.env.TOT_PUBLIC_URL = BOOK;

  // --- An expired link ------------------------------------------------------------------------------
  res = await onBook("POST", "/api/devices/pairing-link");
  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 60_000; // the MacBook's clock: six minutes later
  try {
    const late = await onMini("POST", "/api/devices/connect", { link: res.data.link });
    check("a link older than 5 minutes is refused", late.status === 400 && /expired/.test(late.data?.error), late.text);
  } finally {
    Date.now = realNow;
  }

  // --- Wrong codes ----------------------------------------------------------------------------------
  let last = 0;
  for (let i = 0; i < 12; i++) {
    last = (await fetch(`${MINI}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocol: 1, code: `WRONG${i}`, device: { id: randomUUID(), name: "x", addresses: [] }, token: `totd_${"x".repeat(43)}` }) })).status;
  }
  check("guessing codes gets locked out", last === 429, String(last));
} finally {
  relay.stopAll();
  await stopMini();
  await stopBook();
  rmSync(miniData, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
