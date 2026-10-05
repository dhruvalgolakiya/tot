import { Hono } from "hono";
import type { BestOfRequest } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { toPublic } from "../tasks/store.ts";
import { startBestOf } from "./best-of.ts";
import { missionOverview } from "./overview.ts";

/** Module 09 (docs/roadmap/09-mission-control.md). Lane B · the mission control overview and best-of runs. */
export const missionRoutes = new Hono();

missionRoutes.get("/mission", (c) =>
  c.json(
    missionOverview({
      projectId: c.req.query("projectId") || null,
      agentId: c.req.query("agentId") || null,
      group: c.req.query("group") || null,
    }),
  ),
);

missionRoutes.post("/tasks/best-of", async (c) => {
  let request: BestOfRequest;
  try {
    request = (await c.req.json()) as BestOfRequest;
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }
  // The same requestId again (a double click) gets the runs it started back.
  const { tasks, repeat } = await startBestOf(request);
  if (!tasks.length) throw new HttpError(409, "That request already started a best-of run, which has since been deleted.");
  return c.json(tasks.map(toPublic), repeat ? 200 : 201);
});
