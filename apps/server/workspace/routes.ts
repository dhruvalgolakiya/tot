import { Hono, type Context, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import type { WorkspaceInfo } from "@tot/shared/workspace";
import { HttpError } from "../agent/orchestrator.ts";
import { callerKey, callerOf } from "../auth.ts";
import { onSignOut } from "../devices/sessions.ts";
import { workspaceDiff } from "./diff.ts";
import { chatSpaces } from "./root.ts";
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

export const workspaceAccess = { canWrite, canTerminal };
