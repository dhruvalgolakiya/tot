import { EventEmitter } from "node:events";
import { SocketModeClient } from "@slack/socket-mode";
import { LogLevel, WebClient } from "@slack/web-api";
import type { Agent, MessagePart, RunEvent, SlackPerson, SlackPatch, SlackStatus, SlackTokens } from "../shared/types.ts";
import { answerApproval } from "./agent/approvals.ts";
import { HttpError, sendMessage } from "./agent/orchestrator.ts";
import { runRegistry } from "./agent/runs.ts";
import { appEvents } from "./app-events.ts";
import { IS_PROD, LAN, PORT, getSecret, setSecret } from "./config.ts";
import { agents } from "./data/agents.ts";
import { conversations, toPublicConversation } from "./data/conversations.ts";
import { messageText } from "./data/messages.ts";
import { db, parseJson, type Row } from "./db.ts";
import { lanUrls } from "./net.ts";

/**
 * TOT's Slack bot. The user creates a Slack app from TOT's manifest and pastes
 * two tokens; TOT connects over Socket Mode (it opens the connection, so no
 * public URL is needed). A DM or an @mention from an allowed person becomes a
 * turn in a TOT chat tied to that Slack thread: the thread so far is passed as
 * context, the answer is posted back in the thread, and approval requests are
 * Approve/Deny buttons there. Everyone else is recorded as a request to allow.
 */

/** The subset of Slack's Web API the bot uses (WebClient satisfies it; tests pass a fake). */
export interface SlackApi {
  auth: { test(): Promise<{ team?: string; user?: string; user_id?: string }> };
  chat: {
    postMessage(args: Record<string, unknown>): Promise<{ ts?: string }>;
    update(args: Record<string, unknown>): Promise<unknown>;
    getPermalink(args: { channel: string; message_ts: string }): Promise<{ permalink?: string }>;
  };
  conversations: {
    replies(args: { channel: string; ts: string; limit?: number }): Promise<{ messages?: SlackMessage[] }>;
    info(args: { channel: string }): Promise<{ channel?: { name?: string; is_im?: boolean; is_mpim?: boolean } }>;
  };
  users: { info(args: { user: string }): Promise<{ user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } }> };
  reactions: { add(args: Record<string, unknown>): Promise<unknown>; remove(args: Record<string, unknown>): Promise<unknown> };
}

