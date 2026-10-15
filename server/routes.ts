import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { readFileSync } from "node:fs";
import type {
  BrainAccess,
  BrainInput,
  BrainPatch,
  AgentInput,
  AppConnectRequest,
  AppRule,
  ApprovalAnswer,
  RoutineInput,
  ConversationDetail,
  CreateConversationRequest,
  GitHubConnectRequest,
  LiveRuns,
  LearnRepoRequest,
  MailboxConnectRequest,
  PersonaGitHubConnectRequest,
  PersonaInput,
  PersonaPatch,
  PluginInput,
  ProviderId,
  SendMessageRequest,
  SettingsPatch,
  SlackPatch,
  SlackTokens,
  UpdateConversationRequest,
  WikiPageInput,
  WikiPagePatch,
} from "../shared/types.ts";
import { HttpError, sendMessage } from "./agent/orchestrator.ts";
import { appEvents } from "./app-events.ts";
import { apps, ExecutorError } from "./apps.ts";
import { appsCatalog, AppsError } from "./apps-catalog.ts";
import { signInReady } from "./access.ts";
import { callerKey, callerOf } from "./auth.ts";
import { deviceRoutes } from "./devices/routes.ts";
import { PairingError } from "./devices/pairing.ts";
import { relay } from "./devices/relay.ts";
import { onSignOut } from "./devices/sessions.ts";
import { github, GitHubError } from "./github.ts";
import { clientAddress, isThisMachine, isTrustedLocalHost } from "./net.ts";
import { slack } from "./slack.ts";
import { accountStatuses, modelOptions, providerStatuses, providers } from "./agent/providers/index.ts";
import { accountRoutes } from "./accounts/routes.ts";
import { runRegistry } from "./agent/runs.ts";
import { runRoutine } from "./agent/scheduler.ts";
import { answerApproval, runsWaiting } from "./agent/approvals.ts";
import { leadAsks } from "./lead/asks.ts";
import { learnRepo, validateRepoSource } from "./agent/learn-repo.ts";
import { refreshGitHubLogins } from "./computer/github-login.ts";
import { computerManager } from "./computer/manager.ts";
import { screenshotFile } from "./computer/screens.ts";
import { VERSION } from "./config.ts";
import { agents, validateAgent } from "./data/agents.ts";
import { BrainError, brains } from "./data/brains.ts";
import { chatWorkspaces } from "./chats/workspace.ts";
import { conversations, toPublicConversation } from "./data/conversations.ts";
import { mail, toMailMessage, toSummary } from "./data/mail.ts";
import { clipMessages } from "./data/clip.ts";
import { messages } from "./data/messages.ts";
import { personas, validatePersona } from "./data/personas.ts";
import { plugins, validatePlugin } from "./data/plugins.ts";
import { routines, validateRoutine } from "./data/routines.ts";
import { settings } from "./data/settings.ts";
import { MAX_UPLOAD_BYTES, toAttachment, uploads } from "./data/uploads.ts";
import { wiki, WikiError } from "./data/wiki.ts";
import { mailboxes } from "./mail/mailbox.ts";
import { personaGitHub } from "./persona-github.ts";
import { orchestrationRoutes } from "./orchestration/routes.ts";
import { taskQueue } from "./tasks/queue.ts";
import { taskRoutes } from "./tasks/routes.ts";
import { landingRoutes } from "./landing/routes.ts";
import { missionRoutes } from "./mission/routes.ts";
import { worktreeRoutes } from "./worktrees/routes.ts";
import { chatRoutes } from "./chats/routes.ts";
import { projectRoutes } from "./projects/routes.ts";
import { projectRepoRoutes } from "./projects/repos-routes.ts";
import { knowledgeRoutes } from "./knowledge/routes.ts";
import { knowledgeAutoRoutes } from "./knowledge/auto-routes.ts";
import { leadRoutes } from "./lead/routes.ts";
import { projectScheduleRoutes } from "./projects/schedules-routes.ts";
import { signalRoutes } from "./signals/routes.ts";
import { projects } from "./projects/projects.ts";
import { isTask } from "./tasks/store.ts";
import { tasks } from "./tasks/tasks.ts";
import { trustRoutes } from "./trust/routes.ts";
// Memory repo (module 10)
import { MemoryError } from "./memory/repo.ts";
import { checkMemorySettings, memoryRoutes, memorySettingsChanged } from "./memory/routes.ts";
import { BUNDLE_PATH } from "./memory/sync.ts";

