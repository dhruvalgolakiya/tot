import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Message, MessagePart, MessageStatus, ProviderId, SendMessageRequest, SendMessageResponse, Tier, TurnErrorKind } from "@tot/shared/types";
import { appEvents } from "../app-events.ts";
import { apps } from "../apps.ts";
import { GITHUB_MCP_URL, INTERNAL_BASE_URL, MCP_TOKEN, paths } from "../config.ts";
import { agents } from "../data/agents.ts";
import { brains } from "../data/brains.ts";
import { CUT_OFF_BY_RESTART } from "../db.ts";
import { attachedNote, cleanContextChats } from "../chats/attach.ts";
import { forks } from "../chats/fork.ts";
import { chatQueue } from "../chats/queue.ts";
import { chatWorkspaces } from "../chats/workspace.ts";
import { chatSearch } from "../data/chat-search.ts";
import { conversations, toPublicConversation, type ConversationRecord } from "../data/conversations.ts";
import { messages } from "../data/messages.ts";
import { personas } from "../data/personas.ts";
import { plugins } from "../data/plugins.ts";
import { settings as settingsStore } from "../data/settings.ts";
import { toAttachment, uploads, type UploadRecord } from "../data/uploads.ts";
import { wiki } from "../data/wiki.ts";
import { bus } from "../events.ts";
import { chatTasksSection, childResultsNote, taskSection } from "../tasks/prompt.ts";
import { githubAccessFor, personaGitHub } from "../persona-github.ts";
import { prepareAttachments } from "./attachments.ts";
import { makeElicitor } from "./approvals.ts";
import { brainHints } from "./brain-hints.ts";
import { contextMessages, selectContext, SWITCH_BUDGET } from "./context-select.ts";
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
import { providerFor, providerStatuses, providers, routingStatuses } from "./providers/index.ts";
import type { McpServerSpec, TurnInput } from "./providers/types.ts";
import { ReplySaver } from "./reply-saver.ts";
import { CLAUDE_SONNET, parseModelId, resolveRoute, type Complexity, type Route } from "./router.ts";
import { runRegistry, type Run } from "./runs.ts";
import { intake } from "../projects/intake.ts";
import { projects } from "../projects/projects.ts";
import { deviceSection } from "../devices/prompt.ts";
import { projectList, projectNote, projectSection } from "../projects/prompt.ts";
import { leadNote, leadSection } from "../lead/prompt.ts";
import { leadSession } from "../lead/session.ts";
import { leadSignals } from "../signals/store.ts";
import { promptMemory } from "../memory/prompt.ts";
import { skillBlock, skills, slashSkill, type SkillRecord } from "../skills/skills.ts";

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
    readonly kind?: TurnErrorKind,
  ) {
    super(message);
  }
}

const MAX_ATTACHMENTS = 10;

/** Chats with a turn being set up: past the "already replying?" check, before the run exists. */
const starting = new Set<string>();
/** How long the end of a turn may wait for the chat title to land. */
const TITLE_GRACE_MS = 1500;

/**
 * After an account hits its usage limit: another enabled, signed-in account of the same provider that isn't at its
 * limit too, on the same model when it offers it (else its first one). Null when there's none.
 */
export function sameProviderFallback(
  route: Route,
  statuses: { id: ProviderId; accountId?: string; loggedIn: boolean; label: string; models: { model: string; available: boolean }[] }[],
  limited: ReadonlySet<string>,
): { ok: true; route: Route } | null {
  for (const status of statuses) {
    const account = status.accountId ?? status.id;
    if (status.id !== route.provider || account === route.account || !status.loggedIn || limited.has(account)) continue;
    const available = status.models.filter((m) => m.available);
    const model = available.find((m) => m.model === route.model)?.model ?? available[0]?.model;
    if (!model) continue;
    return { ok: true, route: { ...route, account, model, reason: `${route.reason} · ${status.label} (the other account was at its limit)` } };
  }
  return null;
}

/** A skill a message invoked: its SKILL.md for this turn's prompt, and the message's text without the "/name". */
export interface InvokedSkill {
  skill: Pick<SkillRecord, "name" | "dir">;
  body: string;
  text: string;
}

