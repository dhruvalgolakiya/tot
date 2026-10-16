// The phone app's sign-in (roadmap module 14): /login with JSON gives a session token, sent as a Bearer header,
// listed and signed out in Settings → Devices like a browser. Exercised in-process against the real app.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx apps/server/mobile-auth.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot

process.env.TOT_ACCESS_TOKEN = "";
process.env.TOT_LAN = "";
process.env.TOT_HOST = "";

const { createApp } = await import("./app.ts");
const { newSignInCode } = await import("./access.ts");
const { db } = await import("./db.ts");
type Status = import("@tot/shared/types").DevicesStatus;
type LiveRuns = import("@tot/shared/types").LiveRuns;
const app = createApp();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
}

const HERE = "127.0.0.1";
const PHONE = "100.101.4.9";

/** `from` fakes the connection's address (what @hono/node-server's getConnInfo reads). */
const send = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}, from = PHONE) =>
  app.request(
    `http://127.0.0.1:8787${path}`,
    { ...init, headers: { host: from === HERE ? "127.0.0.1:8787" : "100.101.4.2:8787", ...init.headers } },
    { incoming: { socket: { remoteAddress: from, remotePort: 50000, remoteFamily: "IPv4" } } },
  );
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const signIn = async (body: Record<string, unknown>) => {
  const res = await send("/login", json({ client: "mobile", ...body }));
  return { status: res.status, cookie: res.headers.get("set-cookie"), body: (await res.json()) as { token?: string; deviceName?: string; error?: string } };
};

// --- Before sign-in is set up ----------------------------------------------------------------------------
console.log("# Before a password is set");
let out = await signIn({ password: "correct horse battery", deviceName: "iPhone" });
check("the app is told remote access is off, as JSON", out.status === 409 && /remote access/.test(out.body.error ?? ""), JSON.stringify(out.body));

let res = await send("/api/access/password", json({ password: "correct horse battery" }), HERE);
check("this computer sets the password", res.status === 200);

