import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Message, MessagePart, MessageStatus, ProviderId, SendMessageRequest, SendMessageResponse } from "../../shared/types.ts";
import { appEvents } from "../app-events.ts";
import { apps } from "../apps.ts";
import { GITHUB_MCP_URL, INTERNAL_BASE_URL, MCP_TOKEN, paths } from "../config.ts";
import { agents } from "../data/agents.ts";
import { chatSearch } from "../data/chat-search.ts";
import { conversations, toPublicConversation, type ConversationRecord } from "../data/conversations.ts";
import { memories } from "../data/memories.ts";
import { messageText, messages } from "../data/messages.ts";
import { personas } from "../data/personas.ts";
import { plugins } from "../data/plugins.ts";
import { settings as settingsStore } from "../data/settings.ts";
import { toAttachment, uploads, type UploadRecord } from "../data/uploads.ts";
import { wiki } from "../data/wiki.ts";
import { bus } from "../events.ts";
import { githubAccessFor, personaGitHub } from "../persona-github.ts";
import { prepareAttachments } from "./attachments.ts";
import { makeElicitor } from "./approvals.ts";
import { limits } from "./limits.ts";
import { MessageBuilder } from "./message-builder.ts";
import {
  buildSystemPrompt,
  githubSection,
  githubStateLine,
  personaNote,
  transcriptPreamble,
  type GitHubAccess,
  type PersonaAccess,
  type WorkspaceContext,
} from "./prompts.ts";
import { providerStatuses, providers } from "./providers/index.ts";
import type { McpServerSpec, TurnInput } from "./providers/types.ts";
import { CLAUDE_SONNET, parseModelId, resolveRoute, type Complexity, type Route } from "./router.ts";
import { runRegistry, type Run } from "./runs.ts";

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 500,
    message: string,
  ) {
    super(message);
  }
}

/** A provider's fatal `error` event, carried out of the stream loop. */
class TurnError extends Error {
  constructor(
    message: string,
    readonly kind?: "limit" | "auth",
  ) {
    super(message);
  }
}

const SAVE_INTERVAL_MS = 1000;
const MAX_ATTACHMENTS = 10;
/** How long the end of a turn may wait for the chat title to land. */
const TITLE_GRACE_MS = 1500;

/** Server-side extras for a turn (not part of the public API). */
export interface TurnOptions {
  /** Instructions put before the user's text for the model only (e.g. for routine runs). */
  preamble?: string;
  /** The chat was created with a meaningful title; don't replace it with a generated one. */
  keepTitle?: boolean;
  /** Heavy work whatever the text looks like (Auto then picks the strongest model); the reason is shown. */
  heavy?: string;
}

export async function sendMessage(
  conversationId: string,
  request: SendMessageRequest,
  options: TurnOptions = {},
): Promise<SendMessageResponse> {
  const conversation = conversations.get(conversationId);
  if (!conversation) throw new HttpError(404, "Chat not found.");
  const files = (request.attachments ?? []).map((id) => uploads.get(id) ?? null);
  if (files.includes(null)) throw new HttpError(400, "An attachment couldn't be found. Try attaching it again.");
  if (files.length > MAX_ATTACHMENTS) throw new HttpError(400, `You can attach up to ${MAX_ATTACHMENTS} files per message.`);
  const attachments = files as UploadRecord[];
  const text = request.text?.trim() ?? "";
  if (!text && !attachments.length) throw new HttpError(400, "Message is empty.");
  if (runRegistry.activeFor(conversationId)) {
    throw new HttpError(409, `${agents.get(conversation.agentId)?.name ?? "TOT"} is still replying in this chat.`);
  }

  const modelId = request.modelId ?? conversation.modelId;
  const statuses = await providerStatuses();
  const routingText = text || attachments.map((file) => file.name).join(", ");
  const complexity = options.heavy ? ({ complex: true, why: options.heavy } as const) : undefined;
  const result = resolveRoute(modelId, routingText, { thinkHarder: request.thinkHarder, statuses, limited: limits.active(), complexity });
  if (!result.ok) throw new HttpError(400, result.error);
  const route = result.route;

  const history = messages.listByConversation(conversationId);
  const now = Date.now();
  const userMessage: Message = {
    id: randomUUID(),
    conversationId,
    role: "user",
    parts: [
      ...attachments.map((file): MessagePart => ({ type: "file", id: randomUUID(), attachment: toAttachment(file) })),
      ...(text ? [{ type: "text" as const, id: randomUUID(), text }] : []),
    ],
    status: "complete",
    createdAt: now,
  };
  const assistant: Message = {
    id: randomUUID(),
    conversationId,
    role: "assistant",
    parts: [],
    status: "streaming",
    provider: route.provider,
    model: route.model,
    routeReason: route.reason,
    createdAt: now + 1,
  };
  messages.insert(userMessage);
  messages.insert(assistant);

  // Routine (and other pre-named) chats keep their names, so they skip auto-titling.
  const isFirstTurn = history.length === 0 && !conversation.routineId && !options.keepTitle;
  const updated = conversations.update(
    conversationId,
    { modelId, ...(isFirstTurn ? { title: quickTitle(routingText) } : {}) },
    true,
  )!;

  const run = runRegistry.create(conversationId, assistant.id);
  appEvents.publish({ type: "conversation", conversation: toPublicConversation(updated) });
  appEvents.publish({ type: "run", runId: run.id, conversationId, agentId: updated.agentId, status: "running" });
  executeTurn({
    run,
    conversation: updated,
    assistant,
    text,
    route,
    history,
    attachments,
    preamble: options.preamble,
    autoTitle: isFirstTurn,
    auto: parseModelId(modelId) === "auto",
    complexity,
    thinkHarder: Boolean(request.thinkHarder),
  }).catch((err) => {
    // executeTurn handles provider failures itself; this only catches setup bugs, so the
    // chat still ends cleanly instead of an unhandled rejection taking the server down.
    console.error("[tot] turn crashed:", err);
    const failed: Message = { ...assistant, status: "error", error: err instanceof Error ? err.message : String(err) };
    messages.save(failed);
    run.push({ type: "run-end", status: "error", message: failed });
    runRegistry.finish(run);
    appEvents.publish({ type: "run", runId: run.id, conversationId, agentId: updated.agentId, status: "error" });
  });
  return { runId: run.id, userMessage, conversation: toPublicConversation(updated) };
}