/**
 * The skill a message invokes: the one the composer sent, else a known skill its text starts with ("/dh-stack …", so
 * mobile and Slack need nothing new). A "/word" that isn't a skill is an ordinary message; a skill the composer sent
 * that's gone is an error.
 */
export function invokedSkill(requested: string | undefined, text: string): InvokedSkill | null {
  const typed = slashSkill(text);
  const asked = requested?.trim();
  const name = asked || typed?.name;
  if (!name) return null;
  const skill = skills.find(name);
  if (!skill) {
    if (asked) throw new HttpError(400, `There's no skill called “${asked}” on this computer.`);
    return null;
  }
  let body: string;
  try {
    body = skills.body(skill);
  } catch {
    throw new HttpError(400, `The skill “${skill.name}” couldn't be read.`);
  }
  // The "/name" in front goes when it names this skill; any other text stays as it is.
  const rest = typed && skills.find(typed.name)?.name === skill.name ? typed.rest : text;
  return { skill: { name: skill.name, dir: skill.dir }, body, text: rest };
}

/** Server-side extras for a turn (not part of the public API). */
export interface TurnOptions {
  /** Instructions put before the user's text for the model only (e.g. for routine runs). */
  preamble?: string;
  /** The chat was created with a meaningful title; don't replace it with a generated one. */
  keepTitle?: boolean;
  /** Heavy work whatever the text looks like (Auto then picks the strongest model); the reason is shown. */
  heavy?: string;
  /**
   * Start a new provider session without the chat's transcript, for multi-step jobs that keep
   * their state elsewhere (e.g. the wiki), so each step begins with a clean context.
   */
  freshSession?: boolean;
  /** Raise the per-turn step cap for long jobs. */
  maxSteps?: number;
  /** TOT wrote the user message itself to keep a task going (shown as a quiet divider). */
  auto?: boolean;
  /** Auto only: the model tier (e.g. a task's role); see orchestration/tiers.ts. */
  tier?: Tier;
  /** Auto only: the provider to run on when it can (a reviewer on the other provider, a switch after a limit). */
  prefer?: ProviderId | null;
  /** A Lead's wake (module 12): the signals its preamble carries, new to the model though already marked read. */
  signalIds?: string[];
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
  if (!text && !attachments.length && !request.skill?.trim()) throw new HttpError(400, "Message is empty.");
  if (runRegistry.activeFor(conversationId) || starting.has(conversationId)) {
    throw new HttpError(409, `${agents.get(conversation.agentId)?.name ?? "TOT"} is still replying in this chat.`);
  }
  const contextChats = cleanContextChats(request.contextChats, conversation);
  // A skill this message invokes: its SKILL.md goes into this turn's prompt only. TOT's own turns never invoke one.
  const invoked = options.auto ? null : invokedSkill(request.skill, text);
  // What the model gets as the user's words: the text without the "/name" in front.
  const said = invoked ? invoked.text : text;

  const modelId = request.modelId ?? conversation.modelId;
  // Held from here until the run exists (no await after this one), so two messages can't both start a turn.
  starting.add(conversationId);
  let statuses: Awaited<ReturnType<typeof providerStatuses>>;
  let accountStatuses: Awaited<ReturnType<typeof routingStatuses>>;
  try {
    [statuses, accountStatuses] = await Promise.all([providerStatuses(), routingStatuses()]);
  } finally {
    starting.delete(conversationId);
  }
  const routingText = said || text || attachments.map((file) => file.name).join(", ");
  const complexity = options.heavy ? ({ complex: true, why: options.heavy } as const) : undefined;
  const result = resolveRoute(modelId, routingText, {
    thinkHarder: request.thinkHarder,
    statuses,
    accounts: accountStatuses,
    limited: limits.active(),
    complexity,
    tier: options.tier,
    prefer: options.prefer,
  });
  if (!result.ok) throw new HttpError(400, result.error);
  const route = result.route;

