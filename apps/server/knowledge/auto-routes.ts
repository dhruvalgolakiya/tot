import { Hono, type Context } from "hono";
import { HttpError } from "../agent/orchestrator.ts";
import { callerOf } from "../auth.ts";
import { projects } from "../projects/projects.ts";
import { knowledgeAuto } from "./auto/jobs.ts";
import { undoUpdate } from "./auto/undo.ts";

/**
 * Module 11 (docs/roadmap/11-workspaces.md), lane C: a project's knowledge auto-updates — the log, checking its
 * repos now, and undoing one. Route docs: shared/types.ts. Knowledge stays on its device: paired devices get 403.
 */
export const knowledgeAutoRoutes = new Hono();

function projectFor(c: Context) {
  if (callerOf(c).kind === "device") throw new HttpError(403, "A project's knowledge stays on the device it's on.");
  const project = projects.get(c.req.param("id"));
  if (!project) throw new HttpError(404, "Project not found.");
  return project;
}

knowledgeAutoRoutes.get("/projects/:id/knowledge/updates", (c) => c.json(knowledgeAuto.list(projectFor(c).id)));

knowledgeAutoRoutes.post("/projects/:id/knowledge/refresh", async (c) => {
  const project = projectFor(c);
  if (project.archived) throw new HttpError(400, "This project is archived.");
  return c.json(await knowledgeAuto.refresh(project));
});

knowledgeAutoRoutes.post("/projects/:id/knowledge/updates/:updateId/undo", async (c) => c.json(await undoUpdate(projectFor(c).id, c.req.param("updateId"))));
