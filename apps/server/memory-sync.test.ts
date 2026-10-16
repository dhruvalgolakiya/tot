// Memory repo M3 (roadmap module 10): the "you" repo syncs between paired devices. Two real TOTs: "MacBook" in
// this process, "Mac mini" as a child process with its own data dir and port, paired through the API. Each adds an
// entry and both converge; the same line edited on both keeps both versions, each editable on its own; an entry
// forgotten on one while the other adds one stays forgotten; a sync can't be undone; only a paired device may
// fetch the sync bundle, never through the device proxy; and a paired device can't use the other's memory routes.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx apps/server/memory-sync.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import type { Memory, MemoryRepoSummary } from "@tot/shared/types";

const MINI_PORT = 20_000 + Math.floor(Math.random() * 1000) * 2;
const BOOK_PORT = MINI_PORT + 1;
const MINI_TOKEN = "Mini-Token-12345";
const BOOK_TOKEN = "Book-Token-12345";
const MINI = `http://127.0.0.1:${MINI_PORT}`;
const BOOK = `http://127.0.0.1:${BOOK_PORT}`;

process.env.TOT_ACCESS_TOKEN = BOOK_TOKEN;
process.env.TOT_PUBLIC_URL = BOOK;

const { getSecret } = await import("./config.ts");
const { createApp } = await import("./app.ts");
const { deviceId } = await import("./devices/identity.ts");
const { relay } = await import("./devices/relay.ts");
const { memorySync } = await import("./memory/sync.ts");
const { proxyRefuses } = await import("./devices/proxy.ts");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 240)}` : ""}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test: () => Promise<boolean> | boolean, ms = 30_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await test()) return true;
  return false;
}

// --- The two devices -----------------------------------------------------------------------------------------------
const book: ServerType = serve({ fetch: createApp().fetch, port: BOOK_PORT, hostname: "127.0.0.1" });
const miniData = mkdtempSync(join(tmpdir(), "tot-mini-memory-"));
const miniLog = join(miniData, "server.log");
let mini: ChildProcess | null = null;
{
  const env: NodeJS.ProcessEnv = { ...process.env, TOT_DATA_DIR: miniData, TOT_PORT: String(MINI_PORT), TOT_EXECUTOR_PORT: String(MINI_PORT + 3000), TOT_ACCESS_TOKEN: MINI_TOKEN, TOT_PUBLIC_URL: MINI };
  for (const name of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "ELECTRON_RUN_AS_NODE", "TOT_LAN", "TOT_HOST"]) delete env[name];
  const log = openSync(miniLog, "a");
  mini = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "index.ts")], { env, stdio: ["ignore", log, log] });
}
process.on("exit", () => mini?.kill("SIGKILL"));

const call = async (base: string, headers: Record<string, string>, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  const text = buffer.toString("utf8");
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, text, buffer };
};
const onMini = (method: string, path: string, body?: unknown) => call(MINI, { authorization: `Bearer ${MINI_TOKEN}` }, method, path, body);
const onBook = (method: string, path: string, body?: unknown) => call(BOOK, { authorization: `Bearer ${BOOK_TOKEN}` }, method, path, body);
const contents = async (on: typeof onMini) => ((await on("GET", "/api/memories")).data as Memory[]).map((m) => m.content);
const memoryFile = async (on: typeof onMini) => (await on("GET", "/api/memory/you/file?path=MEMORY.md")).data?.content ?? "";
const youHead = async (on: typeof onMini) => ((await on("GET", "/api/memory/repos")).data as MemoryRepoSummary[])[0]?.lastCommit?.sha;

try {
  const miniUp = await until(async () => (await fetch(`${MINI}/.well-known/tot`).catch(() => null))?.ok ?? false);
  check("the Mac mini starts as its own TOT", miniUp, miniUp ? "" : readFileSync(miniLog, "utf8").slice(-600));
  if (!miniUp) throw new Error("no Mac mini");
  const miniId = ((await (await fetch(`${MINI}/.well-known/tot`)).json()) as { id: string }).id;
  const bookId = deviceId();

  // --- Pair them (module 07), and start syncing here (the Mac mini started its own at boot) ----------------------
  const link: string = (await onMini("POST", "/api/devices/pairing-link")).data?.link ?? "";
  const paired = await onBook("POST", "/api/devices/connect", { link });
  check("the two devices pair", paired.status === 200 && paired.data.deviceId === miniId, paired.text.slice(0, 200));
  memorySync.start();
  const online = await until(() => relay.online(miniId));
  check("…and see each other online", online);

  // --- Each adds an entry; both converge --------------------------------------------------------------------------
  console.log("\n# Each device adds an entry");
  const [a, b] = await Promise.all([onBook("POST", "/api/memories", { content: "Lives in Berlin" }), onMini("POST", "/api/memories", { content: "Prefers green tea" })]);
  check("an entry on each", a.status === 201 && b.status === 201, `${a.text} ${b.text}`);
  const converged = await until(async () => {
    const [here, there] = await Promise.all([contents(onBook), contents(onMini)]);
    return [here, there].every((list) => list.includes("Lives in Berlin") && list.includes("Prefers green tea"));
  });
  check("both devices end up with both entries", converged, JSON.stringify([await contents(onBook), await contents(onMini)]));
  const sameHead = await until(async () => (await youHead(onBook)) === (await youHead(onMini)));
  check("…at the same commit (one merge, then a fast-forward)", sameHead);
  const history = (await onBook("GET", "/api/memory/you/history?limit=10")).data as { kind: string; subject: string }[];
  check(
    "one device merged, the other fast-forwarded: one sync merge in the history",
    history.filter((commit) => commit.kind === "sync").length === 1 && /^Sync: synced with /.test(history.find((c) => c.kind === "sync")?.subject ?? ""),
    JSON.stringify(history.map((c) => c.subject)),
  );
  const syncMerge = (history as unknown as { sha: string; kind: string; revertible: boolean }[]).find((c) => c.kind === "sync")!;
  const undoSync = await onBook("POST", "/api/memory/you/revert", { sha: syncMerge.sha });
  check("a sync isn't offered for undo, and undoing it is refused (400)", syncMerge.revertible === false && undoSync.status === 400, undoSync.text);
  const status = ((await onBook("GET", "/api/memory/repos")).data as MemoryRepoSummary[])[0]!.sync!;
  check("each paired device shows its last sync", status.peers[0]?.deviceId === miniId && status.peers[0]?.ok === true && Boolean(status.peers[0]?.lastSyncAt), JSON.stringify(status.peers));

  // --- The same line edited on both -----------------------------------------------------------------------------
  console.log("\n# The same line edited on both devices");
  const berlin = ((await onBook("GET", "/api/memories")).data as Memory[]).find((m) => m.content === "Lives in Berlin")!;
  const edits = await Promise.all([
    onBook("PATCH", `/api/memories/${berlin.id}`, { content: "Lives in Berlin, Germany" }),
    onMini("PATCH", `/api/memories/${berlin.id}`, { content: "Lives in Berlin (Kreuzberg)" }),
  ]);
  check("both edits land locally", edits.every((edit) => edit.status === 200), edits.map((e) => e.text).join(" "));
  const keptBoth = await until(async () => {
    const [here, there] = await Promise.all([memoryFile(onBook), memoryFile(onMini)]);
    return [here, there].every((text) => text.includes("Lives in Berlin, Germany") && text.includes("Lives in Berlin (Kreuzberg)"));
  });
  check("both versions are kept on both devices (edited on both: both kept)", keptBoth, await memoryFile(onBook));
  const twins = ((await onBook("GET", "/api/memories")).data as Memory[]).filter((m) => m.id === berlin.id || m.id === `${berlin.id}.2`);
  check("the same id twice: the index keeps both, the second as <id>.2", twins.length === 2, JSON.stringify(twins.map((m) => [m.id, m.content])));
  const dropTwin = await onBook("DELETE", `/api/memories/${berlin.id}.2`);
  const leftTwins = ((await onBook("GET", "/api/memories")).data as Memory[]).filter((m) => m.id === berlin.id || m.id === `${berlin.id}.2`);
  check("…and either can be forgotten on its own", dropTwin.status === 200 && leftTwins.length === 1 && leftTwins[0]!.id === berlin.id, dropTwin.text);

  // --- Forgotten on one device while the other adds ------------------------------------------------------------
  console.log("\n# Forgotten on one device while the other adds");
  const tea = ((await onBook("GET", "/api/memories")).data as Memory[]).find((m) => m.content === "Prefers green tea")!;
  const [gone, added] = await Promise.all([onBook("DELETE", `/api/memories/${tea.id}`), onMini("POST", "/api/memories", { content: "Reads sci-fi" })]);
  check("both land locally", gone.status === 200 && added.status === 201, `${gone.text} ${added.text}`);
  const settled = await until(async () => {
    const [here, there] = await Promise.all([contents(onBook), contents(onMini)]);
    return [here, there].every((list) => list.includes("Reads sci-fi") && !list.includes("Prefers green tea"));
  });
  check("the forgotten entry stays forgotten on both, the new one reaches both", settled, JSON.stringify([await contents(onBook), await contents(onMini)]));

  // --- Who may fetch the bundle ---------------------------------------------------------------------------------
  console.log("\n# Only paired devices fetch the bundle");
  const bookToMini = getSecret(`deviceToken:${miniId}`)!;
  const asDevice = await call(MINI, { authorization: `Bearer ${bookToMini}` }, "GET", "/api/memory/sync/you.bundle");
  check("a paired device gets a git bundle", asDevice.status === 200 && asDevice.buffer.subarray(0, 16).toString().startsWith("# v") && asDevice.buffer.toString("latin1").includes("git bundle"), String(asDevice.status));
  check("a script with the access token gets 403", (await onMini("GET", "/api/memory/sync/you.bundle")).status === 403);
  const proxied = await onBook("GET", `/api/d/${miniId}/memory/sync/you.bundle`);
  const encoded = await onBook("GET", `/api/d/${miniId}/memory/%73ync/you.bundle`);
  check(
    "…and none through the device proxy (it would carry this device's token)",
    proxied.status === 403 && encoded.status === 403 && !proxied.buffer.toString("latin1").includes("git bundle") && proxyRefuses("/Memory/Sync/you.bundle") && !proxyRefuses("/memories"),
    `${proxied.status} ${encoded.status}`,
  );
  const login = await fetch(`${MINI}/login`, {
    method: "POST",
    body: new URLSearchParams({ password: MINI_TOKEN, next: "/" }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  check("a signed-in browser can use the API", (await call(MINI, { cookie }, "GET", "/api/memories")).status === 200, String(login.status));
  check("…but gets 403 on the bundle", (await call(MINI, { cookie }, "GET", "/api/memory/sync/you.bundle")).status === 403);
  check("a paired device can't use the other's memory routes", (await call(MINI, { authorization: `Bearer ${bookToMini}` }, "GET", "/api/memories")).status === 403);
  check("…or its repos", (await call(MINI, { authorization: `Bearer ${bookToMini}` }, "GET", "/api/memory/repos")).status === 403);
  check("…or change its memory", (await call(MINI, { authorization: `Bearer ${bookToMini}` }, "POST", "/api/memories", { content: "x y z" })).status === 403);
  const bodies = [(await onBook("GET", "/api/memory/repos")).text, (await onMini("GET", "/api/memory/repos")).text];
  check("no device token in any memory response", bodies.every((text) => !text.includes("totd_")));
  check("this device's id is known to the other", ((await onMini("GET", "/api/memory/repos")).data as MemoryRepoSummary[])[0]!.sync!.peers.some((p) => p.deviceId === bookId));
} finally {
  memorySync.stop();
  relay.stopAll();
  if (mini) {
    const child = mini;
    mini = null;
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await new Promise<void>((resolve) => {
    book.close(() => resolve());
    (book as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  });
  rmSync(miniData, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