  const history = messages.listByConversation(conversationId);
  // A project's Lead whose conversation got long carries on in a fresh session from the project's state (module 12).
  const fresh = options.freshSession ? null : leadSession.freshStart(conversation, history, Date.now(), options.signalIds);
  // A new chat's first message: a ticket link in it sets the chat's origin, and may file it (module 06).
  const filed = options.auto || history.some((m) => m.role === "user") ? null : intake.firstMessage(conversation, text);
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
    ...(options.auto ? { auto: true } : {}),
    ...(contextChats.length ? { contextChats } : {}),
    ...(invoked ? { skill: invoked.skill.name } : {}),
    createdAt: now,
  };
  const assistant: Message = {
    id: randomUUID(),
    conversationId,
    role: "assistant",
    parts: [],
    status: "streaming",
    provider: route.provider,
    account: route.account,
    model: route.model,
    routeReason: route.reason,
    createdAt: now + 1,
  };
  messages.insert(userMessage);
  messages.insert(assistant);

  // Routine (and other pre-named) chats, and a project's Lead, keep their names, so they skip auto-titling. (A chat
  // filed on arrival starts with its "Filed under" notice, so it's the first user message that counts.)
  const isFirstTurn = !history.some((m) => m.role === "user") && !conversation.routineId && !options.keepTitle && !conversation.lead;
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
    text: said,
    skill: invoked ?? undefined,
    route,
    history,
    attachments,
    contextChats,
    preamble: [fresh?.preamble, options.preamble].filter(Boolean).join("\n\n") || undefined,
    autoTitle: isFirstTurn,
    auto: parseModelId(modelId) === "auto",
    complexity,
    tier: options.tier,
    thinkHarder: Boolean(request.thinkHarder),
    freshSession: Boolean(options.freshSession || fresh),
    notice: fresh?.notice,
    maxSteps: options.maxSteps,
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
  // The reply has started by now (executeTurn sets it up before its first await): "Filed under …" goes in it.
  if (filed) intake.notice(conversationId, filed);
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
  /** The skill the message invoked: its SKILL.md comes before the user's text, this turn only. */
  skill?: InvokedSkill;
  /** Chats attached to the message as reference. */
  contextChats: string[];
  preamble?: string;
  autoTitle: boolean;
  /** Routed by TOT Auto, so a usage limit may move the turn to the other provider. */
  auto: boolean;
  /** Set when the caller marked the turn as heavy work; a fallback route keeps it. */
  complexity?: Complexity;
  /** The tier asked for, which a fallback route keeps too. */
  tier?: Tier;
  thinkHarder: boolean;
  freshSession: boolean;
  /** A note for the user at the top of the reply (a Lead starting a fresh session). */
  notice?: string;
  maxSteps?: number;
}

