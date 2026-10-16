import { Hono, type Context } from "hono";
import type { Project } from "@tot/shared/types";
import { HttpError } from "../agent/orchestrator.ts";
import { callerOf } from "../auth.ts";
import { projects } from "../projects/projects.ts";
import { knowledge } from "./index.ts";

/**
 * Module 11 (docs/roadmap/11-workspaces.md), lane B: where a project's knowledge lives, its move to git, and its
 * history (facts and pages) with undo. Route docs: packages/shared/types.ts. The wiki's own routes (routes.ts) work
 * unchanged on top of git.
 */
export const knowledgeRoutes = new Hono();

function project(c: Context): Project {
  // Memory is this device's (module 10's /api/memory is closed to paired devices): so is the knowledge's history and undo.
  if (callerOf(c).kind === "device") throw new HttpError(403, "A project's knowledge stays on the device it's on.");
  const found = projects.get(c.req.param("id"));
  if (!found) throw new HttpError(404, "Project not found.");
  return found;
}

knowledgeRoutes.get("/projects/:id/knowledge", (c) => c.json(knowledge.status(project(c))));

knowledgeRoutes.get("/projects/:id/knowledge/history", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 30, 1), 200);
  const skip = Math.max(Number(c.req.query("skip")) || 0, 0);
  return c.json(await knowledge.history(project(c), limit, skip));
});

knowledgeRoutes.post("/projects/:id/knowledge/undo", async (c) => {
  const { sha } = (await c.req.json().catch(() => ({}))) as { sha?: unknown };
  if (typeof sha !== "string" || !sha.trim()) throw new HttpError(400, "Say which change to undo: { sha }.");
  return c.json(await knowledge.undo(project(c), sha.trim()));
});