export const api = new Hono();

// ---------------------------------------------------------------------------
// Local-only guard. The API can run agents on the user's subscriptions, so a
// random website must not be able to drive it: pin the Host header (defeats DNS
// rebinding) and reject cross-site Origins (defeats CSRF, incl. no-cors POSTs).
// Once sign-in is set up (remote access), signing in replaces the Host pin for other devices; this
// computer's own requests still need a loopback Host (auth.ts).
// ---------------------------------------------------------------------------

const extra = (name: string) => (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
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
  // Loopback names on any port (the Vite dev proxy passes the browser's Host through). Once sign-in is
  // set up, it protects the API, so any hostname (LAN IP, Tailscale, a tunnel) may reach it.
  if (!signInReady() && !isTrustedLocalHost(host)) {
    return c.json({ error: "Forbidden host." }, 403);
  }
  const origin = c.req.header("origin");
  if (origin && !sameOrigin(origin, host) && !EXTRA_ORIGINS.has(origin)) return c.json({ error: "Forbidden origin." }, 403);
  await next();
});

// A paired device (module 07) works with this device's agents, chats and projects, but can't manage devices or
// sign-ins, reach a third device through this one, or change this device's logins and settings.
// Memory repo (module 10): memory is this device's too; a paired device may only fetch the sync bundle.
const DEVICE_NEVER = /^\/api\/(devices|sessions|d|access|memory|memories)(\/|$)/;
const DEVICE_READ_ONLY = /^\/api\/(settings|github|slack|apps|personas|plugins|accounts)(\/|$)/;
api.use("*", async (c, next) => {
  if (callerOf(c).kind !== "device" || c.req.path === "/api/devices/unpaired" || c.req.path === BUNDLE_PATH) return next();
  if (DEVICE_NEVER.test(c.req.path) || (c.req.method !== "GET" && DEVICE_READ_ONLY.test(c.req.path))) {
    return c.json({ error: "Another device can't do that here. Use this device itself." }, 403);
  }
  await next();
});

api.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  if (err instanceof PairingError) return c.json({ error: err.message }, err.status);
  if (err instanceof MemoryError) return c.json({ error: err.message }, err.status);
  if (err instanceof WikiError || err instanceof BrainError || err instanceof GitHubError || err instanceof AppsError) return c.json({ error: err.message }, 400);
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
  appEvents.personaChanged(agent.personaId);
  appEvents.brainsChanged();
  return c.json(agent, 201);
});

api.patch("/agents/:id", async (c) => {
  const id = c.req.param("id");
  const before = found(agents.get(id), "Agent not found.");
  const patch = await body<Partial<AgentInput>>(c);
  const problem = validateAgent(patch, false);
  if (problem) throw new HttpError(400, problem);
  const agent = found(agents.update(id, patch));
  appEvents.publish({ type: "agent", agent });
  // Each persona lists the agents working as it; the agent may now use another GitHub account.
  if (before.personaId !== agent.personaId) {
    appEvents.personaChanged(before.personaId);
    appEvents.personaChanged(agent.personaId);
    void refreshGitHubLogins();
  }
  return c.json(agent);
});

