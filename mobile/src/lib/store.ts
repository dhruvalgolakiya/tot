import { Alert } from "react-native";
import type { Agent, AgentInput, AppEvent, ChatWorkspaceMode, Conversation, DevicesStatus, LandTaskRequest, LiveRuns, Message, MessagePart, ModelOption, Project, RunEvent, Settings, SettingsPatch } from "@shared/types";
import { create } from "zustand";
import { ApiError, api, apiUrl, authHeaders, errorMessage } from "./api";
import { CACHED_CHATS, CACHED_MESSAGES, readSnapshot, type Snapshot, writeSnapshot } from "./cache";
import { setDeviceName, tokenRefused, useConnection } from "./connection";
import { adopt, deviceOf, forgetDevices, onDevice, ownedIds, restoreOwners } from "./devices";
import { applyRunEvent, createAssistantMessage, upsertMessage } from "./reducer";
import { askForNotifications, catchUp, onApproval, onRun, onTask } from "./notify";
import { openSse, type SseHandle } from "./sse";

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
  /**
   * False while the TOT can't be reached (a load failed to connect, or the event stream has been down a moment):
   * the Reconnecting banner shows, and what's on screen is the last loaded (read-only) until it's back.
   */
  reachable: boolean;
  /** When the lists on screen were saved, while they come from the phone's cache rather than the TOT; null once loaded live. */
  cachedAt: number | null;
  /** Mission control's board (module 09) across this TOT and its online paired devices; null until the Tasks screen loads it. */
  mission: { taskIds: string[]; landOrder: string[]; error: string | null } | null;
  /** The signed-in TOT's settings (M3); null until loaded. Saved one field at a time. */
  settings: Settings | null;
  /** The model menu: this TOT's, and each paired device's (its agents' chats run there), loaded when a picker needs them. */
  models: ModelOption[];
  deviceModels: Record<string, ModelOption[]>;
  /** Bumped by `memory` events about "you", so an open Memory screen reloads. */
  memoryVersion: number;
  /** Bumped by any wiki or memory change (here or on a paired device), so an open Knowledge screen reloads. */
  knowledgeVersion: number;
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
  reachable: true,
  cachedAt: null,
  mission: null,
  settings: null,
  models: [],
  deviceModels: {},
  memoryVersion: 0,
  knowledgeVersion: 0,
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
  const at = Date.now();
  try {
    const [devices, agents, conversations, projects, live, settings, models] = await Promise.all([
      api.getDevices().catch(() => null),
      api.listAgents(),
      api.listConversations(),
      api.listProjects().catch(() => [] as Project[]),
      api.liveRuns().catch(() => NOTHING_LIVE),
      api.getSettings().catch(() => null),
      api.listModels().catch(() => [] as ModelOption[]),
    ]);
    if (devices) setDeviceName(devices.self.name);
    const remote = await Promise.all((devices?.devices ?? []).filter((d) => d.online).map((d) => loadRemote(d.id)));
    const allLive = [live, ...remote.map((r) => r.live)];
    // An offline paired device keeps the agents, chats and projects last seen from it (faded, its chats read-only),
    // as the web app remembers them, instead of an empty section.
    const away = new Set((devices?.devices ?? []).filter((d) => !d.online).map((d) => d.id));
    const before = get();
    const remembered = {
      agents: before.agents.filter((a) => a.deviceId && away.has(a.deviceId)),
      conversations: before.conversations.filter((c) => away.has(deviceOf(c.id) ?? "")),
      projects: before.projects.filter((p) => p.deviceId && away.has(p.deviceId)),
    };
    set({
      devices,
      runningAgents: Object.fromEntries(allLive.flatMap((l) => l.running.map((r) => [r.agentId, true as const]))),
      pendingApprovals: Object.fromEntries(allLive.flatMap((l) => l.waiting.map((w) => [w.conversationId, true as const]))),
      agents: [...agents, ...remote.flatMap((r) => r.agents), ...remembered.agents],
      conversations: [...conversations, ...remote.flatMap((r) => r.conversations), ...remembered.conversations],
      projects: [...projects, ...remote.flatMap((r) => r.projects), ...remembered.projects],
      settings,
      models,
      loaded: true,
      error: null,
      reachable: true,
      cachedAt: null,
    });
    clearDropTimer();
    scheduleSave();
    // What changed while the app wasn't listening (launch, coming back, a reconnect): notify what's new.
    void catchUp({
      at,
      conversations: get().conversations,
      waiting: allLive.flatMap((l) => l.waiting.map((w) => w.conversationId)),
      running: allLive.flatMap((l) => l.running.map((r) => r.conversationId)),
      agentName,
    }).catch(() => {});
  } catch (error) {
    // Unreachable: keep what's shown (the cache, or the last load) under the banner; the event stream keeps trying.
    const unreachable = error instanceof ApiError && error.status === 0;
    set({ loaded: true, error: errorMessage(error), ...(unreachable ? { reachable: false } : {}) });
  }
}

