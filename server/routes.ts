import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { readFileSync } from "node:fs";
import type {
  AgentInput,
  AppConnectRequest,
  AppRule,
  ApprovalAnswer,
  RoutineInput,
  ConversationDetail,
  CreateConversationRequest,
  GitHubConnectRequest,
  LearnRepoRequest,
  PluginInput,
  ProviderId,
  SendMessageRequest,
  SettingsPatch,
  UpdateConversationRequest,
  WikiPageInput,
  WikiPagePatch,
} from "../shared/types.ts";
import { HttpError, sendMessage } from "./agent/orchestrator.ts";
import { appEvents } from "./app-events.ts";
import { apps, ExecutorError } from "./apps.ts";
import { appsCatalog, AppsError } from "./apps-catalog.ts";
import { ACCESS_TOKEN } from "./auth.ts";
import { github, GitHubError } from "./github.ts";
import { clientAddress, hostnameOf, isLoopbackName, isThisMachine } from "./net.ts";
import { modelOptions, providerStatuses, providers } from "./agent/providers/index.ts";
import { runRegistry } from "./agent/runs.ts";
import { runRoutine } from "./agent/scheduler.ts";
import { answerApproval } from "./agent/approvals.ts";
import { learnRepo, validateRepoSource } from "./agent/learn-repo.ts";
import { logoutAllComputers } from "./computer/github-login.ts";
import { computerManager } from "./computer/manager.ts";
import { screenshotFile } from "./computer/screens.ts";
import { VERSION } from "./config.ts";
import { agents, validateAgent } from "./data/agents.ts";
import { conversations, toPublicConversation } from "./data/conversations.ts";
import { memories } from "./data/memories.ts";
import { messages } from "./data/messages.ts";
import { plugins, validatePlugin } from "./data/plugins.ts";
import { routines, validateRoutine } from "./data/routines.ts";
import { settings } from "./data/settings.ts";
import { MAX_UPLOAD_BYTES, toAttachment, uploads } from "./data/uploads.ts";
import { wiki, WikiError } from "./data/wiki.ts";

export const api = new Hono();

// ---------------------------------------------------------------------------
// Local-only guard. The API can run agents on the user's subscriptions, so a
// random website must not be able to drive it: pin the Host header (defeats DNS
// rebinding) and reject cross-site Origins (defeats CSRF, incl. no-cors POSTs).
// With TOT_ACCESS_TOKEN set (remote access), sign-in replaces the Host pin.
// ---------------------------------------------------------------------------

const extra = (name: string) => (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const EXTRA_HOSTS = new Set(extra("TOT_ALLOWED_HOSTS").map((h) => h.toLowerCase()));
const EXTRA_ORIGINS = new Set(extra("TOT_ALLOWED_ORIGINS"));

const sameOrigin = (origin: string, host: string) => {
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    return false;
  }
};

api.use("*", async (c, next) => {
  const host = c.req.header("host") ?? "";
  // Loopback names on any port (the Vite dev proxy passes the browser's Host through). With an
  // access token set, sign-in protects the API, so any hostname (LAN IP, tunnel) may reach it.
  if (!ACCESS_TOKEN && !isLoopbackName(hostnameOf(host)) && !EXTRA_HOSTS.has(host.toLowerCase())) {
    return c.json({ error: "Forbidden host." }, 403);
  }
  const origin = c.req.header("origin");
  if (origin && !sameOrigin(origin, host) && !EXTRA_ORIGINS.has(origin)) return c.json({ error: "Forbidden origin." }, 403);
  await next();
});

api.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  if (err instanceof WikiError || err instanceof GitHubError || err instanceof AppsError) return c.json({ error: err.message }, 400);
  if (err instanceof ExecutorError) return c.json({ error: err.message }, err.status === 404 ? 404 : 400);
  console.error("[tot] request failed:", err);
  return c.json({ error: err.message || "Something went wrong." }, 500);
});

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }
}

