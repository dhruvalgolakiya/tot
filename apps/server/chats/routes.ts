import { Hono } from "hono";
import type { ForkRequest, RewindRequest } from "@tot/shared/types";
import { HttpError } from "../agent/orchestrator.ts";
import { toPublicConversation } from "../data/conversations.ts";
import { forks } from "./fork.ts";
import { rewinds } from "./rewind.ts";

/** Chat routes of module 05 (forks) and rewinding, mounted on /api; see the route docs in packages/shared/types.ts. */
export const chatRoutes = new Hono();

chatRoutes.post("/conversations/:id/fork", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as ForkRequest;
  const fork = forks.create(c.req.param("id"), typeof body.messageId === "string" && body.messageId ? body.messageId : undefined);
  return c.json(toPublicConversation(fork), 201);
});

chatRoutes.post("/conversations/:id/merge-back", (c) => c.json(toPublicConversation(forks.mergeBack(c.req.param("id")))));

chatRoutes.get("/conversations/:id/rewind", (c) => c.json(rewinds.preview(c.req.param("id"), c.req.query("messageId") ?? "")));

chatRoutes.post("/conversations/:id/rewind", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<RewindRequest>;
  if (typeof body.messageId !== "string" || !body.messageId) throw new HttpError(400, "Say which message to rewind to.");
  return c.json(await rewinds.rewind(c.req.param("id"), body.messageId, { restoreFiles: body.restoreFiles === true }));
});
