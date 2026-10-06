import { Hono, type Context } from "hono";
import type { AddProjectRepoRequest, UpdateProjectRepoRequest } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { projectRepos } from "./repos.ts";

/**
 * Module 11 (docs/roadmap/11-workspaces.md), lane A: a project's repos — add, rename, set primary, remove,
 * grant a folder. Each answers with the project, its repos updated. Route docs: shared/types.ts.
 */
export const projectRepoRoutes = new Hono();

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }
}

projectRepoRoutes.post("/projects/:id/repos", async (c) => c.json(projectRepos.add(c.req.param("id"), await body<AddProjectRepoRequest>(c)), 201));

projectRepoRoutes.patch("/projects/:id/repos/:name", async (c) =>
  c.json(projectRepos.update(c.req.param("id"), c.req.param("name"), await body<UpdateProjectRepoRequest>(c))),
);

projectRepoRoutes.delete("/projects/:id/repos/:name", (c) => c.json(projectRepos.remove(c.req.param("id"), c.req.param("name"))));

/** The user's OK for a folder repo (the consent dialog). */
projectRepoRoutes.post("/projects/:id/repos/:name/grant", (c) => c.json(projectRepos.grant(c.req.param("id"), c.req.param("name"))));
