import { Hono } from "hono";
import type { ForkRequest } from "../../shared/types.ts";
import { toPublicConversation } from "../data/conversations.ts";
import { forks } from "./fork.ts";

/** Chat routes of module 05 (forks), mounted on /api; see the route docs in shared/types.ts. */
export const chatRoutes = new Hono();

chatRoutes.post("/conversations/:id/fork", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as ForkRequest;
  const fork = forks.create(c.req.param("id"), typeof body.messageId === "string" && body.messageId ? body.messageId : undefined);
  return c.json(toPublicConversation(fork), 201);
});

chatRoutes.post("/conversations/:id/merge-back", (c) => c.json(toPublicConversation(forks.mergeBack(c.req.param("id")))));
