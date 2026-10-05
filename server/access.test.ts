// Remote access (roadmap module 07): this computer never signs in; other devices need the password set in the
// app (or a one-time code from a QR code); remote access is a switch that opens and closes listeners.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/access.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";

process.env.TOT_ACCESS_TOKEN = "";
process.env.TOT_LAN = "";
process.env.TOT_HOST = "";
process.env.TOT_PUBLIC_URL = "";

// A stand-in for the Vite dev server, which other devices reach through dev-web.ts.
const seenByVite: { host?: string; cookie?: string; xff?: string; url?: string }[] = [];
const vite = createServer((req, res) => {
  seenByVite.push({ host: req.headers.host, cookie: req.headers.cookie, xff: req.headers["x-forwarded-for"] as string | undefined, url: req.url });
  res.writeHead(200, { "content-type": "text/html", "set-cookie": "vite=1" }).end("<!doctype html><title>TOT</title>");
});
await new Promise<void>((resolve) => vite.listen(0, "127.0.0.1", resolve));
process.env.TOT_WEB_PORT = String((vite.address() as AddressInfo).port);

const { createApp } = await import("./app.ts");
const { paths } = await import("./config.ts");
const { listeners, wantedAddresses } = await import("./listeners.ts");
const { peers } = await import("./devices/peers.ts");
type Status = import("../shared/types.ts").DevicesStatus;
const app = createApp();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
}

const HERE = "127.0.0.1";
const PHONE = "192.168.1.50";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** `from` fakes the connection's address; without it there's no socket at all. */
const send = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}, from?: string) =>
  app.request(
    `http://127.0.0.1:8787${path}`,
    { ...init, headers: { host: "127.0.0.1:8787", ...init.headers } },
    from ? { incoming: { socket: { remoteAddress: from, remotePort: 50000, remoteFamily: "IPv4" } } } : undefined,
  );
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});
const form = (body: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: "POST",
  body: new URLSearchParams(body).toString(),
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
});
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const status = async (from = HERE, headers: Record<string, string> = {}) => (await (await send("/api/devices", { headers }, from)).json()) as Status;

// --- Before sign-in is set up: only this computer ---------------------------------------------------
console.log("# Before setup");
let res = await send("/api/agents", {}, HERE);
check("this computer uses TOT without signing in", res.status === 200);
res = await send("/api/agents", { headers: { host: "192.168.1.21:5173" } }, PHONE);
check("nothing else gets in: a LAN Host is refused", res.status === 403);
res = await send("/api/devices/pairing-link", json({}), HERE);
check("pairing needs sign-in set up here", res.status === 400 && /Set up remote access/.test(((await res.json()) as { error: string }).error));
res = await send("/api/devices/connect", json({ link: "http://192.0.2.1:5173/pair#AAAA-BBBB-CCCC" }), HERE);
check("…on the side pasting the link too (before any network call)", res.status === 400 && /Set up remote access/.test(((await res.json()) as { error: string }).error));
res = await send("/api/pair", json({ protocol: 1, code: "x" }), PHONE);
check("…and on the side accepting it", res.status === 403);
res = await send("/api/access", { ...json({ mode: "lan" }), method: "PATCH" }, HERE);
check("remote access can't turn on without a password", res.status === 400 && /password/i.test(((await res.json()) as { error: string }).error));
let st = await status();
check("status: off, no password, this computer", st.access.mode === "off" && !st.access.passwordSet && st.access.onThisMachine && !st.signIn);

// --- The password ------------------------------------------------------------------------------------
console.log("\n# The password");
res = await send("/api/access/password", json({ password: "short" }), HERE);
check("a short password is refused", res.status === 400);
res = await send("/api/access/password", json({ password: "correct horse battery" }), HERE);
check("this computer sets the password", res.status === 200 && ((await res.json()) as Status).access.passwordSet);
const secrets = readFileSync(paths.secrets, "utf8");
check("only a scrypt hash is stored", secrets.includes('"signInPassword": "scrypt$15$8$1$') && !secrets.includes("correct horse"));

res = await send("/api/agents", {}, HERE);
check("this computer still never signs in", res.status === 200);
res = await send("/api/agents", {}, PHONE);
check("another device must sign in", res.status === 401);
res = await send("/a/x", { headers: { accept: "text/html" } }, PHONE);
check("…and its page loads go to the sign-in page", res.status === 302 && (res.headers.get("location") ?? "").startsWith("/login?next="));
res = await send("/api/agents", { headers: { "x-forwarded-for": "127.0.0.1" } }, PHONE);
check("another device can't claim to be this computer", res.status === 401);
res = await send("/api/agents", { headers: { "x-forwarded-for": PHONE } }, HERE);
check("a proxy on this computer forwarding another device isn't this computer", res.status === 401);
res = await send("/api/agents", { headers: { host: "evil.example" } }, HERE);
check("a page rebinding DNS to this computer isn't this computer", res.status === 401);
res = await send("/api/agents", {});
check("an unknown connection counts as another device", res.status === 401);

