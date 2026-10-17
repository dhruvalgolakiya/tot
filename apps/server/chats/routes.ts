import { Hono } from "hono";
import type { ForkRequest, PinnedOrderRequest, SearchResults } from "@tot/shared/types";
import { appEvents } from "../app-events.ts";
import { toPublicConversation } from "../data/conversations.ts";
import { messageSearch } from "../data/message-search.ts";
import { forks } from "./fork.ts";
import { pins } from "./pins.ts";

/** Chat routes of module 05 (forks), search and pin order, mounted on /api; see the route docs in packages/shared/types.ts. */
export const chatRoutes = new Hono();

chatRoutes.post("/conversations/:id/fork", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as ForkRequest;
  const fork = forks.create(c.req.param("id"), typeof body.messageId === "string" && body.messageId ? body.messageId : undefined);
  return c.json(toPublicConversation(fork), 201);
});

chatRoutes.post("/conversations/:id/merge-back", (c) => c.json(toPublicConversation(forks.mergeBack(c.req.param("id")))));

chatRoutes.get("/search", (c) => {
  const limit = Number(c.req.query("limit"));
  const results: SearchResults = {
    messages: messageSearch.search(c.req.query("q") ?? "", {
      agentId: c.req.query("agentId") || undefined,
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    }),
  };
  return c.json(results);
});

chatRoutes.put("/conversations/pinned-order", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as PinnedOrderRequest;
  const ordered = pins.reorder(body.ids).map(toPublicConversation);
  for (const conversation of ordered) appEvents.publish({ type: "conversation", conversation });
  return c.json(ordered);
});