api.delete("/agents/:id", async (c) => {
  const id = c.req.param("id");
  found(agents.get(id), "Agent not found.");
  if (agents.list().length <= 1) throw new HttpError(400, "You need at least one agent.");
  for (const chat of conversations.list(id)) runRegistry.activeFor(chat.id)?.stop();
  await computerManager.destroy(id).catch((err) => console.warn(`[tot] couldn't destroy computer for agent ${id}:`, err));
  const affected = personas.list().filter((persona) => persona.agentIds.includes(id) || persona.defaultAgentId === id);
  agents.delete(id);
  appEvents.publish({ type: "agent-deleted", agentId: id });
  for (const persona of affected) appEvents.personaChanged(persona.id);
  appEvents.brainsChanged();
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
  // A project's schedule is made from the project (module 12: POST /api/projects/:id/schedules), not here.
  const routine = routines.create(id, { ...input, projectId: null });
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
  const project = request.projectId ? found(projects.get(request.projectId), "Project not found.") : null;
  if (project?.archived) throw new HttpError(400, "That project is archived.");
  // In a code project, where it works: its main checkout, or a worktree made on its first message.
  const workspace = chatWorkspaces.forNew(agent.id, project, request.workspace);
  const conversation = conversations.create({
    agentId: agent.id,
    modelId: request.modelId || agent.modelId || settings.get().defaultModelId,
    projectId: project?.id ?? null,
    workspace,
  });
  // New wiki pages from this chat go to the project's brain.
  if (project) brains.setFocus(conversation.id, project.brainId);
  const created = toPublicConversation(conversation);
  appEvents.publish({ type: "conversation", conversation: created });
  appEvents.agentChanged(agent.id);
  return c.json(created, 201);
});

api.get("/conversations/:id", (c) => {
  const id = c.req.param("id");
  const conversation = found(conversations.get(id), "Chat not found.");
  // Clients that can open a clipped tool call ask for clip=1; others (older phones, paired devices) get every part whole.
  const clip = c.req.query("clip") === "1";
  const list = messages.listByConversation(id);
  const detail: ConversationDetail = {
    conversation: toPublicConversation(conversation),
    messages: clip ? clipMessages(list) : list,
    activeRunId: runRegistry.activeFor(id)?.id ?? null,
  };
  return c.json(detail);
});

// One part of a message, whole: a clipped chat's tool call when it's opened. A reply still being written is read live.
api.get("/conversations/:id/messages/:messageId/parts/:partId", (c) => {
  const { id, messageId, partId } = c.req.param();
  found(conversations.get(id), "Chat not found.");
  const run = runRegistry.activeFor(id);
  const live = run?.messageId === messageId ? run.reply?.().parts.find((part) => part.id === partId) : undefined;
  return c.json(found(live ?? messages.part(id, messageId, partId), "That step isn't in this chat."));
});

