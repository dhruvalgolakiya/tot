import { Hono, type Context, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import type { WorkspaceInfo, WorkspaceSave } from "@tot/shared/workspace";
import { HttpError } from "../agent/orchestrator.ts";
import { callerKey, callerOf, onThisMachine } from "../auth.ts";
import { onSignOut } from "../devices/sessions.ts";
import { workspaceDiff } from "./diff.ts";
import { workspaceFiles } from "./files.ts";
import { chatSpaces } from "./root.ts";
import { workspaceServers } from "./servers.ts";
import { terminals } from "./terminal.ts";
import { workspaceWatch } from "./watch.ts";

/** The workspace panel's routes (see packages/shared/workspace.ts), mounted on /api. */
export const workspaceRoutes = new Hono();

/** Changing files, git and terminals: not for a paired device, which works with this device's chats but not its folders. */
const canWrite = (c: Context) => callerOf(c).kind !== "device";
/** A shell: this computer, or the owner signed in from another device (never a paired device or the access token). */
const canTerminal = (c: Context) => ["local", "session"].includes(callerOf(c).kind);

const writes: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "GET" && !canWrite(c)) throw new HttpError(403, "Another device can't change this folder. Use this device itself.");
  await next();
};
workspaceRoutes.use("/conversations/:id/workspace/*", writes);

workspaceRoutes.get("/conversations/:id/workspace", (c) => {
  const id = c.req.param("id");
  let info: WorkspaceInfo;
  try {
    const space = chatSpaces.resolve(id);
    info = { available: true, reason: null, label: space.label, mode: space.mode, git: space.git, canWrite: canWrite(c), canTerminal: canTerminal(c) };
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) throw err;
    info = { available: false, reason: err instanceof Error ? err.message : String(err), label: null, mode: null, git: false, canWrite: false, canTerminal: false };
  }
  return c.json(info);
});

const HEARTBEAT_MS = 15_000;

/** "changed" whenever files in the chat's folder change; a panel refreshes what it shows. */
workspaceRoutes.get("/conversations/:id/workspace/events", (c) => {
  const space = chatSpaces.resolve(c.req.param("id"));
  return streamSSE(c, async (stream) => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    let writes: Promise<unknown> = stream.writeSSE({ data: "", event: "ready", retry: 2000 });
    const unsubscribe = workspaceWatch.subscribe(space.root, () => {
      writes = writes.then(() => stream.writeSSE({ data: JSON.stringify({ type: "changed" }) }));
    });
    const heartbeat = setInterval(() => {
      writes = writes.then(() => stream.write(": ping\n\n"));
    }, HEARTBEAT_MS);
    stream.onAbort(finish);
    const forget = onSignOut(callerKey(c), finish);
    await finished;
    forget();
    clearInterval(heartbeat);
    unsubscribe();
  });
});

workspaceRoutes.get("/conversations/:id/workspace/diff", async (c) => c.json(await workspaceDiff.list(chatSpaces.resolve(c.req.param("id")))));

workspaceRoutes.get("/conversations/:id/workspace/diff/file", async (c) =>
  c.json(await workspaceDiff.file(chatSpaces.resolve(c.req.param("id")), c.req.query("path"), c.req.query("old"))),
);

workspaceRoutes.get("/conversations/:id/workspace/files", async (c) => c.json(await workspaceFiles.list(chatSpaces.resolve(c.req.param("id")))));

workspaceRoutes.get("/conversations/:id/workspace/file", (c) => c.json(workspaceFiles.read(chatSpaces.resolve(c.req.param("id")), c.req.query("path"))));

// An image from the folder, as it is. Never run as a page (an SVG opened on its own could carry a script).
workspaceRoutes.get("/conversations/:id/workspace/raw", (c) => {
  const { body, type } = workspaceFiles.raw(chatSpaces.resolve(c.req.param("id")), c.req.query("path"));
  return c.body(new Uint8Array(body), 200, {
    "content-type": type,
    "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
});

workspaceRoutes.put("/conversations/:id/workspace/file", async (c) => {
  const input = (await c.req.json().catch(() => null)) as WorkspaceSave | null;
  return c.json(workspaceFiles.save(chatSpaces.resolve(c.req.param("id")), input!));
});

workspaceRoutes.get("/conversations/:id/workspace/search", async (c) =>
  c.json(
    await workspaceFiles.search(chatSpaces.resolve(c.req.param("id")), c.req.query("q"), {
      regex: c.req.query("regex") === "1",
      caseSensitive: c.req.query("case") === "1",
    }),
  ),
);

// Terminals: only for a caller that may have a shell here (canTerminal), whichever way it's reached.
const shells: MiddlewareHandler = async (c, next) => {
  if (!canTerminal(c)) throw new HttpError(403, "Terminals open on this computer only, or signed in as you on another device.");
  await next();
};
workspaceRoutes.use("/conversations/:id/workspace/terminals", shells);
workspaceRoutes.use("/workspace/terminals/*", shells);

workspaceRoutes.get("/conversations/:id/workspace/terminals", (c) => {
  chatSpaces.resolve(c.req.param("id"));
  return c.json(terminals.list(c.req.param("id")));
});

workspaceRoutes.post("/conversations/:id/workspace/terminals", async (c) => {
  const size = ((await c.req.json().catch(() => ({}))) ?? {}) as { cols?: unknown; rows?: unknown };
  return c.json(await terminals.open(chatSpaces.resolve(c.req.param("id")), size), 201);
});

workspaceRoutes.get("/workspace/terminals/:tid/stream", (c) => {
  const id = c.req.param("tid");
  terminals.get(id);
  return streamSSE(c, async (stream) => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    let writes: Promise<unknown> = stream.writeSSE({ data: "", event: "ready", retry: 2000 });
    const unsubscribe = terminals.subscribe(id, (event) => {
      writes = writes.then(() => stream.writeSSE({ data: JSON.stringify(event) }));
      if (event.type === "exit") void writes.then(finish);
    });
    const heartbeat = setInterval(() => {
      writes = writes.then(() => stream.write(": ping\n\n"));
    }, HEARTBEAT_MS);
    stream.onAbort(finish);
    const forget = onSignOut(callerKey(c), finish);
    await finished;
    forget();
    clearInterval(heartbeat);
    unsubscribe();
    await writes.catch(() => {});
  });
});

workspaceRoutes.post("/workspace/terminals/:tid/input", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { data?: unknown } | null;
  terminals.write(c.req.param("tid"), body?.data);
  return c.json({ ok: true });
});

workspaceRoutes.post("/workspace/terminals/:tid/resize", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { cols?: unknown; rows?: unknown } | null;
  terminals.resize(c.req.param("tid"), body?.cols, body?.rows);
  return c.json({ ok: true });
});

workspaceRoutes.delete("/workspace/terminals/:tid", (c) => {
  terminals.close(c.req.param("tid"));
  return c.json({ ok: true });
});

// The Browser tab shows dev servers on this Mac's localhost, which only this Mac can open.
workspaceRoutes.get("/conversations/:id/workspace/servers", async (c) => {
  if (!onThisMachine(c)) throw new HttpError(403, "Dev servers in this folder can be previewed on this Mac only.");
  return c.json(await workspaceServers.list(chatSpaces.resolve(c.req.param("id"))));
});

export const workspaceAccess = { canWrite, canTerminal };