async function executeTurn(ctx: TurnContext): Promise<void> {
  const { run, conversation, assistant, history } = ctx;
  const builder = new MessageBuilder(assistant, (event) => run.push(event));
  // Tools that need the user's OK pause the turn and show a card; routine runs and tasks wait longer.
  const elicit = makeElicitor({
    run,
    builder,
    agentId: conversation.agentId,
    unattended: Boolean(conversation.routineId) || conversation.kind === "task",
  });
  const signal = run.controller.signal;
  // Saves as it streams, rarer as the reply grows and only after changes; the final save below always runs. Never
  // after the run ended (a turn that crashed is saved as failed by sendMessage's catch).
  const saver = new ReplySaver(() => (run.done ? 0 : messages.save(builder.message)));
  run.reply = () => builder.message;
  run.addPart = (part) => {
    builder.add(part);
    saver.saveNow();
  };
  run.replacePart = (part) => {
    builder.replace(part);
    saver.saveNow();
  };

  run.push({
    type: "run-start",
    runId: run.id,
    conversationId: conversation.id,
    messageId: assistant.id,
    provider: ctx.route.provider,
    model: ctx.route.model,
    routeReason: ctx.route.reason,
  });
  if (ctx.notice) builder.notice("info", ctx.notice);
  const unsubscribe = bus.subscribe(conversation.agentId, (event) => run.push(event));
  const title = ctx.autoTitle
    ? generateTitle(conversation.id, ctx.text || ctx.attachments.map((f) => f.name).join(", ") || (ctx.skill?.skill.name ?? ""), run)
    : null;

  let route = ctx.route;
  let status: MessageStatus = "complete";
  let error: string | undefined;
  let errorKind: TurnErrorKind | undefined;
  // Where this reply ends up in its provider session, so a fork can start there.
  const place: { session?: string; ref?: string } = {};

  // A Lead's signals this turn's note carries (module 12): unread again if the model never answered.
  const heardSignals: string[] = [];
  try {
    // A chat working in its own worktree has it made on its first turn (chats/workspace.ts), before its prompt
    // says where it is; a problem shows here and the turn goes on.
    const workspace = await chatWorkspaces.prepare(conversation, ctx.text);
    if (workspace.chat.workspace !== conversation.workspace) conversation.workspace = workspace.chat.workspace;
    if (workspace.notice) builder.notice("warning", workspace.notice);
    if (workspace.note) ctx.preamble = [workspace.note, ctx.preamble].filter(Boolean).join("\n\n");
    const { text, images, systemPrompt } = await prepareTurn(ctx, heardSignals);

    // As much of the conversation as fits a new model's budget, with a pointer to the rest.
    const withTranscript = () =>
      transcriptPreamble(
        selectContext(contextMessages(history), { budgetTokens: SWITCH_BUDGET, chatId: conversation.id }).text,
        text,
        conversation.forkedFrom && !conversation.provider ? "This chat is a fork of another one, picking up from where it branched off." : undefined,
      );

    /** Turn input for a route: resume the provider's session when this chat already has one. */
    const inputFor = (route: Route, fresh = false): TurnInput => {
      // A session lives in its account's folder: only the same account (of the same provider) can resume it.
      const sameAccount = conversation.provider === route.provider && (conversation.providerAccount ?? conversation.provider) === route.account;
      const resumable = !fresh && !ctx.freshSession && sameAccount && conversation.providerSessionId;
      // A fork's first turn continues a copy of the source's session when this account wrote the reply it was forked at.
      const fork = !fresh && !ctx.freshSession ? forks.nativeStart(conversation, route.account) : null;
      // A different provider can't resume the old session (nor a fork's copy another's): carry the transcript over instead.
      const needsTranscript = !resumable && !fork && !ctx.freshSession && (conversation.provider !== null || conversation.forkedFrom !== null);
      return {
        conversationId: conversation.id,
        prompt: needsTranscript || fresh ? withTranscript() : text,
        images,
        model: route.model,
        effort: route.effort,
        sessionId: resumable ? conversation.providerSessionId! : undefined,
        ...(fork ? { fork } : {}),
        systemPrompt,
        mcpServers: mcpServersFor(conversation, route.provider),
        workDir: paths.agentHome,
        signal,
        elicit,
        maxSteps: ctx.maxSteps,
        // Turns take notes mid-turn when the provider supports it: the user's notes to a task (tasks/steer.ts),
        // and a chat's tasks' results (tasks/wake.ts).
        onSteerable: (deliver) => void (run.steer = deliver),
      };
    };

    const attempt = async (route: Route, input: TurnInput): Promise<void> => {
      for await (const event of providerFor(route.account).runTurn(input)) {
        if (event.type === "session") {
          // Kept in memory too: a fallback to another account of this provider must not try to resume it.
          Object.assign(conversation, { provider: route.provider, providerAccount: route.account, providerSessionId: event.sessionId });
          conversations.update(conversation.id, { provider: route.provider, providerAccount: route.account, providerSessionId: event.sessionId });
          place.session = event.sessionId;
          continue;
        }
        if (event.type === "ref") {
          place.ref = event.ref;
          continue;
        }
        if (event.type === "error") throw new TurnError(event.message, event.kind);
        builder.apply(event);
        saver.changed();
      }
    };

    try {
      await attempt(route, inputFor(route));
    } catch (err) {
      // A limit counts even when it hits mid-reply: Auto avoids the account, and a task's failover sees it.
      if (err instanceof TurnError && err.kind === "limit" && !signal.aborted) limits.mark(route.account, err.message);
      if (signal.aborted || builder.hasContent) throw err;

      if (err instanceof TurnError && err.kind === "limit") {
        // Another signed-in account of the same provider comes first (same model, its own plan), then under Auto
        // the other provider, as before accounts.
        const accountsNow = await routingStatuses();
        const fallback = sameProviderFallback(route, accountsNow, limits.active()) ??
          (ctx.auto
            ? resolveRoute("auto", text, {
                thinkHarder: ctx.thinkHarder,
                statuses: await providerStatuses(),
                accounts: accountsNow,
                limited: limits.active(),
                complexity: ctx.complexity,
                tier: ctx.tier,
              })
            : null);
        if (!fallback?.ok || fallback.route.account === route.account) throw err;
        const from = providerFor(route.account).label;
        route = fallback.route;
        const reset = /resets [^.]*/i.exec(err.message)?.[0];
        builder.notice("warning", `${from} is at its usage limit${reset ? ` (${reset})` : ""} — switched to ${providerFor(route.account).label}.`);
        Object.assign(assistant, { provider: route.provider, account: route.account, model: route.model, routeReason: route.reason });
        await attempt(route, inputFor(route));
      } else if (inputFor(route).sessionId || inputFor(route).fork) {
        // A session that can't be resumed or forked (deleted transcript, expired thread) shouldn't
        // kill the chat: start a fresh session seeded with the transcript, once.
        console.warn(`[tot] resume failed for ${conversation.id}, starting a fresh session:`, err);
        await attempt(route, inputFor(route, true));
      } else {
        throw err;
      }
    }
    limits.clear(route.account);
  } catch (err) {
    status = "error";
    error = err instanceof Error ? err.message : String(err);
    errorKind = err instanceof TurnError ? err.kind : undefined;
  }
  if (signal.aborted) {
    // Stopped to hand the task a steering note: what it did so far stands as a finished reply.
    status = run.stopReason === "steer" ? "complete" : "stopped";
    error = undefined;
  }

  if (status !== "complete" && heardSignals.length && !builder.hasContent) leadSignals.markUnread(heardSignals);
  unsubscribe();
  run.steer = undefined;
  saver.stop();
  const final = builder.finish(status, error);
  messages.save(final);
  if (place.session && place.ref) messages.setProviderRef(final.id, { session: place.session, ref: place.ref });
  if (title) await Promise.race([title, sleep(TITLE_GRACE_MS)]);
  const touched = conversations.update(conversation.id, {}, true);
  run.push({ type: "run-end", status, message: final, ...(status === "error" && errorKind ? { errorKind } : {}) });
  runRegistry.finish(run);
  if (touched) appEvents.publish({ type: "conversation", conversation: toPublicConversation(touched) });
  appEvents.publish({ type: "run", runId: run.id, conversationId: conversation.id, agentId: conversation.agentId, status });
  chatQueue.afterTurn(conversation.id, status);
}