// --- Password -----------------------------------------------------------------------------------------------
console.log("\n# Signing in with the password");
res = await send("/api/agents");
check("another device without a token is refused", res.status === 401);
out = await signIn({ password: "wrong horse battery", deviceName: "iPhone" });
check("a wrong password is refused, as JSON", out.status === 401 && /didn't match/.test(out.body.error ?? ""));
res = await send("/login", json({ password: "correct horse battery" }));
check("JSON without client: mobile is refused", res.status === 400);
out = await signIn({ password: "correct horse battery", deviceName: "  Dhruval's\n iPhone  " });
const token = out.body.token ?? "";
check("the password gives a session token", out.status === 200 && /^tots_[\w-]+\.[\w-]{20,}$/.test(token) && typeof out.body.deviceName === "string");
check("no cookie is set for the app", out.cookie === null);

res = await send("/api/agents", { headers: bearer(token) });
check("the token works as a Bearer header", res.status === 200 && Array.isArray(await res.json()));
res = await send("/api/agents", { headers: { cookie: `tot_session=${token.slice(5)}` } });
check("…and is the same session a browser cookie would hold", res.status === 200);
res = await send("/api/agents", { headers: bearer(`${token.slice(0, -4)}abcd`) });
check("a changed token is refused", res.status === 401);
res = await send("/api/agents", { headers: bearer("tots_not-a-session") });
check("a made-up token is refused", res.status === 401);
res = await send("/api/memories", json({ content: "from the phone app" }, bearer(token)));
check("writes work with the token and no Origin (a native app sends none)", res.status === 201, String(res.status));
res = await send("/api/memories", json({ content: "from a website" }, { ...bearer(token), origin: "https://evil.example" }));
check("the Origin check still applies", res.status === 403);

// Live updates: the app reads SSE with fetch, so the header works there too.
const events = new AbortController();
res = await send("/api/events", { headers: bearer(token), signal: events.signal });
check("the event stream takes the token", res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/event-stream"));
const reader = res.body!.getReader();
const first = new TextDecoder().decode((await reader.read()).value);
check("…and streams", first.includes("event: ready"), first);
res = await send("/api/events");
check("the event stream without a token is refused", res.status === 401);

// --- Listed and signed out like a browser --------------------------------------------------------------------
console.log("\n# Settings → Devices");
let status = (await (await send("/api/devices", {}, HERE)).json()) as Status;
const listed = status.sessions.find((s) => s.label === "TOT app on Dhruval's iPhone");
check("the app shows in the sign-in list, named after the phone", Boolean(listed), status.sessions.map((s) => s.label).join(", "));
res = await send(`/api/sessions/${listed?.id}`, { method: "DELETE" }, HERE);
check("this computer signs it out", res.status === 200);
const closed = await Promise.race([reader.read().then((r) => r.done), new Promise((r) => setTimeout(() => r("timeout"), 2000))]);
check("its open event stream closes at once", closed === true, String(closed));
events.abort();
res = await send("/api/agents", { headers: bearer(token) });
check("the signed-out token is refused", res.status === 401);

// --- One-time code from the QR code ---------------------------------------------------------------------------
console.log("\n# Signing in with the QR code");
// What POST /api/access/sign-in-link puts in the QR code's link (it needs a live listener; access.test.ts covers it).
const { code } = newSignInCode();
out = await signIn({ code, deviceName: "iPad" });
const second = out.body.token ?? "";
check("the QR code's code gives a token", out.status === 200 && second.startsWith("tots_"));
out = await signIn({ code, deviceName: "iPad" });
check("the code works once", out.status === 401 && /expired|already used/.test(out.body.error ?? ""));
res = await send("/logout", { method: "POST", headers: bearer(second) });
check("the app signs itself out, answered as JSON", res.status === 200 && ((await res.json()) as { ok: boolean }).ok);
res = await send("/api/agents", { headers: bearer(second) });
check("…and its token stops working", res.status === 401);
status = (await (await send("/api/devices", {}, HERE)).json()) as Status;
check("…and it leaves the sign-in list", !status.sessions.some((s) => s.label.startsWith("TOT app")));

// --- The browser form is unchanged ------------------------------------------------------------------------------
res = await send("/login", {
  method: "POST",
  body: new URLSearchParams({ password: "correct horse battery", next: "/" }).toString(),
  headers: { "content-type": "application/x-www-form-urlencoded" },
});
check("the browser form still sets a cookie and redirects", res.status === 302 && (res.headers.get("set-cookie") ?? "").startsWith("tot_session="));

// --- What's running and waiting, for a screen that just opened ----------------------------------------------------
console.log("\n# GET /api/runs/live");
res = await send("/api/runs/live");
check("it needs sign-in like the rest", res.status === 401);
let live = (await (await send("/api/runs/live", {}, HERE)).json()) as LiveRuns;
check("nothing running or waiting in a quiet TOT", live.running.length === 0 && live.waiting.length === 0, JSON.stringify(live));
const agent = ((await (await send("/api/agents", {}, HERE)).json()) as { id: string }[])[0];
const chat = (await (await send("/api/conversations", json({ agentId: agent.id }), HERE)).json()) as { id: string };
db.prepare(`INSERT INTO lead_asks (id, conversation_id, message_id, task_id, action, method, head_sha, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
  "a_test", chat.id, "m_test", "t_test", "land", "merge", null, Date.now(), Date.now() + 60_000,
);
live = (await (await send("/api/runs/live", {}, HERE)).json()) as LiveRuns;
check("a Lead's open land card counts as waiting, with its agent", live.waiting.some((w) => w.conversationId === chat.id && w.agentId === agent.id), JSON.stringify(live));
db.prepare(`UPDATE lead_asks SET answered_at = ?, decision = 'accept' WHERE id = 'a_test'`).run(Date.now());
live = (await (await send("/api/runs/live", {}, HERE)).json()) as LiveRuns;
check("…and stops once it's answered", live.waiting.length === 0);

// --- Guessing ---------------------------------------------------------------------------------------------------
console.log("\n# Guessing");
let last = 0;
for (let i = 0; i < 25; i++) last = (await send("/api/health", { headers: bearer(`tots_${i}.guessguessguessguessguess`) })).status;
check("guessing session tokens gets locked out", last === 429, String(last));
out = await signIn({ password: "correct horse battery", deviceName: "iPhone" });
check("the app's password sign-in is locked out too", out.status === 429);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
