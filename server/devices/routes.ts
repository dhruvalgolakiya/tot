import { Hono, type Context } from "hono";
import type { DevicesStatus, RenameDeviceRequest } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { ACCESS_TOKEN, currentSessionId } from "../auth.ts";
import { deviceId, deviceName, renameDevice, selfDevice } from "./identity.ts";
import { endOtherSessions, endSession, listSessions } from "./sessions.ts";

/** This device and the browsers signed in to it (roadmap module 07). Mounted under /api. */
export const deviceRoutes = new Hono();

function status(c: Context): DevicesStatus {
  return {
    self: selfDevice(),
    devices: [],
    signIn: Boolean(ACCESS_TOKEN),
    sessions: ACCESS_TOKEN ? listSessions(currentSessionId(c)) : [],
  };
}

deviceRoutes.get("/devices", (c) => c.json(status(c)));

deviceRoutes.patch("/devices/self", async (c) => {
  const input = (await c.req.json().catch(() => null)) as RenameDeviceRequest | null;
  if (typeof input?.name !== "string") throw new HttpError(400, "Expected { name }.");
  try {
    renameDevice(input.name);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  return c.json(status(c));
});

deviceRoutes.get("/sessions/current", (c) => c.json({ id: currentSessionId(c) }));

deviceRoutes.delete("/sessions/:id", (c) => {
  endSession(c.req.param("id"));
  return c.json(status(c));
});

deviceRoutes.post("/sessions/sign-out-others", (c) => {
  endOtherSessions(currentSessionId(c));
  return c.json(status(c));
});

/** Open, without sign-in: tells another device it reached TOT, and which one. Nothing private. */
export const wellKnownRoutes = new Hono();

wellKnownRoutes.get("/.well-known/tot", (c) => c.json({ id: deviceId(), name: deviceName(), protocol: 1 }));
