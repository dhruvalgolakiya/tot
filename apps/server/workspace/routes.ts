import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { WorkspaceInfo } from "@tot/shared/workspace";
import { HttpError } from "../agent/orchestrator.ts";
import { callerOf } from "../auth.ts";
import { chatSpaces } from "./root.ts";

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

export const workspaceAccess = { canWrite, canTerminal };
