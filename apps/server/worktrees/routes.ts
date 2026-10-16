import { Hono } from "hono";
import { HttpError } from "../agent/orchestrator.ts";
import { projects } from "../projects/projects.ts";
import { taskStore, toPublic } from "../tasks/store.ts";
import { worktreeCleanup } from "./cleanup.ts";
import { previews } from "./preview.ts";
import { detectForProject } from "./setup.ts";

/** Module 09 (docs/roadmap/09-mission-control.md). Lane C · worktree lifecycle: previews and cleanup. Route docs: packages/shared/types.ts. */
export const worktreeRoutes = new Hono();

worktreeRoutes.post("/tasks/:id/preview/stop", async (c) => {
  const id = c.req.param("id");
  taskStore.require(id);
  await previews.stop(id);
  return c.json(toPublic(taskStore.require(id)));
});

/** Runs the cleanup now; `days` (what Settings → Tasks shows, saved or not) overrides the saved setting. */
worktreeRoutes.post("/worktrees/cleanup", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { days?: unknown };
  let days: number | undefined;
  if (body.days !== undefined) {
    days = Number(body.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, "Clean up worktrees older than 1 to 365 days.");
  }
  return c.json(await worktreeCleanup.run({ days }));
});

/** The setup command new worktrees would run with none set: the Worktree setup dialog's placeholder. */
worktreeRoutes.get("/projects/:id/setup-detect", (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) throw new HttpError(404, "Project not found.");
  return c.json(detectForProject(project));
});
