import { Hono } from "hono";
import type { ContinueOnRequest } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { toPublic } from "../tasks/store.ts";
import { continueOn } from "./handoff.ts";

/** Orchestration routes, mounted on /api (see the route docs in shared/types.ts). */
export const orchestrationRoutes = new Hono();

orchestrationRoutes.post("/tasks/:id/continue-on", async (c) => {
  let request: Partial<ContinueOnRequest>;
  try {
    request = await c.req.json();
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }
  if (request.provider !== "claude" && request.provider !== "chatgpt") throw new HttpError(400, 'Expected { provider: "claude" | "chatgpt" }.');
  return c.json(toPublic(await continueOn(c.req.param("id"), request.provider)));
});