// --- Signing in ----------------------------------------------------------------------------------------
console.log("\n# Signing in");
res = await send("/login", form({ password: "wrong horse battery", next: "/" }), PHONE);
const page = await res.text();
check("a wrong password is refused, on a clean page", res.status === 401 && page.includes("That password didn"));
// Opening a phone's link while this page is already showing only changes the #fragment: no reload.
check("…which still signs in from a phone's link opened over it", page.includes('addEventListener("hashchange", useCode)'));
res = await send("/login", form({ password: "correct horse battery", next: "/a/x" }), PHONE);
const phone = cookieOf(res);
check("the password signs a device in", res.status === 302 && res.headers.get("location") === "/a/x" && phone.startsWith("tot_session="));
res = await send("/login", form({ token: "correct horse battery", next: "/" }), "192.168.1.51");
const laptop = cookieOf(res);
check("the old field name still works", res.status === 302 && laptop.startsWith("tot_session="));
check("signed in, it gets in", (await send("/api/agents", { headers: { cookie: phone } }, PHONE)).status === 200);
st = await status(PHONE, { cookie: phone });
check("a signed-in device isn't this computer", !st.access.onThisMachine && st.sessions.length === 2);

// --- Changing the password --------------------------------------------------------------------------------
console.log("\n# Changing the password");
res = await send("/api/access/password", json({ password: "a brand new one" }, { cookie: phone }), PHONE);
check("from another device, the current password is needed", res.status === 403);
res = await send("/api/access/password", json({ password: "a brand new one", current: "not it at all" }, { cookie: phone }), PHONE);
check("…and must be right (403, never 401)", res.status === 403);
res = await send("/api/access/password", json({ password: "a brand new one", current: "correct horse battery" }, { cookie: phone }), PHONE);
check("with it, the password changes", res.status === 200);
check("every other device is signed out", (await send("/api/agents", { headers: { cookie: laptop } }, "192.168.1.51")).status === 401);
check("the device that changed it stays in", (await send("/api/agents", { headers: { cookie: phone } }, PHONE)).status === 200);
res = await send("/api/access/password", json({ password: "forgot the last one" }), HERE);
check("this computer resets a forgotten password without the old one", res.status === 200);
check("…which signs the phone out", (await send("/api/agents", { headers: { cookie: phone } }, PHONE)).status === 401);

// --- Paired devices can't touch remote access ------------------------------------------------------------
peers.save({ id: "11111111-2222-3333-4444-555555555555", name: "MacBook", address: "" }, { inbound: `totd_${"a".repeat(43)}`, outbound: `totd_${"b".repeat(43)}` });
const asDevice = { authorization: `Bearer totd_${"a".repeat(43)}` };
check("a paired device can't switch remote access", (await send("/api/access", { ...json({ mode: "off" }, asDevice), method: "PATCH" }, PHONE)).status === 403);
check("…or change the password", (await send("/api/access/password", json({ password: "taken over!!" }, asDevice), PHONE)).status === 403);

// --- The switch and the listeners ------------------------------------------------------------------------
console.log("\n# Remote access on and off");
const iface = (address: string, extra: Partial<NetworkInterfaceInfo> = {}) => ({ address, family: "IPv4", internal: false, ...extra }) as NetworkInterfaceInfo;
const ifaces = {
  en0: [iface("192.168.1.21"), { address: "fe80::1", family: "IPv6", internal: false } as NetworkInterfaceInfo],
  en5: [iface("10.0.0.7")],
  utun4: [iface("100.101.4.2")],
  bridge: [iface("169.254.3.3")],
  wan: [iface("203.0.113.9")],
  lo0: [iface("127.0.0.1", { internal: true })],
};
check("Tailscale mode: only the Tailscale address", wantedAddresses("tailscale", true, ifaces).join() === "100.101.4.2");
check("Wi-Fi mode: the private network addresses, never public, link-local, IPv6 or Tailscale", wantedAddresses("lan", true, ifaces).join() === "192.168.1.21,10.0.0.7");
check("legacy TOT_LAN also serves Tailscale, as it did", wantedAddresses("lan", true, ifaces, true).join() === "192.168.1.21,10.0.0.7,100.101.4.2");
check("nothing while off or without a password", !wantedAddresses("off", true, ifaces).length && !wantedAddresses("lan", false, ifaces).length);

