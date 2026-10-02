// Remote-access sign-in, exercised in-process against the real app.
// Run: TOT_DATA_DIR=/tmp/tot-auth-test npx tsx server/auth.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { sessionValue } from "./session.ts";

process.env.TOT_ACCESS_TOKEN = "Test-Token-1234";
const { createApp } = await import("./app.ts");
const app = createApp();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.slice(0, 120)}` : ""}`);
}
// `from` fakes the connection's remote address (what @hono/node-server's getConnInfo reads).
const send = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}, from?: string) =>
  app.request(
    `http://127.0.0.1:8787${path}`,
    { ...init, headers: { host: "127.0.0.1:8787", ...init.headers } },
    from ? { incoming: { socket: { remoteAddress: from, remotePort: 50000, remoteFamily: "IPv4" } } } : undefined,
  );
const cookie = { cookie: `tot_session=${sessionValue("Test-Token-1234")}` };
const form = (body: Record<string, string>) => ({
  method: "POST",
  body: new URLSearchParams(body).toString(),
  headers: { "content-type": "application/x-www-form-urlencoded" },
});

let res = await send("/api/health");
check("API needs sign-in", res.status === 401);
res = await send("/some/page");
check("pages redirect to /login", res.status === 302 && (res.headers.get("location") ?? "").startsWith("/login?next="), res.headers.get("location") ?? "");
res = await send("/api/health", { headers: { authorization: "Bearer Test-Token-1234" } });
check("bearer token works", res.status === 200);
res = await send("/login", form({ token: "wrong-token-value", next: "/" }));
check("wrong token on login page", res.status === 401);
res = await send("/login", form({ token: " testtoken1234 ", next: "/a/x" }));
const setCookie = res.headers.get("set-cookie") ?? "";
check("token ignores case, dashes and spaces", res.status === 302 && res.headers.get("location") === "/a/x", String(res.status));
check("cookie is HttpOnly + SameSite=Strict and holds no token", setCookie.includes("HttpOnly") && setCookie.includes("SameSite=Strict") && !/test-?token/i.test(setCookie), setCookie);
res = await send("/login", form({ token: "Test-Token-1234", next: "//evil.example" }));
check("no open redirect", res.headers.get("location") === "/");
res = await send("/api/agents", { headers: { ...cookie, host: "192.168.1.21:5173" } });
check("cookie works through a LAN / tunnel hostname", res.status === 200);
res = await send("/api/memories", { method: "POST", body: "{}", headers: { ...cookie, host: "192.168.1.21:5173", origin: "https://evil.example", "content-type": "application/json" } });
check("cross-site request blocked", res.status === 403);
res = await send("/api/memories", { method: "POST", body: JSON.stringify({ content: "lan test" }), headers: { ...cookie, host: "192.168.1.21:5173", origin: "http://192.168.1.21:5173", "content-type": "application/json" } });
check("same-origin request from the LAN address works", res.status === 201);

res = await send("/mcp/nope", { method: "POST" });
check("MCP refuses connections it can't place", res.status === 403);
res = await send("/mcp/nope", { method: "POST" }, "192.168.1.50");
check("MCP refuses other devices", res.status === 403);
res = await send("/mcp/nope", { method: "POST" }, "127.0.0.1");
check("MCP still needs its own token from this machine", res.status === 401 && (await res.text()).includes("Unauthorized"));

// Wrong guesses are rate-limited globally, through both the login form and bearer headers.
let last = 0;
for (let i = 0; i < 25; i++) last = (await send("/api/health", { headers: { authorization: `Bearer guess-${i}-xxxxxxxx` } })).status;
check("bearer guessing gets locked out", last === 429, String(last));
res = await send("/login", form({ token: "Test-Token-1234", next: "/" }));
check("login is locked out too, even with the right token", res.status === 429);
res = await send("/api/health", { headers: cookie });
check("an existing session keeps working during a lockout", res.status === 200);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