// ---------------------------------------------------------------------------
// The offline cache (lib/cache.ts)
// ---------------------------------------------------------------------------

/** Chats whose messages were loaded, newest first: the ones the cache keeps. */
let recentChats: string[] = [];
let hydrating = 0;

/** Shows the last lists saved from this TOT, before (or instead of, while it's unreachable) loading it. */
export async function hydrate(url: string): Promise<void> {
  const id = ++hydrating;
  const snapshot = await readSnapshot(url);
  // Switched TOT meanwhile, or the TOT answered first: the live lists win.
  if (!snapshot || id !== hydrating || useConnection.getState().url !== url || get().loaded) return;
  restoreOwners(snapshot.owners);
  recentChats = Object.keys(snapshot.messages);
  set({
    devices: snapshot.devices,
    agents: snapshot.agents,
    conversations: snapshot.conversations,
    projects: snapshot.projects,
    settings: snapshot.settings,
    models: snapshot.models,
    deviceModels: snapshot.deviceModels,
    messages: snapshot.messages,
    loaded: true,
    cachedAt: snapshot.savedAt,
  });
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Saves what's shown a moment after it changes (a burst of events gives one write). */
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const url = useConnection.getState().url;
    const s = get();
    // Only what came from the TOT this session: a cache is never re-saved as if it were new.
    if (!url || !s.loaded || s.cachedAt !== null) return;
    const messages: Record<string, Message[]> = {};
    for (const id of recentChats.slice(0, CACHED_CHATS)) if (s.messages[id]) messages[id] = s.messages[id].slice(-CACHED_MESSAGES);
    const snapshot: Snapshot = {
      savedAt: Date.now(),
      devices: s.devices,
      agents: s.agents,
      conversations: s.conversations,
      projects: s.projects,
      settings: s.settings,
      models: s.models,
      deviceModels: s.deviceModels,
      messages,
      owners: ownedIds(),
    };
    void writeSnapshot(url, snapshot);
  }, 1500);
}

useStore.subscribe((now, before) => {
  if (now.agents !== before.agents || now.conversations !== before.conversations || now.projects !== before.projects || now.messages !== before.messages || now.devices !== before.devices) {
    scheduleSave();
  }
});

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

const agentName = (agentId: string) => get().agents.find((a) => a.id === agentId)?.name ?? "An agent";
const chatOf = (id: string) => get().conversations.find((c) => c.id === id);

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
  recentChats = [id, ...recentChats.filter((c) => c !== id)].slice(0, CACHED_CHATS * 2);
  set((s) => ({
    conversations: upsert(s.conversations, detail.conversation),
    messages: { ...s.messages, [id]: detail.messages },
    pendingApprovals: hasPendingApproval(detail.messages) ? { ...s.pendingApprovals, [id]: true } : without(s.pendingApprovals, id),
  }));
  if (detail.activeRunId && attach) attachRun(id, detail.activeRunId);
}

/** Clipped tool steps being fetched whole, by message and part id. */
const partLoads = new Map<string, Promise<MessagePart>>();

/**
 * A clipped tool step, whole: a chat loads with the start of each finished step's output, and opening one fetches
 * the rest, which then stays in its message.
 */
export function loadFullPart(conversationId: string, messageId: string, partId: string): Promise<MessagePart> {
  const key = `${messageId}/${partId}`;
  const pending = partLoads.get(key);
  if (pending) return pending;
  const load = api
    .getConversationPart(conversationId, messageId, partId)
    .then((full) => {
      set((s) => ({
        messages: {
          ...s.messages,
          [conversationId]: (s.messages[conversationId] ?? []).map((m) =>
            m.id === messageId ? { ...m, parts: m.parts.map((p) => (p.id === full.id ? full : p)) } : m,
          ),
        },
      }));
      return full;
    })
    .finally(() => partLoads.delete(key));
  partLoads.set(key, load);
  return load;
}