const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = (probe.address() as AddressInfo).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
await listeners.start(app, { port, wanted: (mode, ready) => (ready && mode !== "off" ? ["127.0.0.1"] : []) });
check("off: no listener", listeners.bound().length === 0);
res = await send("/api/access", { ...json({ mode: "lan" }), method: "PATCH" }, HERE);
st = (await res.json()) as Status;
check("turning it on opens a listener", res.status === 200 && st.access.mode === "lan" && listeners.bound().length === 1, JSON.stringify(st.access));
const live = await fetch(`http://127.0.0.1:${port}/.well-known/tot`).catch(() => null);
check("…that answers", live?.ok === true);
check("…and is offered as the address", st.access.addresses.some((a) => a.url.endsWith(`:${process.env.TOT_WEB_PORT}`)));

res = await send("/api/access/sign-in-link", json({}), HERE);
const link = (await res.json()) as { url: string; expiresAt: number };
check("a phone's one-time sign-in link", res.status === 200 && /\/login#code=[\w-]{20,}$/.test(link.url), link.url);
const code = link.url.split("#code=")[1];
res = await send("/login", form({ code, next: "/" }, { "user-agent": IPHONE }), PHONE);
const scanned = cookieOf(res);
check("scanning it signs the phone in, no typing", res.status === 302 && scanned.startsWith("tot_session="));
st = await status(PHONE, { cookie: scanned });
check("…as Safari on iPhone", st.sessions.some((s) => s.current && s.label === "Safari on iPhone"));
res = await send("/login", form({ code, next: "/" }), PHONE);
check("the link works once", res.status === 401 && (await res.text()).includes("expired or was already used"));
const first = ((await (await send("/api/access/sign-in-link", json({}), HERE)).json()) as { url: string }).url.split("#code=")[1];
await send("/api/access/sign-in-link", json({}), HERE);
check("a new link replaces the last", (await send("/login", form({ code: first }), PHONE)).status === 401);

// --- Pages for other devices in development (dev-web.ts) --------------------------------------------------
res = await send("/a/x", { headers: { cookie: scanned, "x-forwarded-for": "198.51.100.7", accept: "text/html" } }, PHONE);
const seen = seenByVite.at(-1);
check("a signed-in phone gets the app's pages from the dev server", res.status === 200 && (await res.text()).includes("<title>TOT</title>") && seen?.url === "/a/x");
check("…which sees this computer asking (no cookie, no forwarded address, a localhost Host)", !seen?.cookie && !seen?.xff && seen?.host === `localhost:${process.env.TOT_WEB_PORT}`);
check("…and can't set cookies through it", !res.headers.get("set-cookie"));
check("only reading goes through", (await send("/a/x", { method: "POST", headers: { cookie: scanned } }, PHONE)).status !== 200);

// --- Turning it off ----------------------------------------------------------------------------------------
res = await send("/api/access", { ...json({ mode: "off" }, { cookie: scanned }), method: "PATCH" }, PHONE);
check("turning it off answers first, even from the phone", res.status === 200);
await new Promise((resolve) => setTimeout(resolve, 600));
check("…then closes the listener", listeners.bound().length === 0 && (await fetch(`http://127.0.0.1:${port}/.well-known/tot`).catch(() => null)) === null);
check("…and sign-in links stop", (await send("/api/access/sign-in-link", json({}), HERE)).status === 400);

// --- Guessing ------------------------------------------------------------------------------------------------
console.log("\n# Guessing");
await send("/api/access", { ...json({ mode: "lan" }), method: "PATCH" }, HERE);
const spare = ((await (await send("/api/access/sign-in-link", json({}), HERE)).json()) as { url: string }).url.split("#code=")[1];
let last = 0;
for (let i = 0; i < 25; i++) last = (await send("/login", form({ password: `guess number ${i}` }), PHONE)).status;
check("guessing passwords gets locked out", last === 429, String(last));
check("…even with the right one", (await send("/login", form({ password: "forgot the last one" }), PHONE)).status === 429);
check("a phone's sign-in link still works during a lockout", (await send("/login", form({ code: spare }), PHONE)).status === 302);
check("…and this computer is never locked out", (await send("/api/agents", {}, HERE)).status === 200);

await listeners.stop();
vite.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
