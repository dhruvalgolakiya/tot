import type { Agent, AppEvent, Conversation, DevicesStatus, LiveRuns, Message, MessagePart, Project, RunEvent } from "@shared/types";
import { create } from "zustand";
import { api, apiUrl, authHeaders, errorMessage } from "./api";
import { setDeviceName, tokenRefused } from "./connection";
import { adopt, deviceOf, forgetDevices, onDevice } from "./devices";
import { applyRunEvent, createAssistantMessage, upsertMessage } from "./reducer";
import { openSse } from "./sse";

/**
 * Everything the app shows, from the signed-in TOT and its online paired devices (module 07), kept live by its
 * event stream. Modeled on the web app's src/store.ts; nothing here is saved on the phone.
 */

type ApprovalPart = Extract<MessagePart, { type: "approval" }>;

interface ActiveRun {
  runId: string;
  /** The assistant message being written; null until run-start. */
  messageId: string | null;
  stopping: boolean;
}

interface State {
  devices: DevicesStatus | null;
  agents: Agent[];
  conversations: Conversation[];
  projects: Project[];
  /** Loaded chats' messages, by conversation id. */
  messages: Record<string, Message[]>;
  activeRuns: Record<string, ActiveRun>;
  /** Agents with a turn running, from the event stream's `run` events (so only what started since the app opened). */
  runningAgents: Record<string, true>;
  /** Chats waiting for an approval, from `approval` events and loaded messages. */
  pendingApprovals: Record<string, true>;
  loaded: boolean;
  error: string | null;
  /** The event stream is up. */
  live: boolean;
}

const initial: State = {
  devices: null,
  agents: [],
  conversations: [],
  projects: [],
  messages: {},
  activeRuns: {},
  runningAgents: {},
  pendingApprovals: {},
  loaded: false,
  error: null,
  live: false,
};

export const useStore = create<State>()(() => initial);
const set = useStore.setState;
const get = useStore.getState;

const without = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in record)) return record;
  const { [key]: _gone, ...rest } = record;
  return rest;
};

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((x) => x.id === item.id);
  if (index === -1) return [item, ...list];
  const copy = list.slice();
  copy[index] = item;
  return copy;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** The signed-in TOT's agents, chats and projects, then every online paired device's. */
export async function loadAll(): Promise<void> {
  try {
    const [devices, agents, conversations, projects, live] = await Promise.all([
      api.getDevices().catch(() => null),
      api.listAgents(),
      api.listConversations(),
      api.listProjects().catch(() => [] as Project[]),
      api.liveRuns().catch(() => NOTHING_LIVE),
    ]);
    if (devices) setDeviceName(devices.self.name);
    const remote = await Promise.all((devices?.devices ?? []).filter((d) => d.online).map((d) => loadRemote(d.id)));
    const allLive = [live, ...remote.map((r) => r.live)];
    set({
      devices,
      runningAgents: Object.fromEntries(allLive.flatMap((l) => l.running.map((r) => [r.agentId, true as const]))),
      pendingApprovals: Object.fromEntries(allLive.flatMap((l) => l.waiting.map((w) => [w.conversationId, true as const]))),
      agents: [...agents, ...remote.flatMap((r) => r.agents)],
      conversations: [...conversations, ...remote.flatMap((r) => r.conversations)],
      projects: [...projects, ...remote.flatMap((r) => r.projects)],
      loaded: true,
      error: null,
    });
  } catch (error) {
    set({ loaded: true, error: errorMessage(error) });
  }
}

/** A paired device's agents, chats and projects, through the signed-in TOT; empty when it can't be reached. */
async function loadRemote(deviceId: string): Promise<{ agents: Agent[]; conversations: Conversation[]; projects: Project[]; live: LiveRuns }> {
  try {
    const [agents, conversations, projects, live] = await onDevice(deviceId, () =>
      Promise.all([
        api.listAgents(),
        api.listConversations(),
        api.listProjects().catch(() => [] as Project[]),
        // A device on an older TOT doesn't have this yet.
        api.liveRuns().catch(() => NOTHING_LIVE),
      ]),
    );
    return {
      agents: agents.map((agent) => ({ ...agent, deviceId })),
      conversations,
      projects: projects.map((project) => ({ ...project, deviceId })),
      live,
    };
  } catch {
    return { agents: [], conversations: [], projects: [], live: NOTHING_LIVE };
  }
}

const NOTHING_LIVE: LiveRuns = { running: [], waiting: [] };

async function refreshDevice(deviceId: string) {
  const remote = await loadRemote(deviceId);
  const mine = (id: string) => deviceOf(id) === deviceId;
  set((s) => ({
    agents: [...s.agents.filter((a) => a.deviceId !== deviceId), ...remote.agents],
    conversations: [...s.conversations.filter((c) => !mine(c.id)), ...remote.conversations],
    projects: [...s.projects.filter((p) => p.deviceId !== deviceId), ...remote.projects],
  }));
}