api.patch("/conversations/:id", async (c) => {
  const id = c.req.param("id");
  const record = found(conversations.get(id), "Chat not found.");
  const patch = await body<UpdateConversationRequest>(c);
  // Moving a chat takes its tasks along; a task moves with its chat, not on its own.
  if (patch.projectId !== undefined && patch.projectId !== record.projectId) {
    if (record.kind === "task" && record.parentId) throw new HttpError(400, "A task stays in its chat's project. Move the chat instead.");
    projects.moveChat(id, patch.projectId);
  }
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

// The computer belongs to the agent, so deleting a chat leaves it alone (a task's or a chat's own worktree goes with it).
api.delete("/conversations/:id", async (c) => {
  const id = c.req.param("id");
  if (isTask(conversations.get(id))) {
    await tasks.remove(id, { deleteBranch: c.req.query("deleteBranch") === "1" });
    return c.json({ ok: true });
  }
  runRegistry.activeFor(id)?.stop();
  const record = conversations.get(id);
  // A chat's own worktree goes with it; its branch stays when it has commits of its own or was pushed.
  if (record) {
    await chatWorkspaces.remove(record).catch((err) => {
      console.warn(`[tot] couldn't remove the worktree of chat ${id}:`, err instanceof Error ? err.message : err);
    });
  }
  const agentId = record?.agentId;
  conversations.delete(id);
  appEvents.publish({ type: "conversation-deleted", conversationId: id });
  appEvents.agentChanged(agentId);
  return c.json({ ok: true });
});

api.post("/conversations/:id/messages", async (c) => {
  const id = c.req.param("id");
  const request = await body<SendMessageRequest>(c);
  const conversation = conversations.get(id);
  if (isTask(conversation)) {
    const result = await tasks.message(id, request);
    if ("started" in result) return c.json(result.started);
    return c.json({ runId: runRegistry.activeFor(id)?.id ?? "", userMessage: result.steered, conversation: toPublicConversation(conversations.get(id)!) });
  }
  // A chat: its model answers, starting tasks itself when the work calls for it.
  return c.json(await sendMessage(id, request));
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

api.route("/", taskRoutes);
// Provider accounts: several Claude / ChatGPT sign-ins (config folders).
api.route("/", accountRoutes);
// Module 09: mission control (lanes A, B, C).
api.route("/", landingRoutes);
api.route("/", missionRoutes);
api.route("/", worktreeRoutes);
api.route("/", chatRoutes);
api.route("/", projectRoutes);
// Module 11: workspaces (lanes A–D).
api.route("/", projectRepoRoutes);
api.route("/", knowledgeRoutes);
api.route("/", knowledgeAutoRoutes);
api.route("/", leadRoutes);
api.route("/", signalRoutes);
api.route("/", projectScheduleRoutes);
api.route("/", deviceRoutes);
api.route("/", orchestrationRoutes);

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
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

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
    // A browser that's signed out, or a device that's unpaired (Settings → Devices), stops getting events at once.
    const forget = onSignOut(callerKey(c), finish);
    const caller = callerOf(c);
    const leave = caller.kind === "device" ? relay.connected(caller.id) : () => {};
    await finished;
    forget();
    leave();
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
    const forget = onSignOut(callerKey(c), finish);
    await finished;
    forget();
    clearInterval(heartbeat);
    unsubscribe();
    await writes.catch(() => {});
  });
});

/**
 * What's running and what's waiting for the user right now, for a screen that just opened (the phone app,
 * module 14): app events only tell what changes after that.
 */