function found<T>(value: T | null | undefined, what = "Not found."): T {
  if (value == null) throw new HttpError(404, what);
  return value;
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

api.get("/health", (c) => c.json({ ok: true, version: VERSION }));
api.get("/providers", async (c) => c.json(await providerStatuses(c.req.query("refresh") === "1")));
api.get("/models", async (c) => c.json(await modelOptions()));

api.post("/providers/:id/login", async (c) => {
  const provider = providers[c.req.param("id") as ProviderId];
  if (!provider) throw new HttpError(404, "Unknown provider.");
  if (!provider.login) throw new HttpError(400, `${provider.label} login happens in its own CLI.`);
  return c.json(await provider.login());
});

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

api.get("/agents", (c) => {
  agents.first(); // guarantees Tot exists
  return c.json(agents.list());
});

api.post("/agents", async (c) => {
  const input = await body<AgentInput>(c);
  const problem = validateAgent(input, true);
  if (problem) throw new HttpError(400, problem);
  const agent = agents.create(input);
  appEvents.publish({ type: "agent", agent });
  return c.json(agent, 201);
});

api.patch("/agents/:id", async (c) => {
  const id = c.req.param("id");
  found(agents.get(id), "Agent not found.");
  const patch = await body<Partial<AgentInput>>(c);
  const problem = validateAgent(patch, false);
  if (problem) throw new HttpError(400, problem);
  const agent = found(agents.update(id, patch));
  appEvents.publish({ type: "agent", agent });
  return c.json(agent);
});

api.delete("/agents/:id", async (c) => {
  const id = c.req.param("id");
  found(agents.get(id), "Agent not found.");
  if (agents.list().length <= 1) throw new HttpError(400, "You need at least one agent.");
  for (const chat of conversations.list(id)) runRegistry.activeFor(chat.id)?.stop();
  await computerManager.destroy(id).catch((err) => console.warn(`[tot] couldn't destroy computer for agent ${id}:`, err));
  agents.delete(id);
  appEvents.publish({ type: "agent-deleted", agentId: id });
  return c.json({ ok: true });
});

api.get("/agents/:id/routines", (c) => {
  const id = c.req.param("id");
  found(agents.get(id), "Agent not found.");
  return c.json(routines.list(id));
});

api.post("/agents/:id/routines", async (c) => {
  const id = c.req.param("id");
  found(agents.get(id), "Agent not found.");
  const input = await body<RoutineInput>(c);
  const problem = validateRoutine(input, true);
  if (problem) throw new HttpError(400, problem);
  const routine = routines.create(id, input);
  appEvents.agentChanged(id);
  return c.json(routine, 201);
});

// Boat desktop links expire within minutes, so the UI opens this route and gets a fresh one.
api.get("/agents/:id/computer/desktop", async (c) => {
  const id = c.req.param("id");
  found(agents.get(id), "Agent not found.");
  try {
    return c.redirect(await computerManager.desktopUrl(id), 302);
  } catch (err) {
    return c.text(`Couldn't open the desktop: ${err instanceof Error ? err.message : String(err)}`, 400);
  }
});

api.post("/agents/:id/computer/stop", async (c) => {
  const id = c.req.param("id");
  found(agents.get(id), "Agent not found.");
  return c.json(await computerManager.stop(id));
});

api.get("/agents/:id/computer/screens/:file", (c) => {
  const file = screenshotFile(c.req.param("id"), c.req.param("file"));
  if (!file) throw new HttpError(404, "Screenshot not found.");
  return c.body(readFileSync(file), 200, { "content-type": "image/png", "cache-control": "private, max-age=86400" });
});

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

api.get("/conversations", (c) => c.json(conversations.list(c.req.query("agentId") || undefined)));

api.post("/conversations", async (c) => {
  const request = await body<CreateConversationRequest>(c).catch(() => ({}) as CreateConversationRequest);
  const agent = request.agentId ? found(agents.get(request.agentId), "Agent not found.") : agents.first();
  const conversation = conversations.create({
    agentId: agent.id,
    modelId: request.modelId || agent.modelId || settings.get().defaultModelId,
  });
  const created = toPublicConversation(conversation);
  appEvents.publish({ type: "conversation", conversation: created });
  appEvents.agentChanged(agent.id);
  return c.json(created, 201);
});

api.get("/conversations/:id", (c) => {
  const id = c.req.param("id");
  const conversation = found(conversations.get(id), "Chat not found.");
  const detail: ConversationDetail = {
    conversation: toPublicConversation(conversation),
    messages: messages.listByConversation(id),
    activeRunId: runRegistry.activeFor(id)?.id ?? null,
  };
  return c.json(detail);
});

api.patch("/conversations/:id", async (c) => {
  const id = c.req.param("id");
  found(conversations.get(id), "Chat not found.");
  const patch = await body<UpdateConversationRequest>(c);
  const title = typeof patch.title === "string" ? patch.title.trim().slice(0, 120) : undefined;
  if (title === "") throw new HttpError(400, "Title can't be empty.");
  const updated = conversations.update(id, {
    title,
    pinned: typeof patch.pinned === "boolean" ? patch.pinned : undefined,
    modelId: typeof patch.modelId === "string" ? patch.modelId : undefined,
  });
  const conversation = toPublicConversation(found(updated));
  appEvents.publish({ type: "conversation", conversation });
  return c.json(conversation);
});

// The computer belongs to the agent, so deleting a chat leaves it alone.
api.delete("/conversations/:id", (c) => {
  const id = c.req.param("id");
  runRegistry.activeFor(id)?.stop();
  const agentId = conversations.get(id)?.agentId;
  conversations.delete(id);
  appEvents.publish({ type: "conversation-deleted", conversationId: id });
  appEvents.agentChanged(agentId);
  return c.json({ ok: true });
});

api.post("/conversations/:id/messages", async (c) => {
  const request = await body<SendMessageRequest>(c);
  return c.json(await sendMessage(c.req.param("id"), request));
});

// Aliases for the chat's agent's computer.
api.get("/conversations/:id/computer/desktop", (c) => {
  const conversation = found(conversations.get(c.req.param("id")), "Chat not found.");
  return c.redirect(`/api/agents/${conversation.agentId}/computer/desktop`, 302);
});

api.post("/conversations/:id/computer/stop", async (c) => {
  const conversation = found(conversations.get(c.req.param("id")), "Chat not found.");
  return c.json(await computerManager.stop(conversation.agentId));
});

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

api.patch("/routines/:id", async (c) => {
  const id = c.req.param("id");
  found(routines.get(id), "Routine not found.");
  const patch = await body<Partial<RoutineInput>>(c);
  const problem = validateRoutine(patch, false);
  if (problem) throw new HttpError(400, problem);
  return c.json(found(routines.update(id, patch)));
});

api.delete("/routines/:id", (c) => {
  const routine = found(routines.get(c.req.param("id")), "Routine not found.");
  routines.delete(routine.id);
  appEvents.agentChanged(routine.agentId);
  return c.json({ ok: true });
});

api.post("/routines/:id/run", async (c) => {
  const routine = found(routines.get(c.req.param("id")), "Routine not found.");
  return c.json(await runRoutine(routine));
});

// ---------------------------------------------------------------------------
// Uploads (attachments)
// ---------------------------------------------------------------------------

const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

api.post("/uploads", async (c) => {
  if (Number(c.req.header("content-length") ?? 0) > MAX_UPLOAD_BYTES + 64 * 1024) {
    throw new HttpError(400, "Files can be at most 25 MB.");
  }
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) throw new HttpError(400, 'Send the file as multipart form data in a "file" field.');
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(400, "Files can be at most 25 MB.");
  const record = uploads.save({ name: file.name, mimeType: file.type, data: Buffer.from(await file.arrayBuffer()) });
  return c.json(toAttachment(record), 201);
});