/** The model-facing prompt (attachments folded in) and the chat's system prompt, frozen on first use. */
async function prepareTurn(ctx: TurnContext, heardSignals: string[] = []): Promise<{ text: string; images: TurnInput["images"]; systemPrompt: string }> {
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
  // Brains this message is about (its repo, URL, @name…) that the chat hasn't been shown yet.
  const brainNote = ctx.text ? brainHints(conversation.agentId, conversation.id, ctx.text) : "";
  // Results of tasks this chat started that finished since its model last heard, and what its forks brought back.
  const tasksNote = childResultsNote(conversation, heardSignals);
  const mergeNote = forks.takeNotes(conversation);
  // Chats the user attached to this message, as reference.
  const attached = attachedNote(ctx.contextChats);
  // A chat's last reply cut off by a restart: said once, on the next turn (tasks hear it from their loop).
  const lastReply = ctx.history.findLast((m) => m.role === "assistant" && m.parts.some((part) => part.type !== "notice"));
  const restartNote =
    conversation.kind !== "task" && lastReply?.status === "stopped" && lastReply.error === CUT_OFF_BY_RESTART
      ? "[TOT restarted during your last reply, so it was cut off. Check where things stand before you carry on.]"
      : "";
  // The chat's project (module 06), or for a chat in none the list of projects so its agent can file it:
  // a chat moved in or out since its prompt was frozen hears about it once.
  const project = projects.get(conversation.projectId);
  const section = project
    ? projectSection(project, { inTask: conversation.kind === "task", workspace: conversation.kind === "task" ? null : conversation.workspace })
    : conversation.kind === "chat"
      ? projectList()
      : null;
  const moved = projectNote(conversation.systemPrompt, section);
  if (moved.prompt !== null) conversations.update(conversation.id, { systemPrompt: moved.prompt });
  // A project's Lead (module 11): its section follows the project's repos; a change is said once.
  const lead = leadNote(conversation, project, moved.prompt ?? conversation.systemPrompt);
  if (lead.prompt !== null) conversations.update(conversation.id, { systemPrompt: lead.prompt });
  // A skill the message invoked comes right before the user's words (all of them when they only typed "/name").
  const skill = ctx.skill ? skillBlock(ctx.skill.skill, ctx.skill.body) : "";
  const said = ctx.text || (ctx.skill ? "Run the skill." : "");
  const text =
    [restartNote, githubNote, personaNote(conversation.systemPrompt, personaAccess), moved.note, lead.note, brainNote, tasksNote, mergeNote, ctx.preamble, attached, prepared.context, skill, said]
      .filter(Boolean)
      .join("\n\n") ||
    "The user sent the attached image(s) without a message. Take a look and respond helpfully.";

  let systemPrompt = lead.prompt ?? moved.prompt ?? conversation.systemPrompt;
  if (!systemPrompt) {
    const settings = settingsStore.get();
    const agent = agents.get(conversation.agentId) ?? agents.first();
    let workspace: WorkspaceContext | null = null;
    if (settings.memory.enabled) {
      const mine = brains.forAgent(agent.id);
      const notebook = mine[0];
      workspace = {
        // Memory repo (module 10): you/MEMORY.md, the project's MEMORY.md, and entries related to the message.
        memory: promptMemory(conversation.projectId, ctx.text || text),
        wiki: {
          // A project's brain carries its folder, so its card says where the files are (module 06).
          brains: mine.map((brain) => {
            const project = projects.forBrain(brain.id);
            return project ? { ...brain, folder: projects.folder(project) } : brain;
          }),
          overview: wiki.overview(notebook.id),
          outline: wiki.outline(notebook.id).filter((page) => !page.pinned),
          relevant: wiki.relevant(
            mine.map((brain) => brain.id),
            ctx.text,
            3,
          ),
        },
        recentChats: chatSearch.recent(agent.id, { exclude: conversation.id }),
      };
    }
    systemPrompt = buildSystemPrompt({
      settings,
      workspace,
      agent,
      github: access,
      apps: apps.running,
      persona: personaAccess,
      // A task is told its goal and where to work; a chat, when to start tasks.
      tasks: conversation.kind === "task" && conversation.task ? taskSection(conversation.task, conversation.id) : chatTasksSection(),
      project: section,
      lead: conversation.lead && project ? leadSection(project) : null,
      device: deviceSection(),
    });
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

export function mcpServersFor(conversation: Pick<ConversationRecord, "id" | "agentId"> & { lead?: boolean }, provider: ProviderId): McpServerSpec[] {
  // A chat that invoked a skill also gets skill_read; marking its URL changes a loaded Codex thread's config, so the
  // thread is resumed with the tool (Claude Code lists tools afresh every turn).
  const withSkills = messages.skillsUsed(conversation.id).length > 0;
  const tot: McpServerSpec = {
    name: "tot",
    type: "http",
    url: `${INTERNAL_BASE_URL}/mcp/${conversation.id}${withSkills ? "?skills=1" : ""}`,
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
  // A project's Lead (module 12) never writes to GitHub on its own: pushing and landing go through its cards.
  const writes = Boolean(who?.allowWrites) && !conversation.lead;
  const githubServer: McpServerSpec[] =
    who && !extra.some((spec) => spec.name.toLowerCase() === "github")
      ? [
          {
            name: "github",
            type: "http",
            url: `${GITHUB_MCP_URL}/${writes ? "" : "readonly"}`,
            headers: { Authorization: `Bearer ${who.token}`, ...(writes ? {} : { "X-MCP-Readonly": "true" }) },
            ...(writes ? { disabledTools: GITHUB_BLOCKED_TOOLS } : {}),
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