/** One chat's messages; follows its running turn when there is one. */
export async function loadConversation(id: string, { attach = true } = {}): Promise<void> {
  const detail = await api.getConversation(id);
  set((s) => ({
    conversations: upsert(s.conversations, detail.conversation),
    messages: { ...s.messages, [id]: detail.messages },
    pendingApprovals: hasPendingApproval(detail.messages) ? { ...s.pendingApprovals, [id]: true } : without(s.pendingApprovals, id),
  }));
  if (detail.activeRunId && attach) attachRun(id, detail.activeRunId);
}

const hasPendingApproval = (messages: Message[]) =>
  messages.some((m) => m.parts.some((p) => p.type === "approval" && p.status === "pending"));

// ---------------------------------------------------------------------------
// Live app events
// ---------------------------------------------------------------------------

let closeEvents: (() => void) | null = null;

/** Opens the app-wide event stream (one per app); every reconnect reloads the lists, since there's no replay. */
export function startLive() {
  if (closeEvents) return;
  closeEvents = openSse({
    url: () => apiUrl("/events", null),
    headers: authHeaders,
    onOpen: (again) => {
      set({ live: true });
      if (again) void loadAll();
    },
    onMessage: (data) => {
      let event: AppEvent;
      try {
        event = JSON.parse(data) as AppEvent;
      } catch {
        return;
      }
      // A paired device's event arrives wrapped; its ids become that device's.
      if (event.type === "remote") handleEvent(adopt(event.deviceId, event.event), event.deviceId);
      else handleEvent(event, null);
    },
    onEnd: (status) => {
      set({ live: false });
      closeEvents = null;
      if (status === 401) void tokenRefused();
    },
  });
}

export function stopLive() {
  closeEvents?.();
  closeEvents = null;
  for (const id of Object.keys(runStreams)) detachRun(id);
  forgetDevices();
  set(initial);
}

function handleEvent(event: AppEvent, deviceId: string | null) {
  switch (event.type) {
    case "agent":
      set((s) => ({ agents: upsert(s.agents, deviceId ? { ...event.agent, deviceId } : event.agent) }));
      break;
    case "agent-deleted":
      set((s) => ({ agents: s.agents.filter((a) => a.id !== event.agentId) }));
      break;
    case "conversation":
    case "task":
      set((s) => ({ conversations: upsert(s.conversations, event.conversation) }));
      break;
    case "conversation-deleted":
      set((s) => ({ conversations: s.conversations.filter((c) => c.id !== event.conversationId) }));
      break;
    case "project":
      set((s) => ({
        projects: event.project.archived
          ? s.projects.filter((p) => p.id !== event.project.id)
          : upsert(s.projects, deviceId ? { ...event.project, deviceId } : event.project),
      }));
      break;
    case "run":
      set((s) => ({
        runningAgents: event.status === "running" ? { ...s.runningAgents, [event.agentId]: true } : without(s.runningAgents, event.agentId),
      }));
      // A turn TOT started on its own (a task's next turn) in a chat that's open here: follow it.
      if (event.status === "running" && openChats.has(event.conversationId) && !runStreams[event.conversationId]) {
        void loadConversation(event.conversationId).catch(() => {});
      }
      break;
    case "approval":
      set((s) => ({
        pendingApprovals: event.pending ? { ...s.pendingApprovals, [event.conversationId]: true } : without(s.pendingApprovals, event.conversationId),
      }));
      // Answered elsewhere (another phone, the Mac): an open chat shows the answer.
      if (!event.pending && openChats.has(event.conversationId) && !runStreams[event.conversationId]) {
        void loadConversation(event.conversationId).catch(() => {});
      }
      break;
    case "device":
      if (event.device.self) {
        setDeviceName(event.device.name);
        set((s) => (s.devices ? { devices: { ...s.devices, self: event.device } } : {}));
        break;
      }
      set((s) => {
        if (!s.devices) return {};
        const before = s.devices.devices.find((d) => d.id === event.device.id);
        const list = before ? s.devices.devices.map((d) => (d.id === event.device.id ? event.device : d)) : [...s.devices.devices, event.device];
        if (event.device.online && !before?.online) void refreshDevice(event.device.id);
        return { devices: { ...s.devices, devices: list } };
      });
      break;
    case "device-deleted":
      set((s) => ({
        devices: s.devices ? { ...s.devices, devices: s.devices.devices.filter((d) => d.id !== event.deviceId) } : null,
        agents: s.agents.filter((a) => a.deviceId !== event.deviceId),
        projects: s.projects.filter((p) => p.deviceId !== event.deviceId),
      }));
      break;
  }
}

/** Chats on screen right now (a chat screen registers itself), so turns started elsewhere show up live. */
const openChats = new Set<string>();