api.get("/uploads/:id/:name", (c) => {
  const record = found(uploads.get(c.req.param("id")), "File not found.");
  const inline = INLINE_TYPES.has(record.mimeType);
  return c.body(readFileSync(record.path), 200, {
    "content-type": inline ? record.mimeType : "application/octet-stream",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(record.name)}`,
    // User content must never run as part of TOT's origin.
    "content-security-policy": "sandbox; default-src 'none'",
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=31536000, immutable",
  });
});

// ---------------------------------------------------------------------------
// Runs (SSE)
// ---------------------------------------------------------------------------

const HEARTBEAT_MS = 15_000;
/** Tells EventSource to reconnect quickly after a dropped connection. */
const RECONNECT_MS = 1000;

api.get("/events", (c) =>
  streamSSE(c, async (stream) => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    let writes: Promise<unknown> = stream.writeSSE({ data: "", event: "ready", retry: RECONNECT_MS });
    const unsubscribe = appEvents.subscribe((event) => {
      writes = writes.then(() => stream.writeSSE({ data: JSON.stringify(event) }));
    });
    const heartbeat = setInterval(() => {
      writes = writes.then(() => stream.write(": ping\n\n"));
    }, HEARTBEAT_MS);
    stream.onAbort(finish);
    await finished;
    clearInterval(heartbeat);
    unsubscribe();
  }),
);

api.get("/runs/:runId/events", (c) => {
  const run = runRegistry.get(c.req.param("runId"));
  const afterSeq = Number(c.req.header("last-event-id") ?? 0) || 0;
  // 204 tells EventSource to stop reconnecting: the run is gone or fully delivered.
  if (!run || (run.done && afterSeq >= run.size)) return c.body(null, 204);

  return streamSSE(c, async (stream) => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    // Writes are async; chain them so events stay ordered and the last one is flushed before close.
    let writes: Promise<unknown> = stream.writeSSE({ data: "", event: "ready", retry: RECONNECT_MS });
    const unsubscribe = run.subscribe((seq, event) => {
      writes = writes.then(() => stream.writeSSE({ id: String(seq), data: JSON.stringify(event) }));
      if (event.type === "run-end") finish();
    }, afterSeq);
    const heartbeat = setInterval(() => {
      writes = writes.then(() => stream.write(": ping\n\n"));
    }, HEARTBEAT_MS);
    stream.onAbort(finish);
    await finished;
    clearInterval(heartbeat);
    unsubscribe();
    await writes.catch(() => {});
  });
});

api.post("/runs/:runId/approvals/:partId", async (c) => {
  const answer = await body<ApprovalAnswer>(c);
  if (answer?.decision !== "accept" && answer?.decision !== "decline") throw new HttpError(400, 'Expected { decision: "accept" | "decline" }.');
  const values = answer.values && typeof answer.values === "object" ? answer.values : undefined;
  if (!answerApproval(c.req.param("runId"), c.req.param("partId"), { decision: answer.decision, values })) {
    throw new HttpError(404, "This request already ended.");
  }
  return c.json({ ok: true });
});

api.post("/runs/:runId/stop", (c) => {
  runRegistry.get(c.req.param("runId"))?.stop();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

api.get("/memories", (c) => {
  const q = c.req.query("q")?.trim();
  return c.json(q ? memories.search(q, 100) : memories.list());
});

api.post("/memories", async (c) => {
  const { content } = await body<{ content?: string }>(c);
  if (!content?.trim()) throw new HttpError(400, "Memory can't be empty.");
  return c.json(memories.create({ content, source: "user" }), 201);
});

api.patch("/memories/:id", async (c) => {
  const { content } = await body<{ content?: string }>(c);
  if (!content?.trim()) throw new HttpError(400, "Memory can't be empty.");
  return c.json(found(memories.update(c.req.param("id"), content), "Memory not found."));
});

api.delete("/memories/:id", (c) => {
  found(memories.delete(c.req.param("id")) || null, "Memory not found.");
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Wiki
// ---------------------------------------------------------------------------

function wikiChanged(agentId: string, countsChanged = false): void {
  appEvents.publish({ type: "wiki", agentId });
  if (countsChanged) appEvents.agentChanged(agentId);
}

api.get("/agents/:id/wiki", (c) => {
  const agent = found(agents.get(c.req.param("id")), "Agent not found.");
  const q = c.req.query("q")?.trim();
  return c.json(q ? wiki.search(agent.id, q, 30) : wiki.list(agent.id));
});

api.post("/agents/:id/wiki", async (c) => {
  const agent = found(agents.get(c.req.param("id")), "Agent not found.");
  const input = await body<WikiPageInput>(c);
  const page = wiki.create(agent.id, input, "user");
  wikiChanged(agent.id, true);
  return c.json(page, 201);
});

api.post("/agents/:id/wiki/learn", async (c) => {
  const agent = found(agents.get(c.req.param("id")), "Agent not found.");
  const { source } = await body<Partial<LearnRepoRequest>>(c);
  return c.json(await learnRepo(agent.id, validateRepoSource(source)));
});

api.get("/wiki/:pageId", (c) => c.json(found(wiki.get(c.req.param("pageId")), "Page not found.")));

api.patch("/wiki/:pageId", async (c) => {
  const page = found(wiki.get(c.req.param("pageId")), "Page not found.");
  const patch = await body<WikiPagePatch>(c);
  if (patch.position !== undefined && !Number.isFinite(patch.position)) throw new HttpError(400, "Invalid position.");
  const updated = wiki.update(page.id, patch, "user");
  wikiChanged(page.agentId);
  return c.json(updated);
});

api.delete("/wiki/:pageId", (c) => {
  const page = wiki.delete(found(wiki.get(c.req.param("pageId")), "Page not found.").id);
  wikiChanged(page.agentId, true);
  return c.json({ ok: true });
});

api.get("/wiki/:pageId/revisions", (c) => {
  const page = found(wiki.get(c.req.param("pageId")), "Page not found.");
  return c.json(wiki.revisions(page.id));
});

api.post("/wiki/:pageId/revisions/:revisionId/restore", (c) => {
  const page = found(wiki.get(c.req.param("pageId")), "Page not found.");
  const restored = wiki.restore(page.id, c.req.param("revisionId"), "user");
  wikiChanged(page.agentId);
  return c.json(restored);
});

// ---------------------------------------------------------------------------
// GitHub (the token never leaves the server)
// ---------------------------------------------------------------------------

api.get("/github", async (c) => c.json(await github.status()));

api.post("/github/connect", async (c) => c.json(await github.connect(await body<GitHubConnectRequest>(c))));

api.post("/github/device", async (c) => c.json(await github.startDevice()));

api.get("/github/device", async (c) => c.json(await github.pollDevice()));

api.patch("/github", async (c) => {
  const { allowWrites } = await body<{ allowWrites?: unknown }>(c);
  if (typeof allowWrites !== "boolean") throw new HttpError(400, "Expected { allowWrites: true | false }.");
  return c.json(await github.setAllowWrites(allowWrites));
});

api.delete("/github", async (c) => {
  const status = await github.disconnect();
  // Take the token off agents' computers now rather than on their next use.
  void logoutAllComputers();
  return c.json(status);
});

api.get("/github/repos", async (c) => c.json(await github.repos(c.req.query("q") ?? "")));

// ---------------------------------------------------------------------------
// Apps (Executor)
// ---------------------------------------------------------------------------

api.get("/apps", async (c) => c.json(await apps.status()));

api.post("/apps/setup", async (c) => c.json(await apps.setup()));

api.post("/apps/stop", async (c) => c.json(await apps.stop()));

/** Whether the browser asking is on this machine (whatever address it opened TOT at). */
const fromThisMachine = (c: Context) =>
  isThisMachine(clientAddress(getConnInfo(c).remote.address, c.req.header("x-forwarded-for")));

// Adding apps needs a browser on this machine: sign-ins come back to localhost, and Executor's link carries its admin token.
api.get("/apps/access", (c) => c.json({ onThisMachine: fromThisMachine(c) }));

api.get("/apps/catalog", async (c) => c.json(await appsCatalog.catalog(c.req.query("q") ?? "")));

api.post("/apps/connect", async (c) => {
  const request = await body<Partial<AppConnectRequest>>(c);
  if (typeof request.appId !== "string" || !request.appId) throw new HttpError(400, "Which app?");
  const values =
    request.values && typeof request.values === "object"
      ? Object.fromEntries(Object.entries(request.values).filter(([, v]) => typeof v === "string"))
      : undefined;
  return c.json(await appsCatalog.connect(request.appId, values as Record<string, string> | undefined));
});

api.get("/apps/connect/:flowId", (c) => c.json(appsCatalog.poll(c.req.param("flowId"))));

api.delete("/apps/connect/:flowId", async (c) => {
  await appsCatalog.cancel(c.req.param("flowId"));
  return c.json({ ok: true });
});

api.post("/apps/oauth-client", async (c) => {
  const { appId, clientId, clientSecret } = await body<{ appId?: unknown; clientId?: unknown; clientSecret?: unknown }>(c);
  if (typeof appId !== "string" || typeof clientId !== "string" || typeof clientSecret !== "string") {
    throw new HttpError(400, "Expected { appId, clientId, clientSecret }.");
  }
  await appsCatalog.saveClient(appId, clientId, clientSecret);
  return c.json({ ok: true });
});

api.delete("/apps/:appId", async (c) => {
  await appsCatalog.remove(c.req.param("appId"));
  return c.json(await apps.status());
});

api.get("/apps/:appId/rules", async (c) => c.json(await appsCatalog.rules(c.req.param("appId"))));

api.put("/apps/:appId/rules", async (c) => {
  const { tool, action } = await body<{ tool?: unknown; action?: unknown }>(c);
  if (typeof tool !== "string" || !["approve", "require_approval", "block", "default"].includes(String(action))) {
    throw new HttpError(400, 'Expected { tool, action: "approve" | "require_approval" | "block" | "default" }.');
  }
  return c.json(await appsCatalog.setRule(c.req.param("appId"), tool, action as AppRule["action"] | "default"));
});

api.get("/apps/open", (c) => {
  if (!fromThisMachine(c)) throw new HttpError(403, "Add apps from the Mac that runs TOT; sign-ins finish there.");
  const url = apps.openUrl(c.req.query("path") ?? "/");
  if (!url) throw new HttpError(400, "Apps aren't running. Set them up in Settings → Connections.");
  return c.redirect(url, 302);
});

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

api.get("/plugins", (c) => c.json(plugins.list()));

api.post("/plugins", async (c) => {
  const input = await body<PluginInput>(c);
  if (!input.name || !input.config) throw new HttpError(400, "A plugin needs a name and a config.");
  const problem = validatePlugin(input);
  if (problem) throw new HttpError(400, problem);
  if (plugins.list().some((p) => p.name === input.name)) throw new HttpError(409, `A plugin named "${input.name}" already exists.`);
  return c.json(plugins.create(input), 201);
});

api.patch("/plugins/:id", async (c) => {
  const id = c.req.param("id");
  found(plugins.get(id), "Plugin not found.");
  const patch = await body<Partial<PluginInput>>(c);
  const problem = validatePlugin(patch);
  if (problem) throw new HttpError(400, problem);
  return c.json(found(plugins.update(id, patch)));
});

api.delete("/plugins/:id", (c) => {
  found(plugins.delete(c.req.param("id")) || null, "Plugin not found.");
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

api.get("/settings", (c) => c.json(settings.get()));

api.patch("/settings", async (c) => {
  const patch = await body<SettingsPatch>(c);
  if (patch.computer?.mode && !["boat", "local", "off"].includes(patch.computer.mode)) {
    throw new HttpError(400, "Computer mode must be boat, local, or off.");
  }
  if (patch.computer?.idleStopMinutes !== undefined) {
    const minutes = Number(patch.computer.idleStopMinutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) {
      throw new HttpError(400, "Idle stop must be between 1 and 1440 minutes.");
    }
    patch.computer.idleStopMinutes = minutes;
  }
  const next = settings.patch(patch);
  // Auth changes alter provider status; don't serve a stale cached one.
  if (patch.claude || patch.anthropicApiKey !== undefined) void providerStatuses(true);
  return c.json(next);
});