const hasPendingApproval = (messages: Message[]) =>
  messages.some((m) => m.parts.some((p) => p.type === "approval" && p.status === "pending"));

// ---------------------------------------------------------------------------
// Live app events
// ---------------------------------------------------------------------------

let closeEvents: SseHandle | null = null;
let dropTimer: ReturnType<typeof setTimeout> | null = null;
/** A blip (the phone switching networks) shouldn't flash the banner: the stream must stay down this long first. */
const DROP_GRACE_MS = 2500;

function clearDropTimer() {
  if (dropTimer) clearTimeout(dropTimer);
  dropTimer = null;
}

/** Opens the app-wide event stream (one per app); every reconnect reloads the lists, since there's no replay. */
export function startLive() {
  if (closeEvents) return;
  const url = useConnection.getState().url;
  closeEvents = openSse({
    url: () => apiUrl("/events", null),
    headers: authHeaders,
    onOpen: (again) => {
      clearDropTimer();
      set({ live: true });
      // No replay: reload the lists (and the board, if a screen shows it), and the open chats, whose turns may have
      // ended, or started, while the stream was down.
      if (again || !get().reachable || get().cachedAt !== null) {
        void loadAll().then(() => (missionWatchers ? loadMission().catch(() => {}) : undefined));
        for (const id of openChats) void loadConversation(id).catch(() => {});
      }
    },
    onDrop: () => {
      set({ live: false });
      dropTimer ??= setTimeout(() => {
        dropTimer = null;
        if (!get().live) set({ reachable: false });
      }, DROP_GRACE_MS);
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
      if (status === 401) void tokenRefused(url);
    },
  });
}

/** Tries the TOT again now instead of after the backoff (the banner's Retry, the app coming back). */
export function retryNow() {
  closeEvents?.retryNow();
  for (const stream of Object.values(runStreams)) stream.close.retryNow();
  void loadAll();
}

export function stopLive() {
  closeEvents?.();
  closeEvents = null;
  clearDropTimer();
  recentChats = [];
  hydrating++;
  for (const id of Object.keys(runStreams)) detachRun(id);
  forgetDevices();
  set(initial);
}

