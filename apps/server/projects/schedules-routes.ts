import { Hono, type Context } from "hono";
import type { Routine, RoutineInput } from "@tot/shared/types";
import { HttpError } from "../agent/orchestrator.ts";
import { routines, validateRoutine } from "../data/routines.ts";
import { projects } from "./projects.ts";
import { projectSchedules } from "./schedules.ts";

/** Module 12 (docs/roadmap/12-coordinator.md), lane B: a project's schedules, which run in its Lead. Route docs: packages/shared/types.ts. */
export const projectScheduleRoutes = new Hono();

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }
}

function project(c: Context) {
  const found = projects.get(c.req.param("id"));
  if (!found) throw new HttpError(404, "Project not found.");
  return found;
}

/** One of the project's schedules, else 404 (another project's or an agent's routine isn't found here). */
function schedule(c: Context): Routine {
  const projectId = project(c).id;
  const routine = routines.get(c.req.param("routineId") ?? "");
  if (!routine || routine.projectId !== projectId) throw new HttpError(404, "Schedule not found.");
  return routine;
}

projectScheduleRoutes.get("/projects/:id/schedules", (c) => c.json(routines.forProject(project(c).id)));

projectScheduleRoutes.post("/projects/:id/schedules", async (c) => {
  const id = project(c).id;
  const input = await body<RoutineInput>(c);
  const problem = validateRoutine(input ?? {}, true);
  if (problem) throw new HttpError(400, problem);
  return c.json(projectSchedules.create(id, input), 201);
});

projectScheduleRoutes.patch("/projects/:id/schedules/:routineId", async (c) => {
  const routine = schedule(c);
  const patch = (await body<Partial<RoutineInput>>(c)) ?? {};
  const problem = validateRoutine(patch, false);
  if (problem) throw new HttpError(400, problem);
  return c.json(routines.update(routine.id, patch));
});

projectScheduleRoutes.delete("/projects/:id/schedules/:routineId", (c) => {
  routines.delete(schedule(c).id);
  return c.json({ ok: true });
});
