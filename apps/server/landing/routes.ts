import { Hono, type Context } from "hono";
import type { LandTaskRequest } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { taskStore, toPublic } from "../tasks/store.ts";
import { taskChecks } from "./checks.ts";
import { landing } from "./land.ts";

/** Module 09 (docs/roadmap/09-mission-control.md). Lane A · land a finished task: checks, merge into your folder, draft PR, update from base, discard. */
export const landingRoutes = new Hono();

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }
}

landingRoutes.get("/tasks/:id/land", async (c) => c.json(await landing.options(c.req.param("id"))));

landingRoutes.post("/tasks/:id/land", async (c) => {
  const request = (await body<Partial<LandTaskRequest> | null>(c)) ?? {};
  return c.json(toPublic(await landing.land(c.req.param("id"), request)));
});

landingRoutes.post("/tasks/:id/update-from-base", async (c) => c.json(toPublic(await landing.updateFromBase(c.req.param("id")))));

landingRoutes.post("/tasks/:id/discard", async (c) => c.json(toPublic(await landing.discard(c.req.param("id")))));

landingRoutes.post("/tasks/:id/checks", (c) => {
  const task = taskStore.require(c.req.param("id"));
  if (!task.task.repo) throw new HttpError(400, "This task has no code to check.");
  if (!task.task.repo.headSha) throw new HttpError(409, "The task's branch isn't set up yet.");
  return c.json(toPublic(taskChecks.start(task.id)));
});
