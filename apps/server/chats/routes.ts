import { Hono } from "hono";
import type { ForkRequest, PinnedOrderRequest, RewindRequest, SearchResults, SendMessageRequest } from "@tot/shared/types";
import { HttpError } from "../agent/orchestrator.ts";
import { appEvents } from "../app-events.ts";
import { agents } from "../data/agents.ts";
import { conversations, toPublicConversation } from "../data/conversations.ts";
import { messageSearch } from "../data/message-search.ts";
import { projects } from "../projects/projects.ts";
import { checkpoints } from "./checkpoints.ts";
import { chatFiles } from "./files.ts";
import { forks } from "./fork.ts";
import { pins } from "./pins.ts";
import { chatQueue } from "./queue.ts";
import { rewinds } from "./rewind.ts";

/** Chat routes of module 05 (forks), search, pin order, the composer's (its queue, files for "@"), rewinding and a turn's changes, mounted on /api; see the route docs in packages/shared/types.ts. */
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

const limitOf = (value: string | undefined) => (value && Number.isFinite(Number(value)) ? Number(value) : undefined);

chatRoutes.get("/conversations/:id/files", async (c) => {
  const chat = conversations.get(c.req.param("id"));
  if (!chat) throw new HttpError(404, "Chat not found.");
  return c.json(await chatFiles.list(chat, c.req.query("q") ?? "", limitOf(c.req.query("limit"))));
});

// A chat not sent yet, in a project: its main checkout's files (a worktree of its own doesn't exist yet).
chatRoutes.get("/projects/:id/files", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) throw new HttpError(404, "Project not found.");
  const agent = agents.get(c.req.query("agentId") ?? "") ?? agents.first();
  const draft = { id: "", title: "", agentId: agent.id, projectId: project.id, kind: "chat" as const, task: null };
  return c.json(await chatFiles.list(draft, c.req.query("q") ?? "", limitOf(c.req.query("limit"))));
});

chatRoutes.get("/conversations/:id/messages/:messageId/changes", async (c) => {
  const chat = conversations.get(c.req.param("id"));
  if (!chat) throw new HttpError(404, "Chat not found.");
  return c.json(await checkpoints.diff(chat, c.req.param("messageId")));
});

chatRoutes.get("/conversations/:id/rewind", (c) => c.json(rewinds.preview(c.req.param("id"), c.req.query("messageId") ?? "")));

chatRoutes.post("/conversations/:id/rewind", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<RewindRequest>;
  if (typeof body.messageId !== "string" || !body.messageId) throw new HttpError(400, "Say which message to rewind to.");
  return c.json(await rewinds.rewind(c.req.param("id"), body.messageId, { restoreFiles: body.restoreFiles === true }));
});