export function watchChat(id: string): () => void {
  openChats.add(id);
  return () => openChats.delete(id);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

const runStreams: Record<string, { runId: string; close: () => void }> = {};

function attachRun(conversationId: string, runId: string) {
  const existing = runStreams[conversationId];
  if (existing?.runId === runId) return;
  if (existing) detachRun(conversationId);
  set((s) => ({ activeRuns: { ...s.activeRuns, [conversationId]: { runId, messageId: null, stopping: false } } }));
  const close = openSse({
    url: () => apiUrl(`/runs/${encodeURIComponent(runId)}/events`, deviceOf(runId)),
    headers: authHeaders,
    onMessage: (data) => {
      let event: RunEvent;
      try {
        event = JSON.parse(data) as RunEvent;
      } catch {
        return;
      }
      const device = deviceOf(runId);
      if (device) adopt(device, event);
      enqueue(conversationId, runId, event);
    },
    // 204: the run is gone or fully delivered without our seeing run-end. Load what was saved.
    onEnd: () => {
      flush();
      if (runStreams[conversationId]?.runId !== runId) return;
      detachRun(conversationId);
      set((s) => ({ activeRuns: without(s.activeRuns, conversationId) }));
      void loadConversation(conversationId, { attach: false }).catch(() => {});
    },
  });
  runStreams[conversationId] = { runId, close };
}

function detachRun(conversationId: string) {
  runStreams[conversationId]?.close();
  delete runStreams[conversationId];
}

// Streaming deltas arrive fast; apply them in small batches so the chat re-renders a few times a second, not per token.
let queue: { conversationId: string; runId: string; event: RunEvent }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function enqueue(conversationId: string, runId: string, event: RunEvent) {
  queue.push({ conversationId, runId, event });
  timer ??= setTimeout(flush, 60);
}

function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  let { messages, activeRuns, conversations, pendingApprovals } = get();
  const ended: string[] = [];
  for (const { conversationId, runId, event } of batch) {
    const run = activeRuns[conversationId];
    if (run?.runId !== runId) continue;
    const list = messages[conversationId] ?? [];
    switch (event.type) {
      case "run-start":
        activeRuns = { ...activeRuns, [conversationId]: { ...run, messageId: event.messageId } };
        messages = { ...messages, [conversationId]: upsertMessage(list, createAssistantMessage(event)) };
        break;
      case "conversation":
        conversations = upsert(conversations, event.conversation);
        break;
      case "run-end":
        messages = { ...messages, [conversationId]: upsertMessage(list, event.message) };
        activeRuns = without(activeRuns, conversationId);
        ended.push(conversationId);
        break;
      default:
        if (!run.messageId) break;
        messages = { ...messages, [conversationId]: list.map((m) => (m.id === run.messageId ? applyRunEvent(m, event) : m)) };
        if (event.type === "part-start" || event.type === "part-update") {
          pendingApprovals = hasPendingApproval(messages[conversationId])
            ? { ...pendingApprovals, [conversationId]: true }
            : without(pendingApprovals, conversationId);
        }
    }
  }
  set({ messages, activeRuns, conversations, pendingApprovals });
  for (const id of ended) detachRun(id);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Sends a message; with no chat yet, starts one with the agent first. Resolves with the chat's id. */
export async function sendMessage(text: string, target: { conversationId: string } | { agentId: string }): Promise<string> {
  let conversationId: string;
  if ("conversationId" in target) {
    conversationId = target.conversationId;
  } else {
    const agent = get().agents.find((a) => a.id === target.agentId);
    const conversation = await onDevice(agent?.deviceId, () => api.createConversation({ agentId: target.agentId }));
    conversationId = conversation.id;
    set((s) => ({ conversations: upsert(s.conversations, conversation), messages: { ...s.messages, [conversation.id]: [] } }));
  }
  const response = await api.sendMessage(conversationId, { text });
  set((s) => ({
    conversations: upsert(s.conversations, response.conversation),
    messages: { ...s.messages, [conversationId]: upsertMessage(s.messages[conversationId] ?? [], response.userMessage) },
  }));
  attachRun(conversationId, response.runId);
  return conversationId;
}

export async function stopRun(conversationId: string) {
  const run = get().activeRuns[conversationId];
  if (!run || run.stopping) return;
  set((s) => ({ activeRuns: { ...s.activeRuns, [conversationId]: { ...run, stopping: true } } }));
  await api.stopRun(run.runId);
}

/** Approve or decline a card: a tool's request (answered on its run) or a project Lead's land / discard ask. */
export async function answerApproval(conversationId: string, part: ApprovalPart, decision: "accept" | "decline") {
  if (part.lead) {
    await api.answerLeadAsk(part.id, decision);
    await loadConversation(conversationId, { attach: false });
    return;
  }
  const run = get().activeRuns[conversationId];
  if (!run) throw new Error("This request already ended.");
  await api.answerApproval(run.runId, part.id, { decision });
  // The card's new state arrives as a part-update on the run stream.
}

export async function setPinned(conversation: Conversation, pinned: boolean) {
  const updated = await api.updateConversation(conversation.id, { pinned });
  set((s) => ({ conversations: upsert(s.conversations, updated) }));
}

export async function deleteConversation(id: string) {
  await api.deleteConversation(id);
  set((s) => ({ conversations: s.conversations.filter((c) => c.id !== id), messages: without(s.messages, id) }));
}
