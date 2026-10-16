// The local-only guard (no access token): only this machine may use the API, and no website can drive it.
// Run: TOT_DATA_DIR=/tmp/tot-guard-test npx tsx apps/server/guard.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot

export {};

// Empty values win over .env, so this runs in local-only mode whatever .env says.
process.env.TOT_ACCESS_TOKEN = "";
process.env.TOT_LAN = "";
const { createApp } = await import("./app.ts");
const app = createApp();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const send = (host: string, init: RequestInit & { headers?: Record<string, string> } = {}, path = "/api/health") =>
  app.request(`http://${host}${path}`, { ...init, headers: { host, ...init.headers } });
const post = (host: string, origin: string) =>
  send(
    host,
    { method: "POST", body: JSON.stringify({ content: "guard test" }), headers: { origin, "content-type": "application/json" } },
    "/api/memories",
  );

for (const host of ["127.0.0.1:8787", "localhost:5173", "localhost:5174", "[::1]:5173"]) {
  check(`loopback host ${host} allowed`, (await send(host)).status === 200);
}
check("LAN host refused without a token", (await send("192.168.1.21:5173")).status === 403);
check("DNS-rebinding host refused", (await send("evil.example:5173")).status === 403);

let res = await post("localhost:5174", "http://localhost:5174");
check("same-origin write from the dev server works", res.status === 201);
const created = (await res.json()) as { id: string };
res = await post("localhost:5173", "http://localhost:3000");
check("another localhost site can't write", res.status === 403);
res = await post("localhost:5173", "https://evil.example");
check("a remote website can't write", res.status === 403);
res = await send("localhost:5173", { method: "DELETE", headers: { origin: "http://localhost:5173" } }, `/api/memories/${created.id}`);
check("cleanup", res.status === 200);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
