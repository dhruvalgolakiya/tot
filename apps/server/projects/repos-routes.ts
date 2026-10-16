import { Hono, type Context } from "hono";
import type { AddProjectRepoRequest, UpdateProjectRepoRequest } from "@tot/shared/types";
import { HttpError } from "../agent/orchestrator.ts";
import { repoHeads } from "../knowledge/auto/log.ts";
import { knowledge } from "../knowledge/index.ts";
import { firstRequests } from "./first-request.ts";
import { projectRepos } from "./repos.ts";

/**
 * Module 11 (docs/roadmap/11-workspaces.md), lane A: a project's repos — add, rename, set primary, remove,
 * grant a folder. Each answers with the project, its repos updated. Route docs: packages/shared/types.ts.
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

projectRepoRoutes.patch("/projects/:id/repos/:name", async (c) => {
  const projectId = c.req.param("id");
  const was = projectRepos.get(projectId, c.req.param("name"));
  const project = projectRepos.update(projectId, c.req.param("name"), await body<UpdateProjectRepoRequest>(c));
  // A rename: the repo's docs in the knowledge (and the head auto-update last saw) follow its new name. The
  // repo is found again by its folder, which a rename never changes.
  const now = was ? projectRepos.list(projectId).find((repo) => projectRepos.folder(repo) === projectRepos.folder(was) && repo.kind === was.kind) : null;
  if (was && now && now.name !== was.name) {
    repoHeads.rename(projectId, was.name, now.name);
    try {
      knowledge.renameRepo(project.brainId, was.name, now.name);
    } catch (err) {
      console.warn(`[tot] the docs of ${was.name} didn't follow its rename:`, err instanceof Error ? err.message : err);
    }
  }
  return c.json(project);
});

projectRepoRoutes.delete("/projects/:id/repos/:name", (c) => c.json(projectRepos.remove(c.req.param("id"), c.req.param("name"))));

/** The user's OK for a folder repo (the consent dialog). For the primary, a first request waiting for it goes to the Lead now (module 12). */
projectRepoRoutes.post("/projects/:id/repos/:name/grant", (c) => {
  const project = projectRepos.grant(c.req.param("id"), c.req.param("name"));
  void firstRequests.ready(project.id);
  return c.json(project);
});