interface TurnContext {
  run: Run;
  conversation: ConversationRecord;
  assistant: Message;
  text: string;
  route: Route;
  history: Message[];
  attachments: UploadRecord[];
  preamble?: string;
  autoTitle: boolean;
  /** Routed by TOT Auto, so a usage limit may move the turn to the other provider. */
  auto: boolean;
  /** Set when the caller marked the turn as heavy work; a fallback route keeps it. */
  complexity?: Complexity;
  thinkHarder: boolean;
}

async function executeTurn(ctx: TurnContext): Promise<void> {
  const { run, conversation, assistant, history } = ctx;
  const builder = new MessageBuilder(assistant, (event) => run.push(event));
  // Tools that need the user's OK pause the turn and show a card; routine runs wait longer.
  const elicit = makeElicitor({ run, builder, agentId: conversation.agentId, unattended: Boolean(conversation.routineId) });
  const signal = run.controller.signal;

  run.push({
    type: "run-start",
    runId: run.id,
    conversationId: conversation.id,
    messageId: assistant.id,
    provider: ctx.route.provider,
    model: ctx.route.model,
    routeReason: ctx.route.reason,
  });
  const unsubscribe = bus.subscribe(conversation.agentId, (event) => run.push(event));
  const title = ctx.autoTitle ? generateTitle(conversation.id, ctx.text || ctx.attachments.map((f) => f.name).join(", "), run) : null;

  let route = ctx.route;
  let status: MessageStatus = "complete";
  let error: string | undefined;

  try {
    const { text, images, systemPrompt } = await prepareTurn(ctx);

    const withTranscript = () =>
      transcriptPreamble(
        history.map((m) => ({ role: m.role, text: messageText(m) })).filter((t) => t.text),
        text,
      );

    /** Turn input for a route: resume the provider's session when this chat already has one. */
    const inputFor = (route: Route, fresh = false): TurnInput => {
      const resumable = !fresh && conversation.provider === route.provider && conversation.providerSessionId;
      // A different provider can't resume the old session: carry the transcript over instead.
      const needsTranscript = !resumable && conversation.provider !== null;
      return {
        conversationId: conversation.id,
        prompt: needsTranscript || fresh ? withTranscript() : text,
        images,
        model: route.model,
        effort: route.effort,
        sessionId: resumable ? conversation.providerSessionId! : undefined,
        systemPrompt,
        mcpServers: mcpServersFor(conversation, route.provider),
        workDir: paths.agentHome,
        signal,
        elicit,
      };
    };

    let lastSave = 0;
    const attempt = async (route: Route, input: TurnInput): Promise<void> => {
      for await (const event of providers[route.provider].runTurn(input)) {
        if (event.type === "session") {
          conversations.update(conversation.id, { provider: route.provider, providerSessionId: event.sessionId });
          continue;
        }
        if (event.type === "error") throw new TurnError(event.message, event.kind);
        builder.apply(event);
        if (Date.now() - lastSave > SAVE_INTERVAL_MS) {
          messages.save(builder.message);
          lastSave = Date.now();
        }
      }
    };

    try {
      await attempt(route, inputFor(route));
    } catch (err) {
      if (signal.aborted || builder.hasContent) throw err;

      if (err instanceof TurnError && err.kind === "limit") {
        limits.mark(route.provider, err.message);
        const fallback = ctx.auto
          ? resolveRoute("auto", text, {
              thinkHarder: ctx.thinkHarder,
              statuses: await providerStatuses(),
              limited: limits.active(),
              complexity: ctx.complexity,
            })
          : null;
        if (!fallback?.ok || fallback.route.provider === route.provider) throw err;
        const from = providers[route.provider].label;
        route = fallback.route;
        const reset = /resets [^.]*/i.exec(err.message)?.[0];
        builder.notice("warning", `${from} is at its usage limit${reset ? ` (${reset})` : ""} — switched to ${providers[route.provider].label}.`);
        Object.assign(assistant, { provider: route.provider, model: route.model, routeReason: route.reason });
        await attempt(route, inputFor(route));
      } else if (inputFor(route).sessionId) {
        // A session that can't be resumed (deleted transcript, expired thread) shouldn't
        // kill the chat: start a fresh session seeded with the transcript, once.
        console.warn(`[tot] resume failed for ${conversation.id}, starting a fresh session:`, err);
        await attempt(route, inputFor(route, true));
      } else {
        throw err;
      }
    }
    limits.clear(route.provider);
  } catch (err) {
    status = "error";
    error = err instanceof Error ? err.message : String(err);
  }
  if (signal.aborted) {
    status = "stopped";
    error = undefined;
  }

  unsubscribe();
  const final = builder.finish(status, error);
  messages.save(final);
  if (title) await Promise.race([title, sleep(TITLE_GRACE_MS)]);
  const touched = conversations.update(conversation.id, {}, true);
  run.push({ type: "run-end", status, message: final });
  runRegistry.finish(run);
  if (touched) appEvents.publish({ type: "conversation", conversation: toPublicConversation(touched) });
  appEvents.publish({ type: "run", runId: run.id, conversationId: conversation.id, agentId: conversation.agentId, status });
}

