import { Hono } from "hono";
import { toPublicConversation } from "../data/conversations.ts";
import { homeProjects } from "./board.ts";
import { leads } from "./lead.ts";

/** Module 11 (docs/roadmap/11-workspaces.md), lane D: a project's Lead chat, and Home's project rows. Route docs: shared/types.ts. */
export const leadRoutes = new Hono();

/** The project's Lead chat: made the first time (201), the same one after (200). Body: { agentId? }. */
leadRoutes.post("/projects/:id/lead", async (c) => {
  const request = (await c.req.json().catch(() => ({}))) as { agentId?: unknown } | null;
  const agentId = typeof request?.agentId === "string" && request.agentId ? request.agentId : null;
  const { lead, created } = leads.open(c.req.param("id"), agentId);
  return c.json(toPublicConversation(lead), created ? 201 : 200);
});

leadRoutes.get("/home", (c) => c.json(homeProjects()));
