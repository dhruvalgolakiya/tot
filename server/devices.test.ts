// Devices M1 (roadmap module 07): this device's identity, and per-browser sign-in sessions.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/devices.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { sessionValue } from "./session.ts";

process.env.TOT_ACCESS_TOKEN = "Test-Token-1234";
const { db } = await import("./db.ts");

// Sessions made with an older access token are dropped the first time sign-in is checked.
db.prepare(`INSERT INTO settings (key, value) VALUES ('sign-in', 'an-older-token')`).run();
db.prepare(`INSERT INTO sessions (id, secret_hash, label, created_at, last_seen_at) VALUES ('stale', 'x', 'Old', 1, 1)`).run();

const { createApp } = await import("./app.ts");
const { deviceId } = await import("./devices/identity.ts");
const app = createApp();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.slice(0, 160)}` : ""}`);
}

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const send = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}, from = "127.0.0.1") =>
  app.request(
    `http://127.0.0.1:8787${path}`,
    { ...init, headers: { host: "127.0.0.1:8787", ...init.headers } },
    { incoming: { socket: { remoteAddress: from, remotePort: 50000, remoteFamily: "IPv4" } } },
  );

async function signIn(userAgent: string, from: string): Promise<string> {
  const res = await send(
    "/login",
    {
      method: "POST",
      body: new URLSearchParams({ token: "Test-Token-1234", next: "/" }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": userAgent },
    },
    from,
  );
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

const json = async <T>(res: Response) => (await res.json()) as T;
type Status = import("../shared/types.ts").DevicesStatus;
const devices = async (cookie: string) => json<Status>(await send("/api/devices", { headers: { cookie } }));

// --- This device ---
const first = deviceId();
check("the device id is made once and kept", first === deviceId() && /^[0-9a-f-]{36}$/.test(first), first);

let res = await send("/.well-known/tot");
const known = await json<Record<string, unknown>>(res);
check("/.well-known/tot is open and says which TOT it is", res.status === 200 && known.id === first && known.protocol === 1 && typeof known.name === "string");
check("/.well-known/tot shares nothing else", Object.keys(known).sort().join() === "id,name,protocol", Object.keys(known).join());

// --- Signing in ---
const phone = await signIn(IPHONE, "192.168.1.50");
const mac = await signIn(MAC_CHROME, "127.0.0.1");
check("signing in gives each browser its own cookie", /^tot_session=[0-9a-f-]{36}\.[\w-]{40,}$/.test(phone) && phone !== mac, phone.slice(0, 30));

let status = await devices(mac);
check("an older token's sessions are gone", !status.sessions.some((s) => s.id === "stale"));
check("both browsers are listed, newest first", status.sessions.length === 2, JSON.stringify(status.sessions.map((s) => s.label)));
check(
  "labels say which browser and where",
  status.sessions.some((s) => s.label === "Safari on iPhone") && status.sessions.some((s) => s.label === "Chrome on this Mac"),
  status.sessions.map((s) => s.label).join(", "),
);
check("the asking browser is marked current", status.sessions.filter((s) => s.current).map((s) => s.label).join() === "Chrome on this Mac");
check("sign-in is reported on, and this device is self", status.signIn && status.self.self && status.self.id === first && status.devices.length === 0);
const body = JSON.stringify(status);
check("no secret or hash leaves the server", !body.includes(phone.split(".")[1]) && !body.includes("secret") && !body.includes(mac.split(".")[1]));

res = await send("/api/sessions/current", { headers: { cookie: phone } });
const phoneId = (await json<{ id: string | null }>(res)).id;
check("/api/sessions/current names the browser", phoneId === status.sessions.find((s) => s.label === "Safari on iPhone")?.id);
res = await send("/api/sessions/current", { headers: { authorization: "Bearer Test-Token-1234" } });
check("an access-token caller has no session", (await json<{ id: string | null }>(res)).id === null);

// --- Cookies that must not work ---
res = await send("/api/agents", { headers: { cookie: `tot_session=${sessionValue("Test-Token-1234")}` } });
check("a cookie from before sessions asks you to sign in again", res.status === 401);
res = await send("/api/agents", { headers: { cookie: `tot_session=${phoneId}.not-the-secret` } });
check("a real id with a made-up secret is refused", res.status === 401);
const oldSecret = "old-but-real-secret";
db.prepare(`INSERT INTO sessions (id, secret_hash, label, created_at, last_seen_at) VALUES ('old', ?, 'Old', ?, ?)`).run(
  createHash("sha256").update(oldSecret).digest("hex"),
  Date.now() - 31 * 24 * 60 * 60 * 1000,
  Date.now(),
);
res = await send("/api/agents", { headers: { cookie: `tot_session=old.${oldSecret}` } });
check("a session older than 30 days is refused and removed", res.status === 401 && !db.prepare(`SELECT 1 FROM sessions WHERE id = 'old'`).get());

// --- Renaming ---
res = await send("/api/devices/self", { method: "PATCH", body: JSON.stringify({ name: "  Studio   Mac " }), headers: { cookie: mac, "content-type": "application/json" } });
check("renaming tidies spaces and shows everywhere", (await json<Status>(res)).self.name === "Studio Mac" && (await json<{ name: string }>(await send("/.well-known/tot"))).name === "Studio Mac");
res = await send("/api/devices/self", { method: "PATCH", body: JSON.stringify({ name: "x".repeat(41) }), headers: { cookie: mac, "content-type": "application/json" } });
check("a name that's too long is refused", res.status === 400);
res = await send("/api/devices/self", { method: "PATCH", body: JSON.stringify({ name: "" }), headers: { cookie: mac, "content-type": "application/json" } });
check("an empty name goes back to the computer's own", (await json<Status>(res)).self.name !== "Studio Mac" && deviceId() === first);

// --- Signing a browser out ---
const tablet = await signIn(IPHONE.replace("iPhone; CPU iPhone OS", "iPad; CPU OS"), "192.168.1.51");
const events = await send("/api/events", { headers: { cookie: tablet } });
const reader = events.body!.getReader();
await reader.read(); // the "ready" event
const tabletId = (await json<{ id: string }>(await send("/api/sessions/current", { headers: { cookie: tablet } }))).id;
const stillOpen = await Promise.race([reader.read().then(() => false), new Promise<true>((resolve) => setTimeout(() => resolve(true), 300))]);
check("a signed-in browser's event stream stays open", stillOpen);
const started = Date.now();
res = await send(`/api/sessions/${tabletId}`, { method: "DELETE", headers: { cookie: mac } });
check("signing a browser out lists it no more", res.status === 200 && !(await json<Status>(res)).sessions.some((s) => s.id === tabletId));
const closed = await Promise.race([reader.read().then((chunk) => chunk.done), new Promise<false>((resolve) => setTimeout(() => resolve(false), 1000))]);
check("its open event stream closes at once", closed === true, `${Date.now() - started} ms`);
res = await send("/api/agents", { headers: { cookie: tablet } });
check("its next request gets 401", res.status === 401);
res = await send("/api/agents", { headers: { cookie: mac } });
check("other browsers keep working", res.status === 200);

res = await send("/logout", { method: "POST", headers: { cookie: phone } });
check("signing out ends the session itself", res.status === 302 && (await send("/api/agents", { headers: { cookie: phone } })).status === 401);

await signIn(MAC_CHROME, "192.168.1.60");
await signIn(IPHONE, "192.168.1.61");
res = await send("/api/sessions/sign-out-others", { method: "POST", headers: { cookie: mac } });
status = await json<Status>(res);
check("sign out all others keeps only this browser", status.sessions.length === 1 && status.sessions[0].current, String(status.sessions.length));

// --- Phone install ---
const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8")) as { display: string; icons: { src: string; sizes: string }[] };
check(
  "the web app manifest opens full screen and its icons exist",
  manifest.display === "standalone" && manifest.icons.every((icon) => existsSync(`public${icon.src}`)) && manifest.icons.some((icon) => icon.sizes === "512x512"),
);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