api.get("/runs/live", (c) => {
  const waitingRuns = runsWaiting();
  const running: LiveRuns["running"] = [];
  const waiting = new Set(leadAsks.waitingChats());
  for (const run of runRegistry.active()) {
    const agentId = conversations.get(run.conversationId)?.agentId;
    if (!agentId) continue;
    running.push({ runId: run.id, conversationId: run.conversationId, agentId });
    if (waitingRuns.has(run.id)) waiting.add(run.conversationId);
  }
  const body: LiveRuns = {
    running,
    waiting: [...waiting].flatMap((conversationId) => {
      const agentId = conversations.get(conversationId)?.agentId;
      return agentId ? [{ conversationId, agentId }] : [];
    }),
  };
  return c.json(body);
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
// Memory repo (module 10): /api/memories and /api/memory/* (server/memory/routes.ts)
// ---------------------------------------------------------------------------

api.route("/", memoryRoutes);

// ---------------------------------------------------------------------------
// Wiki
// ---------------------------------------------------------------------------

function wikiChanged(brainId: string, structure = false): void {
  appEvents.brainChanged(brainId, { structure });
}

api.get("/brains", (c) => c.json(brains.list()));

api.post("/brains", async (c) => {
  const input = await body<BrainInput>(c);
  if (input.agentId) found(agents.get(input.agentId), "Agent not found.");
  const { id } = brains.create({ ...input, kind: "notes" });
  wiki.overview(id);
  appEvents.brainsChanged();
  return c.json(brains.get(id), 201);
});

api.patch("/brains/:id", async (c) => {
  const brain = brains.update(found(brains.get(c.req.param("id")), "Brain not found.").id, await body<BrainPatch>(c));
  appEvents.brainsChanged();
  return c.json(brain);
});

api.delete("/brains/:id", (c) => {
  brains.delete(found(brains.get(c.req.param("id")), "Brain not found.").id);
  appEvents.brainsChanged();
  return c.json({ ok: true });
});

api.put("/brains/:id/agents/:agentId", async (c) => {
  const brain = found(brains.get(c.req.param("id")), "Brain not found.");
  const agent = found(agents.get(c.req.param("agentId")), "Agent not found.");
  const { access } = await body<{ access: BrainAccess }>(c);
  const updated = brains.attach(brain.id, agent.id, access);
  appEvents.brainsChanged();
  return c.json(updated);
});

api.delete("/brains/:id/agents/:agentId", (c) => {
  const updated = brains.detach(found(brains.get(c.req.param("id")), "Brain not found.").id, c.req.param("agentId"));
  appEvents.brainsChanged();
  return c.json(updated);
});

api.get("/brains/:id/wiki", (c) => {
  const brain = found(brains.get(c.req.param("id")), "Brain not found.");
  const q = c.req.query("q")?.trim();
  return c.json(q ? wiki.search(brain.id, q, 30) : wiki.list(brain.id));
});

api.post("/brains/:id/wiki", async (c) => {
  const brain = found(brains.get(c.req.param("id")), "Brain not found.");
  const input = await body<WikiPageInput>(c);
  const page = wiki.create(brain.id, input, "user");
  wikiChanged(brain.id, true);
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
  wikiChanged(page.brainId);
  return c.json(updated);
});

api.delete("/wiki/:pageId", (c) => {
  const page = wiki.delete(found(wiki.get(c.req.param("pageId")), "Page not found.").id);
  wikiChanged(page.brainId, true);
  return c.json({ ok: true });
});

api.get("/wiki/:pageId/revisions", (c) => {
  const page = found(wiki.get(c.req.param("pageId")), "Page not found.");
  return c.json(wiki.revisions(page.id));
});

api.post("/wiki/:pageId/revisions/:revisionId/restore", (c) => {
  const page = found(wiki.get(c.req.param("pageId")), "Page not found.");
  const restored = wiki.restore(page.id, c.req.param("revisionId"), "user");
  wikiChanged(page.brainId);
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
  void refreshGitHubLogins();
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
// Slack bot (its tokens never leave the server)
// ---------------------------------------------------------------------------

api.get("/slack", (c) => c.json(slack.status()));

api.put("/slack/tokens", async (c) => {
  const tokens = await body<Partial<SlackTokens>>(c);
  return c.json(await slack.connect({ appToken: String(tokens.appToken ?? ""), botToken: String(tokens.botToken ?? "") }));
});

api.patch("/slack", async (c) => {
  const patch = await body<SlackPatch>(c);
  const id = (value: unknown) => (typeof value === "string" && /^[A-Z0-9]+$/.test(value) ? value : undefined);
  return c.json(
    slack.patch({
      ...(patch.defaultAgentId === null || typeof patch.defaultAgentId === "string" ? { defaultAgentId: patch.defaultAgentId } : {}),
      ...(id(patch.allow) ? { allow: id(patch.allow) } : {}),
      ...(id(patch.disallow) ? { disallow: id(patch.disallow) } : {}),
    }),
  );
});

api.delete("/slack", async (c) => c.json(await slack.disconnect()));

// ---------------------------------------------------------------------------
// Personas, their mailboxes and GitHub accounts (passwords and tokens never leave the server)
// ---------------------------------------------------------------------------

api.get("/personas", (c) => {
  const list = personas.list();
  // A GitHub token found revoked shows up on the persona via a "persona" event.
  for (const persona of list) if (persona.github) void personaGitHub.check(persona.id);
  return c.json(list);
});

/** One persona per mailbox: two would both answer the same emailed tasks. */
function addressFree(email: string, exceptId?: string): void {
  if (personas.list().some((p) => p.email === email.trim().toLowerCase() && p.id !== exceptId)) {
    throw new HttpError(409, "Another persona already uses that address.");
  }
}

api.post("/personas", async (c) => {
  const input = await body<Partial<PersonaInput>>(c);
  const problem = validatePersona(input, true);
  if (problem) throw new HttpError(400, problem);
  addressFree(input.email!);
  const persona = personas.create({ name: input.name!, email: input.email! });
  appEvents.publish({ type: "persona", persona });
  return c.json(persona, 201);
});

api.patch("/personas/:id", async (c) => {
  const persona = found(personas.get(c.req.param("id")), "Persona not found.");
  const patch = await body<PersonaPatch>(c);
  const problem = validatePersona(patch, false);
  if (problem) throw new HttpError(400, problem);
  const email = patch.email?.trim().toLowerCase();
  if (email && email !== persona.email && persona.mailbox.state !== "not-connected") {
    throw new HttpError(400, "Disconnect the mailbox before changing the persona's address.");
  }
  if (email) addressFree(email, persona.id);
  if (patch.defaultAgentId && !agents.get(patch.defaultAgentId)) throw new HttpError(404, "Agent not found.");
  if (patch.avatarId) {
    const image = found(uploads.get(patch.avatarId), "Picture not found; upload it first.");
    if (!INLINE_TYPES.has(image.mimeType)) throw new HttpError(400, "The picture must be a PNG, JPEG, GIF or WebP image.");
    if (image.size > MAX_AVATAR_BYTES) throw new HttpError(400, "The picture can be at most 5 MB.");
  }
  const updated = found(
    personas.update(persona.id, {
      name: patch.name,
      email,
      avatarId: patch.avatarId,
      allowedSenders: patch.allowedSenders && [...new Set(patch.allowedSenders.map((sender) => sender.trim().toLowerCase()))],
      defaultAgentId: patch.defaultAgentId,
    }),
  );
  appEvents.publish({ type: "persona", persona: updated });
  return c.json(updated);
});

api.delete("/personas/:id", async (c) => {
  const persona = found(personas.get(c.req.param("id")), "Persona not found.");
  await mailboxes.disconnect(persona.id);
  personaGitHub.disconnect(persona.id);
  personas.delete(persona.id);
  // Its agents go back to the user's GitHub connection, if any.
  void refreshGitHubLogins();
  for (const agentId of persona.agentIds) appEvents.agentChanged(agentId);
  appEvents.publish({ type: "persona-deleted", personaId: persona.id });
  return c.json({ ok: true });
});

api.put("/personas/:id/mailbox", async (c) => {
  const persona = found(personas.get(c.req.param("id")), "Persona not found.");
  return c.json(await mailboxes.connect(persona.id, await body<Partial<MailboxConnectRequest>>(c)));
});

api.delete("/personas/:id/mailbox", async (c) => {
  const persona = found(personas.get(c.req.param("id")), "Persona not found.");
  await mailboxes.disconnect(persona.id);
  return c.json(personas.get(persona.id));
});

api.post("/personas/:id/mailbox/refresh", async (c) => {
  const persona = found(personas.get(c.req.param("id")), "Persona not found.");
  await mailboxes.refresh(persona.id);
  return c.json(personas.get(persona.id));
});

// Agents working as the persona switch accounts: their computers are updated now rather than on next use.
api.put("/personas/:id/github", async (c) => {
  const persona = found(personas.get(c.req.param("id")), "Persona not found.");
  const { token } = await body<Partial<PersonaGitHubConnectRequest>>(c);
  const updated = await personaGitHub.connect(persona.id, token);
  void refreshGitHubLogins();
  return c.json(updated);
});

api.patch("/personas/:id/github", async (c) => {
  const persona = found(personas.get(c.req.param("id")), "Persona not found.");
  const { allowWrites } = await body<{ allowWrites?: unknown }>(c);
  if (typeof allowWrites !== "boolean") throw new HttpError(400, "Expected { allowWrites: true | false }.");
  const updated = personaGitHub.setAllowWrites(persona.id, allowWrites);
  void refreshGitHubLogins();
  return c.json(updated);
});

api.delete("/personas/:id/github", (c) => {
  const persona = found(personas.get(c.req.param("id")), "Persona not found.");
  const updated = personaGitHub.disconnect(persona.id);
  void refreshGitHubLogins();
  return c.json(updated);
});

api.get("/personas/:id/mail", (c) => {
  const persona = found(personas.get(c.req.param("id")), "Persona not found.");
  const limit = Number(c.req.query("limit") ?? 50);
  return c.json(mail.list(persona.id, { q: c.req.query("q"), limit: Number.isFinite(limit) ? limit : 50 }).map(toSummary));
});

api.get("/personas/:id/mail/:mailId", (c) => {
  const persona = found(personas.get(c.req.param("id")), "Persona not found.");
  const stored = found(mail.get(persona.id, c.req.param("mailId")), "Email not found.");
  mailboxes.markRead(persona.id, stored);
  return c.json(toMailMessage({ ...stored, unread: false }));
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
  if (patch.tasks) {
    const limit = (value: unknown, max: number, what: string) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > max) throw new HttpError(400, `${what} must be between 1 and ${max}.`);
      return n;
    };
    const { perAgentLimit, globalLimit, resumeInterrupted, notifySlackUserId, switchProviders, maxChildren, wakeChats, worktreeCleanupDays } = patch.tasks;
    const cleanupDays = Number(worktreeCleanupDays);
    if (worktreeCleanupDays !== undefined && (!Number.isInteger(cleanupDays) || cleanupDays < 0 || cleanupDays > 365)) {
      throw new HttpError(400, "Worktree cleanup must be between 0 (never) and 365 days.");
    }
    patch.tasks = {
      ...(perAgentLimit !== undefined ? { perAgentLimit: limit(perAgentLimit, 10, "Tasks per agent") } : {}),
      ...(globalLimit !== undefined ? { globalLimit: limit(globalLimit, 20, "Tasks at once") } : {}),
      ...(maxChildren !== undefined ? { maxChildren: limit(maxChildren, 20, "Tasks one chat or task can start") } : {}),
      ...(worktreeCleanupDays !== undefined ? { worktreeCleanupDays: cleanupDays } : {}),
      ...(typeof resumeInterrupted === "boolean" ? { resumeInterrupted } : {}),
      ...(typeof switchProviders === "boolean" ? { switchProviders } : {}),
      ...(typeof wakeChats === "boolean" ? { wakeChats } : {}),
      ...(notifySlackUserId === null || (typeof notifySlackUserId === "string" && /^[A-Z0-9]+$/.test(notifySlackUserId)) ? { notifySlackUserId } : {}),
    };
  }
  if (patch.models) {
    const tiers = ["fast", "standard", "deep"];
    const { tiers: tierModels, roles } = patch.models;
    for (const [tier, byProvider] of Object.entries(tierModels ?? {})) {
      if (!tiers.includes(tier) || !byProvider || typeof byProvider !== "object") throw new HttpError(400, `Unknown tier "${tier}".`);
      for (const [provider, model] of Object.entries(byProvider)) {
        if ((provider !== "claude" && provider !== "chatgpt") || (model !== null && (typeof model !== "string" || model.length > 100))) {
          throw new HttpError(400, "Pick a model id (or null for TOT's default) per tier and provider.");
        }
      }
    }
    for (const [role, tier] of Object.entries(roles ?? {})) {
      if (!["explorer", "planner", "implementer", "tester", "reviewer", "researcher", "writer"].includes(role) || !tiers.includes(tier as string)) {
        throw new HttpError(400, `Unknown role or tier: ${role} → ${tier}.`);
      }
    }
  }
  // Memory repo (module 10): Dreaming's time and the backup remote's URL.
  checkMemorySettings(patch.memory);
  const next = settings.patch(patch);
  memorySettingsChanged(patch.memory);
  // New limits may free up slots for queued tasks.
  if (patch.tasks) taskQueue.pump();
  // Auth changes alter provider status; don't serve a stale cached one.
  if (patch.claude || patch.anthropicApiKey !== undefined) void providerStatuses(true);
  // Which account Auto and tasks use shows on the accounts list.
  if (patch.models?.accounts) void accountStatuses(true);
  return c.json(next);
});

// ---------------------------------------------------------------------------
// Trust gates & playbooks (module 03): repo profiles, checks, reviews, playbooks
// ---------------------------------------------------------------------------

api.route("/", trustRoutes);