/** A Socket Mode connection: emits Slack events by type, plus "interactive" for button presses. */
export interface SlackSocket extends EventEmitter {
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

interface SlackMessage {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
}

interface Stored {
  defaultAgentId: string | null;
  allowedUsers: SlackPerson[];
  requests: SlackPerson[];
}

interface Thread {
  channel: string;
  threadTs: string;
  conversationId: string;
  userId: string;
  seenTs: string;
}

/** Slack's markdown block holds up to 12,000 characters; longer answers are split. */
const BLOCK_LIMIT = 11_500;
const CONTEXT_CHARS = 20_000;
const REFUSAL_EVERY_MS = 6 * 60 * 60_000;

/** TOT's Slack app: Socket Mode, DMs and mentions, reading threads for context, buttons for approvals. */
export const SLACK_MANIFEST = {
  display_information: {
    name: "TOT",
    description: "Message your TOT agents from Slack.",
    background_color: "#1f1b2e",
  },
  features: {
    app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: "TOT", always_online: true },
  },
  oauth_config: {
    scopes: {
      bot: [
        "app_mentions:read",
        "chat:write",
        "im:history",
        "im:read",
        "im:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "reactions:write",
      ],
    },
  },
  settings: {
    event_subscriptions: { bot_events: ["app_mention", "message.im"] },
    interactivity: { is_enabled: true },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
};

let state: SlackStatus["state"] = "not-set-up";
let error: string | null = null;
let workspace: string | null = null;
let botName: string | null = null;
let botUserId: string | null = null;
let api: SlackApi | null = null;
let socket: SlackSocket | null = null;
/** How a turn is started; tests swap in a fake. */
let send = sendMessage;

const queues = new Map<string, Promise<void>>();
const seenEvents = new Set<string>();
const refusedAt = new Map<string, number>();
const names = new Map<string, string>();
/** Approval messages posted to Slack, by approval part id. */
const approvalMessages = new Map<string, { channel: string; ts: string; text: string; runId: string }>();

function readStored(): Stored {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'slack'`).get() as Row | undefined;
  return { defaultAgentId: null, allowedUsers: [], requests: [], ...parseJson<Partial<Stored>>(row?.value, {}) };
}

function writeStored(next: Stored): void {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('slack', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    JSON.stringify(next),
  );
}

function setState(next: SlackStatus["state"], problem: string | null = null): void {
  state = next;
  error = problem;
  changed();
}

function changed(): void {
  appEvents.publish({ type: "slack", status: slack.status() });
}

const allowed = (userId: string) => readStored().allowedUsers.some((person) => person.id === userId);

/** Where TOT's web app is reachable, for "open in TOT" links (the Wi-Fi address when shared on the LAN). */
function webUrl(path: string): string {
  const port = IS_PROD ? PORT : 5173;
  return `${(LAN && lanUrls(port)[0]) || `http://localhost:${port}`}${path}`;
}

/** A short "TOT ↗" link to a chat in TOT. */
const chatLink = (conversationId: string | undefined) => `<${webUrl(`/c/${conversationId}`)}|TOT ↗>`;

async function personName(userId: string): Promise<string> {
  const cached = names.get(userId);
  if (cached) return cached;
  let name = userId;
  try {
    const { user } = await api!.users.info({ user: userId });
    name = user?.profile?.display_name || user?.real_name || user?.profile?.real_name || user?.name || userId;
  } catch {
    // Keep the id.
  }
  names.set(userId, name);
  return name;
}

/** Slack's message markup → plain text: mentions become names, links show their address. */
async function plainText(text: string): Promise<string> {
  let out = text.replace(new RegExp(`<@${botUserId}>`, "g"), "");
  const mentioned = [...new Set([...out.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!))];
  for (const id of mentioned) out = out.replace(new RegExp(`<@${id}(?:\\|[^>]*)?>`, "g"), `@${await personName(id)}`);
  return out
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

/** "Puddin: do x" or "Puddin, do x" picks that agent; anything else goes to the default agent. */
export function pickAgent(text: string, all: Agent[], defaultAgentId: string | null): { agent: Agent; text: string } {
  for (const agent of [...all].sort((a, b) => b.name.length - a.name.length)) {
    const name = agent.name.trim().toLowerCase();
    const lower = text.toLowerCase();
    if (name && lower.startsWith(name) && /^[:,]/.test(text.slice(name.length).trimStart())) {
      return { agent, text: text.slice(name.length).trimStart().slice(1).trim() };
    }
  }
  return { agent: all.find((a) => a.id === defaultAgentId) ?? all[0]!, text };
}

function getThread(channel: string, threadTs: string): Thread | null {
  const row = db.prepare(`SELECT * FROM slack_threads WHERE channel = ? AND thread_ts = ?`).get(channel, threadTs) as Row | undefined;
  if (!row) return null;
  // The chat may have been deleted in TOT; then the thread starts a new one.
  if (!conversations.get(String(row.conversation_id))) {
    db.prepare(`DELETE FROM slack_threads WHERE channel = ? AND thread_ts = ?`).run(channel, threadTs);
    return null;
  }
  return {
    channel,
    threadTs,
    conversationId: String(row.conversation_id),
    userId: String(row.user_id),
    seenTs: String(row.seen_ts),
  };
}

/** Slack timestamps ("1790000003.000400") in order: seconds, then microseconds. */
export function tsAfter(a: string, b: string): boolean {
  const [as = "0", au = "0"] = a.split(".");
  const [bs = "0", bu = "0"] = b.split(".");
  return Number(as) !== Number(bs) ? Number(as) > Number(bs) : Number(au) > Number(bu);
}

function markSeen(channel: string, threadTs: string, ts: string): void {
  const thread = getThread(channel, threadTs);
  if (thread && tsAfter(ts, thread.seenTs)) {
    db.prepare(`UPDATE slack_threads SET seen_ts = ? WHERE channel = ? AND thread_ts = ?`).run(ts, channel, threadTs);
  }
}

/** The thread's human messages as "Name: text", oldest first, within a budget (newest kept). */
async function threadTranscript(channel: string, threadTs: string, after: string, exclude: string): Promise<string> {
  const { messages = [] } = await api!.conversations.replies({ channel, ts: threadTs, limit: 200 });
  const lines: string[] = [];
  for (const message of messages) {
    if (!message.ts || !tsAfter(message.ts, after) || message.ts === exclude || message.bot_id || !message.user || !message.text) continue;
    lines.push(`${await personName(message.user)}: ${await plainText(message.text)}`);
  }
  let text = lines.join("\n");
  if (text.length > CONTEXT_CHARS) text = `…\n${text.slice(-CONTEXT_CHARS)}`;
  return text;
}

async function post(channel: string, threadTs: string, markdown: string, extra: Record<string, unknown>[] = []): Promise<string | undefined> {
  const chunks: string[] = [];
  for (let rest = markdown.trim() || "(no reply)"; rest; ) {
    let cut = rest.length <= BLOCK_LIMIT ? rest.length : rest.lastIndexOf("\n", BLOCK_LIMIT);
    if (cut < BLOCK_LIMIT / 2) cut = Math.min(rest.length, BLOCK_LIMIT);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  let ts: string | undefined;
  for (const [i, chunk] of chunks.entries()) {
    const last = i === chunks.length - 1;
    const res = await api!.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: chunk.slice(0, 300),
      blocks: [{ type: "markdown", text: chunk }, ...(last ? extra : [])],
      unfurl_links: false,
    });
    ts = res.ts ?? ts;
  }
  return ts;
}

const react = (channel: string, ts: string, name: string, add = true) =>
  (add ? api!.reactions.add({ channel, timestamp: ts, name }) : api!.reactions.remove({ channel, timestamp: ts, name })).catch(() => {});

function approvalBlocks(runId: string, partId: string, text: string, decided?: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [{ type: "section", text: { type: "mrkdwn", text: `*Needs your OK:* ${text}`.slice(0, 2900) } }];
  if (decided) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: decided }] });
  } else {
    const value = JSON.stringify({ runId, partId });
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: "tot_approve", value },
        { type: "button", text: { type: "plain_text", text: "Deny" }, action_id: "tot_deny", value },
      ],
    });
  }
  return blocks;
}

/** Follows a run: approval requests become buttons; resolves with the finished reply. */
function follow(runId: string, channel: string, threadTs: string): Promise<Extract<RunEvent, { type: "run-end" }> | null> {
  const run = runRegistry.get(runId);
  if (!run) return Promise.resolve(null);
  return new Promise((resolve) => {
    run.subscribe((_seq, event) => {
      if ((event.type === "part-start" || event.type === "part-update") && event.part.type === "approval") {
        void showApproval(runId, channel, threadTs, event.part);
      }
      if (event.type === "run-end") resolve(event);
    });
  });
}

async function showApproval(runId: string, channel: string, threadTs: string, part: Extract<MessagePart, { type: "approval" }>) {
  const shown = approvalMessages.get(part.id);
  const text = part.kind === "url" && part.url ? `${part.message}\n${part.url}` : part.message;
  if (part.status === "pending") {
    if (shown) return;
    if (part.kind === "form") {
      await post(channel, threadTs, `*Needs your answer in TOT:* ${part.message}\n${chatLink(runRegistry.get(runId)?.conversationId)}`);
      return;
    }
    const res = await api!.chat.postMessage({ channel, thread_ts: threadTs, text: `Needs your OK: ${text}`.slice(0, 300), blocks: approvalBlocks(runId, part.id, text) });
    if (res.ts) approvalMessages.set(part.id, { channel, ts: res.ts, text, runId });
    return;
  }
  if (!shown) return;
  const outcome = { accepted: "Approved", declined: "Denied", expired: "Expired — declined automatically", pending: "" }[part.status];
  await api!.chat.update({ channel: shown.channel, ts: shown.ts, text: outcome, blocks: approvalBlocks(runId, part.id, shown.text, outcome) }).catch(() => {});
  approvalMessages.delete(part.id);
}

/** One message from Slack, start to finish. Messages in the same thread wait their turn. */
async function handle(message: SlackMessage): Promise<void> {
  const channel = message.channel!;
  const ts = message.ts!;
  const userId = message.user!;
  const threadTs = message.thread_ts ?? ts;

  if (!allowed(userId)) {
    const stored = readStored();
    if (!stored.requests.some((person) => person.id === userId)) {
      writeStored({ ...stored, requests: [{ id: userId, name: await personName(userId) }, ...stored.requests].slice(0, 20) });
      changed();
    }
    if (Date.now() - (refusedAt.get(userId) ?? 0) > REFUSAL_EVERY_MS) {
      refusedAt.set(userId, Date.now());
      await post(channel, threadTs, "Hi! I only take requests from people allowed in TOT's settings. I've passed your request along.");
    }
    return;
  }

  const text = await plainText(message.text ?? "");
  if (!text) {
    await post(channel, threadTs, "What would you like me to do?");
    return;
  }
  await react(channel, ts, "eyes");

  let thread = getThread(channel, threadTs);
  let request = text;
  let context = "";
  if (!thread) {
    const picked = pickAgent(text, agents.list(), readStored().defaultAgentId);
    request = picked.text || text;
    const info = await api!.conversations.info({ channel }).catch(() => ({ channel: undefined }));
    const label = info.channel?.is_im ? `DM with ${await personName(userId)}` : info.channel?.name ? `#${info.channel.name}` : "Slack";
    const permalink = await api!.chat.getPermalink({ channel, message_ts: threadTs }).then((r) => r.permalink ?? null, () => null);
    const conversation = conversations.create({
      agentId: picked.agent.id,
      modelId: picked.agent.modelId,
      origin: { kind: "slack", label, url: permalink },
    });
    appEvents.publish({ type: "conversation", conversation: toPublicConversation(conversation) });
    appEvents.agentChanged(picked.agent.id);
    db.prepare(`INSERT INTO slack_threads (channel, thread_ts, conversation_id, user_id, seen_ts, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      channel,
      threadTs,
      conversation.id,
      userId,
      ts,
      Date.now(),
    );
    thread = getThread(channel, threadTs)!;
    // Mentioned inside an existing thread: the agent gets the conversation so far.
    if (message.thread_ts) context = await threadTranscript(channel, threadTs, "0", ts);
    context = context ? `The Slack thread so far:\n<slack_thread>\n${context}\n</slack_thread>\n` : "";
  } else {
    const fresh = await threadTranscript(channel, threadTs, thread.seenTs, ts);
    context = fresh ? `New in the Slack thread since your last reply:\n<slack_thread>\n${fresh}\n</slack_thread>\n` : "";
  }
  markSeen(channel, threadTs, ts);

  const conversation = conversations.get(thread.conversationId)!;
  const where = conversation.origin?.label ?? "Slack";
  const preamble = `[This message came from Slack (${where}), from ${await personName(userId)}. ${context}Your reply is posted back to the Slack thread, so keep it readable there.]`;

  let started: { runId: string } | null = null;
  for (let attempt = 0; attempt < 30 && !started; attempt++) {
    try {
      started = await send(conversation.id, { text: request }, { preamble });
    } catch (err) {
      // The chat is busy (e.g. someone is also using it in TOT): wait for it to finish.
      if (!(err instanceof HttpError && err.status === 409)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  if (!started) throw new Error("The chat stayed busy; try again in a moment.");

  const end = await follow(started.runId, channel, threadTs);
  const reply = end ? messageText(end.message) : "";
  const failed = !end || end.status === "error";
  const body = failed ? `Sorry, that didn't work: ${end?.message.error ?? "the run ended unexpectedly."}` : reply || "(done, nothing to say)";
  const footer = [{ type: "context", elements: [{ type: "mrkdwn", text: chatLink(conversation.id) }] }];
  // Messages written while the agent worked stay unseen, so its next turn gets them (its own replies are skipped).
  await post(channel, threadTs, body, footer);
  await react(channel, ts, "eyes", false);
  await react(channel, ts, failed ? "x" : "white_check_mark");
}

function enqueue(message: SlackMessage): void {
  const key = `${message.channel}:${message.thread_ts ?? message.ts}`;
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous
    .then(() => handle(message))
    .catch(async (err) => {
      console.warn("[tot] Slack message failed:", err instanceof Error ? err.message : err);
      await post(message.channel!, message.thread_ts ?? message.ts!, `Sorry, something went wrong: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    })
    .finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  queues.set(key, next);
}

/** A Slack event worth handling: from a person, not edits or the bot itself, and only once. */
function accept(message: SlackMessage, kind: "mention" | "dm"): boolean {
  if (!message.channel || !message.ts || !message.user || message.bot_id || message.subtype || message.user === botUserId) return false;
  if (kind === "dm" && message.channel_type !== "im") return false;
  const key = `${message.channel}:${message.ts}`;
  if (seenEvents.has(key)) return false;
  seenEvents.add(key);
  if (seenEvents.size > 2000) seenEvents.delete(seenEvents.values().next().value!);
  return true;
}

async function onButton(body: {
  type?: string;
  user?: { id?: string };
  actions?: { action_id?: string; value?: string }[];
}): Promise<void> {
  if (body.type !== "block_actions") return;
  const action = body.actions?.[0];
  if (!action?.value || (action.action_id !== "tot_approve" && action.action_id !== "tot_deny")) return;
  const userId = body.user?.id ?? "";
  if (!allowed(userId)) return;
  const { runId, partId } = JSON.parse(action.value) as { runId: string; partId: string };
  const decision = action.action_id === "tot_approve" ? "accept" : "decline";
  const shown = approvalMessages.get(partId);
  if (!answerApproval(runId, partId, { decision }) && shown) {
    await api!.chat.update({ channel: shown.channel, ts: shown.ts, text: "This request already ended", blocks: approvalBlocks(runId, partId, shown.text, "This request already ended.") });
    approvalMessages.delete(partId);
  } else if (shown) {
    // The run's own update follows; say who decided right away.
    const verdict = `${decision === "accept" ? "Approved" : "Denied"} by <@${userId}>`;
    await api!.chat.update({ channel: shown.channel, ts: shown.ts, text: verdict, blocks: approvalBlocks(runId, partId, shown.text, verdict) }).catch(() => {});
    approvalMessages.delete(partId);
  }
}

function wire(client: SlackSocket): void {
  const ackThen = (kind: "mention" | "dm") => async ({ ack, event }: { ack: () => Promise<void>; event: SlackMessage }) => {
    await ack();
    if (accept(event, kind)) enqueue(event);
  };
  client.on("app_mention", ackThen("mention"));
  client.on("message", ackThen("dm"));
  client.on("interactive", async ({ ack, body }: { ack: () => Promise<void>; body: Parameters<typeof onButton>[0] }) => {
    await ack();
    await onButton(body).catch((err) => console.warn("[tot] Slack button failed:", err));
  });
  client.on("connected", () => setState("connected"));
  client.on("reconnecting", () => setState("connecting"));
}

async function open(tokens: SlackTokens, make?: { api: SlackApi; socket: SlackSocket }): Promise<void> {
  const web = make?.api ?? (new WebClient(tokens.botToken, { logLevel: LogLevel.ERROR }) as unknown as SlackApi);
  let who: Awaited<ReturnType<SlackApi["auth"]["test"]>>;
  try {
    who = await web.auth.test();
  } catch (err) {
    throw new HttpError(400, `Slack didn't accept the bot token: ${err instanceof Error ? err.message.replace(/^An API error occurred: /, "") : String(err)}`);
  }
  const client = make?.socket ?? (new SocketModeClient({ appToken: tokens.appToken, logLevel: LogLevel.ERROR }) as unknown as SlackSocket);
  api = web;
  botUserId = who.user_id ?? null;
  botName = who.user ?? null;
  workspace = who.team ?? null;
  wire(client);
  socket = client;
  setState("connecting");
  try {
    await client.start();
  } catch (err) {
    socket = null;
    throw new HttpError(400, `Slack didn't accept the app-level token: ${err instanceof Error ? err.message : String(err)}`);
  }
  setState("connected");
}

async function close(): Promise<void> {
  const client = socket;
  socket = null;
  client?.removeAllListeners();
  await client?.disconnect().catch(() => {});
}

export const slack = {
  status(): SlackStatus {
    const stored = readStored();
    const manifest = JSON.stringify(SLACK_MANIFEST, null, 2);
    return {
      state,
      error,
      workspace: state === "not-set-up" ? null : workspace,
      botName: state === "not-set-up" ? null : botName,
      defaultAgentId: stored.defaultAgentId,
      allowedUsers: stored.allowedUsers,
      requests: stored.requests,
      manifest,
      createAppUrl: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(SLACK_MANIFEST))}`,
    };
  },

  /** Checks the tokens with Slack and connects; saves them only when both work. */
  async connect(tokens: SlackTokens, make?: { api: SlackApi; socket: SlackSocket }): Promise<SlackStatus> {
    const appToken = tokens.appToken?.trim() ?? "";
    const botToken = tokens.botToken?.trim() ?? "";
    if (!appToken.startsWith("xapp-")) throw new HttpError(400, "The app-level token starts with xapp- (Basic Information → App-Level Tokens).");
    if (!botToken.startsWith("xoxb-")) throw new HttpError(400, "The bot token starts with xoxb- (OAuth & Permissions → Bot User OAuth Token).");
    await close();
    try {
      await open({ appToken, botToken }, make);
    } catch (err) {
      setState("error", err instanceof Error ? err.message : String(err));
      throw err;
    }
    setSecret("slackAppToken", appToken);
    setSecret("slackBotToken", botToken);
    return slack.status();
  },

  /** On TOT startup: reconnect with saved tokens. */
  async resume(): Promise<void> {
    const appToken = getSecret("slackAppToken");
    const botToken = getSecret("slackBotToken");
    if (!appToken || !botToken) return;
    await open({ appToken, botToken }).catch((err) => setState("error", err instanceof Error ? err.message : String(err)));
  },

  patch(patch: SlackPatch): SlackStatus {
    const stored = readStored();
    if (patch.defaultAgentId !== undefined) {
      if (patch.defaultAgentId !== null && !agents.get(patch.defaultAgentId)) throw new HttpError(404, "Agent not found.");
      stored.defaultAgentId = patch.defaultAgentId;
    }
    if (patch.allow) {
      const person = stored.requests.find((p) => p.id === patch.allow) ?? { id: patch.allow, name: names.get(patch.allow) ?? patch.allow };
      stored.requests = stored.requests.filter((p) => p.id !== patch.allow);
      if (!stored.allowedUsers.some((p) => p.id === person.id)) stored.allowedUsers = [...stored.allowedUsers, person];
    }
    if (patch.disallow) stored.allowedUsers = stored.allowedUsers.filter((p) => p.id !== patch.disallow);
    writeStored(stored);
    changed();
    return slack.status();
  },

  async disconnect(): Promise<SlackStatus> {
    await close();
    setSecret("slackAppToken", "");
    setSecret("slackBotToken", "");
    api = null;
    botUserId = null;
    setState("not-set-up");
    return slack.status();
  },

  async stop(): Promise<void> {
    await close();
  },

  /** Tests: start turns with a fake instead of the real models. */
  useSender(fake: typeof sendMessage): void {
    send = fake;
  },
};
