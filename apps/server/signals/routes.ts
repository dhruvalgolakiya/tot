import { Hono } from "hono";
import type { UpdateProjectSubscriptionsRequest } from "@tot/shared/types";
import { HttpError } from "../agent/orchestrator.ts";
import { appEvents } from "../app-events.ts";
import { leads } from "../lead/lead.ts";
import { projects } from "../projects/projects.ts";
import { leadSignals } from "./store.ts";
import { projectSubscriptions } from "./subscriptions.ts";
import { prWatch } from "./watch.ts";

/**
 * Module 12 (docs/roadmap/12-coordinator.md), lane A: a project's signals (what its Lead heard about on its own)
 * and its subscriptions (which pull requests it watches). Route docs: packages/shared/types.ts.
 */
export const signalRoutes = new Hono();

const MAX_LIST = 100;

function requireProject(id: string) {
  const project = projects.get(id);
  if (!project) throw new HttpError(404, "Project not found.");
  return project;
}

/** The project's signals, newest first (?limit=, default 50). */
signalRoutes.get("/projects/:id/signals", (c) => {
  const project = requireProject(c.req.param("id"));
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), MAX_LIST);
  return c.json(leadSignals.list(project.id, limit));
});

/** Looks at the project's pull requests now; the signals after it, newest first. */
signalRoutes.post("/projects/:id/signals/check", async (c) => {
  const project = requireProject(c.req.param("id"));
  await prWatch.check(project.id);
  return c.json(leadSignals.list(project.id));
});

signalRoutes.get("/projects/:id/subscriptions", (c) => c.json(projectSubscriptions.get(requireProject(c.req.param("id")).id)));

signalRoutes.patch("/projects/:id/subscriptions", async (c) => {
  const project = requireProject(c.req.param("id"));
  const patch = (await c.req.json().catch(() => null)) as UpdateProjectSubscriptionsRequest | null;
  if (!patch || typeof patch !== "object") throw new HttpError(400, "Expected { pullRequests }.");
  const before = project.subscriptions?.pullRequests;
  const next = projectSubscriptions.update(project.id, patch);
  appEvents.publish({ type: "project", project: projects.get(project.id)! });
  // Pull request news goes to the project's Lead: choosing to watch starts one if there's none yet.
  if (next.pullRequests !== "off" && next.pullRequests !== before) leads.open(project.id);
  // Watching more now: a first look right away (quietly when it can't; the timer tries again).
  if (next.pullRequests !== "off" && next.pullRequests !== before) void prWatch.check(project.id).catch(() => {});
  return c.json(next);
});