function handleEvent(event: AppEvent, deviceId: string | null) {
  switch (event.type) {
    case "agent": {
      const agent = deviceId ? { ...event.agent, deviceId } : event.agent;
      // A new agent goes last, in creation order like the web's rail; a changed one stays where it is.
      set((s) => ({ agents: s.agents.some((a) => a.id === agent.id) ? upsert(s.agents, agent) : [...s.agents, agent] }));
      break;
    }
    case "agent-deleted":
      set((s) => ({ agents: s.agents.filter((a) => a.id !== event.agentId) }));
      break;
    case "computer":
      set((s) => ({ agents: s.agents.map((a) => (a.id === event.agentId ? { ...a, computer: event.computer } : a)) }));
      break;
    case "memory":
      if (!deviceId && event.repo === "you") set((s) => ({ memoryVersion: s.memoryVersion + 1 }));
      set((s) => ({ knowledgeVersion: s.knowledgeVersion + 1 }));
      break;
    case "wiki":
      set((s) => ({ knowledgeVersion: s.knowledgeVersion + 1 }));
      break;
    case "conversation":
      set((s) => ({ conversations: upsert(s.conversations, event.conversation) }));
      break;
    case "task": {
      const previous = chatOf(event.conversation.id);
      set((s) => ({ conversations: upsert(s.conversations, event.conversation) }));
      onTask(event.conversation, previous);
      scheduleMission();
      break;
    }
    case "conversation-deleted":
      set((s) => ({ conversations: s.conversations.filter((c) => c.id !== event.conversationId) }));
      scheduleMission();
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
      onRun(chatOf(event.conversationId), agentName(event.agentId), event.runId, event.status);
      // A turn TOT started on its own (a task's next turn) in a chat that's open here: follow it.
      if (event.status === "running" && openChats.has(event.conversationId) && !runStreams[event.conversationId]) {
        void loadConversation(event.conversationId).catch(() => {});
      }
      break;
    case "approval":
      set((s) => ({
        pendingApprovals: event.pending ? { ...s.pendingApprovals, [event.conversationId]: true } : without(s.pendingApprovals, event.conversationId),
      }));
      onApproval(chatOf(event.conversationId), agentName(event.agentId), event.message, event.pending);
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

// ---------------------------------------------------------------------------
// Mission control
// ---------------------------------------------------------------------------

let missionWatchers = 0;
let missionTimer: ReturnType<typeof setTimeout> | null = null;
let missionRequest = 0;

/**
 * Every device's board, merged: each TOT's own overview (open tasks, unlanded ones in land order, the last day's
 * landed ones), its tasks kept in `conversations` so task events keep the rows live.
 */
export async function loadMission(): Promise<void> {
  const id = ++missionRequest;
  const online = (get().devices?.devices ?? []).filter((d) => d.online);
  const results = await Promise.allSettled([api.getMission(), ...online.map((d) => onDevice(d.id, () => api.getMission()))]);
  if (id !== missionRequest) return;
  const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failed = results[0]!.status === "rejected" ? errorMessage((results[0] as PromiseRejectedResult).reason) : null;
  set((s) => {
    let conversations = s.conversations;
    for (const overview of ok) for (const task of overview.tasks) conversations = upsert(conversations, task.conversation);
    return {
      conversations,
      mission: {
        taskIds: ok.flatMap((o) => o.tasks.map((t) => t.conversation.id)),
        landOrder: ok.flatMap((o) => o.landOrder),
        // This TOT's board failing is worth saying; a paired device that can't answer just has no rows.
        error: failed && !ok.length ? failed : null,
      },
    };
  });
}

/** Keeps the board loaded and live while a screen shows it. */
export function watchMission(): () => void {
  missionWatchers++;
  void loadMission().catch(() => {});
  return () => {
    missionWatchers--;
  };
}

/** Any task changing refetches the board a moment later, so a burst gives one fetch (as the web's useMissionOverview). */
function scheduleMission() {
  if (!missionWatchers) return;
  if (missionTimer) clearTimeout(missionTimer);
  missionTimer = setTimeout(() => {
    missionTimer = null;
    void loadMission().catch(() => {});
  }, 600);
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

const runStreams: Record<string, { runId: string; close: SseHandle }> = {};

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

/** Where a new chat starts: an agent, and optionally a project and (in a code project) where it works. */
export interface NewChatTarget {
  agentId: string;
  projectId?: string | null;
  workspace?: ChatWorkspaceMode;
  /** The model picked before the first message; the agent's default otherwise. */
  modelId?: string;
}

/** Sends a message; with no chat yet, starts one with the agent first. Resolves with the chat's id. */
export async function sendMessage(text: string, target: { conversationId: string } | NewChatTarget, attachments: string[] = []): Promise<string> {
  // A message can start tasks that finish later: ask iOS once, as the web asks the browser on the first send.
  void askForNotifications().catch(() => {});
  let conversationId: string;
  if ("conversationId" in target) {
    conversationId = target.conversationId;
  } else {
    const agent = get().agents.find((a) => a.id === target.agentId);
    const conversation = await onDevice(agent?.deviceId, () =>
      api.createConversation({
        agentId: target.agentId,
        ...(target.projectId ? { projectId: target.projectId } : {}),
        ...(target.projectId && target.workspace ? { workspace: target.workspace } : {}),
        ...(target.modelId ? { modelId: target.modelId } : {}),
      }),
    );
    conversationId = conversation.id;
    set((s) => ({ conversations: upsert(s.conversations, conversation), messages: { ...s.messages, [conversation.id]: [] } }));
  }
  const response = await api.sendMessage(conversationId, { text, ...(attachments.length ? { attachments } : {}) });
  set((s) => ({
    conversations: upsert(s.conversations, response.conversation),
    messages: { ...s.messages, [conversationId]: upsertMessage(s.messages[conversationId] ?? [], response.userMessage) },
  }));
  // A task that was already working took the message as a note: there's no new run to follow.
  if (response.runId) attachRun(conversationId, response.runId);
  return conversationId;
}

/** A note for a working task ("steering"): it reads it at its next step, no new turn. */
export async function steerTask(conversationId: string, text: string) {
  const message = await api.steerTask(conversationId, text);
  set((s) => ({ messages: { ...s.messages, [conversationId]: upsertMessage(s.messages[conversationId] ?? [], message) } }));
}

/** A task action's answer is the task itself, shown at once (its `task` event follows). */
async function taskAction(action: () => Promise<Conversation>): Promise<Conversation> {
  const task = await action();
  set((s) => ({ conversations: upsert(s.conversations, task) }));
  scheduleMission();
  return task;
}

export const pauseTask = (id: string) => taskAction(() => api.pauseTask(id));
export const resumeTask = (id: string) => taskAction(() => api.resumeTask(id));
export const stopTask = (id: string) => taskAction(() => api.stopTask(id));
export const runTaskNow = (id: string) => taskAction(() => api.runTaskNow(id));
export const landTask = (id: string, body: LandTaskRequest) => taskAction(() => api.landTask(id, body));
export const discardTask = (id: string) => taskAction(() => api.discardTask(id));

/** The project's Lead chat, started the first time (with this agent). Resolves with its id. */
export async function openLead(projectId: string, agentId?: string | null): Promise<string> {
  const lead = await api.openLead(projectId, agentId);
  set((s) => ({ conversations: upsert(s.conversations, lead) }));
  return lead.id;
}

/** Archived projects leave every list; their chats stay. */
export async function archiveProject(id: string) {
  await api.archiveProject(id);
  set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }));
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

// ---------------------------------------------------------------------------
// Settings and the top bar (M3)
// ---------------------------------------------------------------------------

/** The model menu for an agent's device: this TOT's, or (loaded once) the paired device's own list. */
export async function loadModels(deviceId?: string | null): Promise<void> {
  if (!deviceId) {
    const models = await api.listModels();
    set({ models });
    return;
  }
  const models = await onDevice(deviceId, () => api.listModels());
  set((s) => ({ deviceModels: { ...s.deviceModels, [deviceId]: models } }));
}

/** A chat's model: shown at once, put back (with the reason) when the TOT refuses it. */
export async function setConversationModel(conversation: Conversation, modelId: string) {
  if (conversation.modelId === modelId) return;
  set((s) => ({ conversations: upsert(s.conversations, { ...conversation, modelId }) }));
  try {
    const updated = await api.updateConversation(conversation.id, { modelId });
    set((s) => ({ conversations: upsert(s.conversations, updated) }));
  } catch (error) {
    set((s) => ({ conversations: upsert(s.conversations, { ...(s.conversations.find((c) => c.id === conversation.id) ?? conversation), modelId: conversation.modelId }) }));
    Alert.alert("Couldn't change the model", errorMessage(error));
  }
}

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** `base` with `patch` laid over it, nested objects merged (a settings patch names only the field it changes). */
function merged<T>(base: T, patch: unknown): T {
  if (!isPlain(base) || !isPlain(patch)) return patch as T;
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = isPlain(value) && isPlain(out[key]) ? merged(out[key], value) : value;
  return out as T;
}

/**
 * Saves one settings change right away (the phone has no Save bar): shown at once, then the TOT's answer; on an
 * error the old value comes back and an alert says why. Resolves true when saved.
 */
export async function saveSettings(patch: SettingsPatch): Promise<boolean> {
  const before = get().settings;
  if (before) set({ settings: merged(before, patch) });
  try {
    set({ settings: await api.patchSettings(patch) });
    return true;
  } catch (error) {
    set({ settings: before });
    Alert.alert("Couldn't save that", errorMessage(error));
    return false;
  }
}

/** An agent's change, saved right away like settings; the agent event that follows keeps every screen in step. */
export async function updateAgent(agent: Agent, patch: Partial<AgentInput>): Promise<boolean> {
  set((s) => ({ agents: upsert(s.agents, { ...agent, ...patch, island: patch.island ?? agent.island } as Agent) }));
  try {
    const updated = await api.updateAgent(agent.id, patch);
    set((s) => ({ agents: upsert(s.agents, agent.deviceId ? { ...updated, deviceId: agent.deviceId } : updated) }));
    return true;
  } catch (error) {
    set((s) => ({ agents: upsert(s.agents, agent) }));
    Alert.alert("Couldn't save that", errorMessage(error));
    return false;
  }
}

/** A new agent on this TOT, or on a paired device (where its computer, files and logins will be). */
export async function createAgent(input: AgentInput, deviceId: string | null): Promise<Agent> {
  const agent = await onDevice(deviceId, () => api.createAgent(input));
  const placed = deviceId ? { ...agent, deviceId } : agent;
  // The agent event may have added it already; keep creation order (new ones go last, like the web's rail).
  set((s) => ({ agents: s.agents.some((a) => a.id === agent.id) ? upsert(s.agents, placed) : [...s.agents, placed] }));
  return placed;
}

/** Deletes the agent with its chats (the TOT refuses a device's last agent). */
export async function deleteAgent(agent: Agent) {
  await api.deleteAgent(agent.id);
  set((s) => ({ agents: s.agents.filter((a) => a.id !== agent.id), conversations: s.conversations.filter((c) => c.agentId !== agent.id) }));
}