/** The model-facing prompt (attachments folded in) and the chat's system prompt, frozen on first use. */
async function prepareTurn(ctx: TurnContext): Promise<{ text: string; images: TurnInput["images"]; systemPrompt: string }> {
  const { conversation } = ctx;
  // Attached files: images for the model, small text inline, the rest onto the agent's computer.
  const prepared = await prepareAttachments(ctx.attachments, conversation.agentId);
  // The system prompt is frozen per chat; if the agent's GitHub account was connected or changed since, say so this turn.
  const access = promptGitHubAccess(conversation.agentId);
  const githubNote =
    conversation.systemPrompt && !conversation.systemPrompt.includes(githubStateLine(access))
      ? `[GitHub changed since this chat started; this replaces your earlier GitHub instructions:\n${githubSection(access, settingsStore.get().computer.mode !== "off")}]`
      : "";
  // Likewise for the persona the agent works as (added, changed or removed later).
  const persona = personas.forAgent(conversation.agentId);
  // Notices a persona token GitHub no longer accepts (at most every few minutes), for the persona's settings.
  if (persona?.github) void personaGitHub.check(persona.id);
  const personaAccess: PersonaAccess = persona
    ? { name: persona.name, email: persona.email, mailbox: persona.mailbox.state !== "not-connected" }
    : null;
  const text =
    [githubNote, personaNote(conversation.systemPrompt, personaAccess), ctx.preamble, prepared.context, ctx.text].filter(Boolean).join("\n\n") ||
    "The user sent the attached image(s) without a message. Take a look and respond helpfully.";

  let systemPrompt = conversation.systemPrompt;
  if (!systemPrompt) {
    const settings = settingsStore.get();
    const agent = agents.get(conversation.agentId) ?? agents.first();
    let workspace: WorkspaceContext | null = null;
    if (settings.memory.enabled) {
      workspace = {
        userMemories: memories.forPrompt(text),
        wiki: {
          overview: wiki.overview(agent.id),
          outline: wiki.outline(agent.id).filter((page) => !page.pinned),
          relevant: wiki.relevant(agent.id, ctx.text, 3),
        },
        recentChats: chatSearch.recent(agent.id, { exclude: conversation.id }),
      };
    }
    systemPrompt = buildSystemPrompt({ settings, workspace, agent, github: access, apps: apps.running, persona: personaAccess });
    conversations.update(conversation.id, { systemPrompt });
  }
  return { text, images: prepared.images, systemPrompt };
}

