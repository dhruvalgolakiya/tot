import { Hono } from "hono";
import type { ForkRequest, SendMessageRequest } from "@tot/shared/types";
import { toPublicConversation } from "../data/conversations.ts";
import { forks } from "./fork.ts";
import { chatQueue } from "./queue.ts";

/** Chat routes of module 05 (forks) and the composer's queue, mounted on /api; see the route docs in packages/shared/types.ts. */
export const chatRoutes = new Hono();

chatRoutes.post("/conversations/:id/fork", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as ForkRequest;
  const fork = forks.create(c.req.param("id"), typeof body.messageId === "string" && body.messageId ? body.messageId : undefined);
  return c.json(toPublicConversation(fork), 201);
});

chatRoutes.post("/conversations/:id/merge-back", (c) => c.json(toPublicConversation(forks.mergeBack(c.req.param("id")))));

chatRoutes.get("/conversations/:id/queue", (c) => c.json(chatQueue.list(c.req.param("id"))));

chatRoutes.post("/conversations/:id/queue", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Partial<SendMessageRequest> | null;
  return c.json(chatQueue.add(c.req.param("id"), body ?? {}), 201);
});

chatRoutes.delete("/conversations/:id/queue/:itemId", (c) => {
  chatQueue.remove(c.req.param("id"), c.req.param("itemId"));
  return c.json({ ok: true });
});

chatRoutes.post("/conversations/:id/queue/:itemId/send", async (c) => c.json(await chatQueue.sendNow(c.req.param("id"), c.req.param("itemId"))));