/** What an agent's prompt says about GitHub: the account it uses (and whose it is), and whether it may write. */
export function promptGitHubAccess(agentId: string): GitHubAccess {
  const account = githubAccessFor(agentId);
  if (!account) return null;
  const asPersona = Boolean(personas.idForAgent(agentId));
  return { login: account.login, allowWrites: account.allowWrites, source: account.source, asPersona };
}

export function mcpServersFor(conversation: Pick<ConversationRecord, "id" | "agentId">, provider: ProviderId): McpServerSpec[] {
  const tot: McpServerSpec = {
    name: "tot",
    type: "http",
    url: `${INTERNAL_BASE_URL}/mcp/${conversation.id}`,
    headers: { Authorization: `Bearer ${MCP_TOKEN}` },
  };
  const extra = plugins.enabledFor(provider).map((plugin): McpServerSpec =>
    plugin.config.type === "http"
      ? { name: plugin.name, type: "http", url: plugin.config.url, headers: plugin.config.headers }
      : {
          name: plugin.name,
          type: "stdio",
          command: plugin.config.command,
          args: plugin.config.args,
          env: plugin.config.env,
        },
  );
  // The agent's GitHub account (its persona's own, else the user's), through GitHub's own MCP server: read-only
  // (enforced by GitHub) unless writes are allowed, and even then without tools that merge, delete or commit straight to a branch.
  const who = githubAccessFor(conversation.agentId);
  const githubServer: McpServerSpec[] =
    who && !extra.some((spec) => spec.name.toLowerCase() === "github")
      ? [
          {
            name: "github",
            type: "http",
            url: `${GITHUB_MCP_URL}/${who.allowWrites ? "" : "readonly"}`,
            headers: { Authorization: `Bearer ${who.token}`, ...(who.allowWrites ? {} : { "X-MCP-Readonly": "true" }) },
            ...(who.allowWrites ? { disabledTools: GITHUB_BLOCKED_TOOLS } : {}),
          },
        ]
      : [];
  // The user's apps through Executor, which asks the user (approval cards) before actions that change things.
  const executor = apps.mcpServer();
  const appsServer: McpServerSpec[] =
    executor && !extra.some((spec) => spec.name.toLowerCase() === "apps")
      ? [{ name: "apps", type: "http", url: executor.url, headers: { Authorization: `Bearer ${executor.token}` } }]
      : [];
  return [tot, ...githubServer, ...appsServer, ...extra];
}

/** GitHub tools kept away from agents even when writes are on: they bypass branches and review. */
const GITHUB_BLOCKED_TOOLS = ["merge_pull_request", "delete_file", "create_or_update_file", "push_files", "create_repository", "fork_repository"];

/** Instant placeholder title from the first message; replaced by a model-written one. */
function quickTitle(text: string): string {
  const line =
    text
      .replace(/[`*_#>[\]()]/g, "")
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "New chat";
  if (line.length <= 48) return line;
  const cut = line.slice(0, 48);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : 48)}…`;
}

/** Light task → Sonnet 5.5, or the ChatGPT default when Claude is unavailable or at its limit. */
async function generateTitle(conversationId: string, text: string, run: Run): Promise<void> {
  const prompt = `Write a short title (2-6 words) for a chat that starts with the message below. Reply with the title only: no quotes, no trailing punctuation.\n\n<message>\n${text.slice(0, 2000)}\n</message>`;
  const statuses = await providerStatuses();
  const limited = limits.active();
  const candidates = (["claude", "chatgpt"] as const).filter(
    (id) => statuses.find((s) => s.id === id)?.loggedIn && !limited.has(id),
  );
  for (const id of candidates) {
    try {
      const raw = await providers[id].complete(prompt, {
        model: id === "claude" ? CLAUDE_SONNET : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      const title = raw
        .split("\n")[0]
        .replace(/^["'“”*#\s]+|["'“”*.\s]+$/g, "")
        .slice(0, 80);
      if (!title) continue;
      const updated = conversations.update(conversationId, { title });
      if (updated) {
        const conversation = toPublicConversation(updated);
        run.push({ type: "conversation", conversation });
        appEvents.publish({ type: "conversation", conversation });
      }
      return;
    } catch (err) {
      console.warn(`[tot] title generation via ${id} failed:`, err instanceof Error ? err.message : err);
    }
  }
}
