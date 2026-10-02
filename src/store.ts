import { create } from "zustand";
import { toast } from "sonner";
import type {
  Agent,
  AgentInput,
  AppEvent,
  AppsStatus,
  Attachment,
  ComputerSummary,
  Conversation,
  GitHubStatus,
  Message,
  ModelOption,
  ProviderId,
  ProviderStatus,
  RunEvent,
  Settings,
  SettingsPatch,
  SlackStatus,
  UpdateConversationRequest,
} from "@shared/types";
import { api, ApiError, errorMessage } from "./lib/api";
import { toMs, truncate } from "./lib/format";
import { AUTO_MODEL_ID, PROVIDER_LABELS } from "./lib/models";
import { applyRunEvent, createAssistantMessage, upsertMessage } from "./lib/reducer";
import {
  agentIdFromPath,
  agentPath,
  conversationIdFromPath,
  conversationPath,
  isSettingsPath,
  MASCOTS_PATH,
  pushPath,
  replacePath,
  settingsPath,
  settingsSectionFromPath,
  type SettingsSection,
  wikiFromPath,
  wikiPath,
} from "./lib/router";
import { buildSettingsPatch, EMPTY_SECRETS, isValidIdleMinutes, type SecretDrafts } from "./lib/settings";
import { subscribeToRun } from "./lib/stream";

export type AgentSettingsTab = "profile" | "routines";
type LoadState = "loading" | "ready" | "error";

/** Which top-level screen is showing; drives what `App` mounts. */
export type Page = "home" | "chat" | "mascots" | "wiki" | "settings";

/** How long a just-finished reply keeps its mascot "happy" before it idles. */
export const MASCOT_HAPPY_MS = 2200;

export interface ActiveRun {
  runId: string;
  /** The assistant message being produced; known once `run-start` arrives. */
  messageId: string | null;
  stopping: boolean;
}

export interface TotState {
  agents: Agent[];
  agentsState: LoadState;
  /** Agent whose home screen is showing when `currentId` is null. */
  homeAgentId: string | null;
  newAgentDialogOpen: boolean;
  /** Right-hand panel with the active agent's settings. */
  agentSettingsOpen: boolean;
  agentSettingsTab: AgentSettingsTab;
  /** Agent ids with a run in flight anywhere (including background routine runs
   * this tab never streamed), from the app-wide SSE channel. Combined with
   * `activeRuns` in `selectAgentWorking`. */
  runningAgents: Set<string>;
  /** Conversation ids with a pending approval request, from the app-wide SSE
   * channel; drives the sidebar's attention dot. */
  pendingApprovals: Set<string>;

  page: Page;
  conversations: Conversation[];
  conversationsState: LoadState;
  /** Open conversation; null on an agent's home screen or wiki. */
  currentId: string | null;
  /** The open page of the active agent's wiki; null shows the Overview. Only meaningful when `page === "wiki"`. */
  wikiPageId: string | null;
  /** Bumped whenever an agent's wiki changes (an AppEvent), for the open WikiView to react to. */
  wikiEvent: { agentId: string; conversationId?: string; at: number } | null;
  /** Bumped on every navigation so the chat view remounts fresh. */
  viewKey: number;
  messages: Record<string, Message[]>;
  detailState: Record<string, LoadState>;
  activeRuns: Record<string, ActiveRun>;
  /** A message is on its way to the server (before a run id exists). */
  sending: boolean;
  /** Conversations whose run just completed; mascot stays "happy" briefly. */
  justFinished: Record<string, boolean>;
  models: ModelOption[];
  providers: ProviderStatus[];
  settings: Settings | null;
  settingsState: LoadState;
  /** The app's one connected GitHub account (or null if none); null while still loading. */
  github: GitHubStatus | null;
  /** Apps (Executor): shared across agents; null while still loading. */
  apps: AppsStatus | null;
  /** TOT's Slack bot: shared across agents; null while still loading. */
  slack: SlackStatus | null;
  /** A browser login is in progress; we poll until the provider reports loggedIn. */
  connectingProvider: ProviderId | null;
  /** Model picked before a conversation exists. */
  draftModelId: string | null;

  sidebarOpen: boolean;
  computerPanelOpen: boolean;
  /** Null = no section chosen yet: bare "/settings" shows General on desktop, the section list on mobile. */
  settingsSection: SettingsSection | null;
  /** Path to return to when leaving settings; null falls back to the active agent's home. */
  settingsReturnPath: string | null;
  /** Local edit buffer shared by the General/Models/Computer sections; null outside an edit session. */
  settingsDraft: Settings | null;
  settingsSecrets: SecretDrafts;
  settingsSaving: boolean;
  /** "Discard unsaved changes?" guard for navigating away from a dirty `settingsDraft`. */
  settingsConfirmOpen: boolean;
  settingsPendingNav: (() => void) | null;
  /** The open chat's message list has scrolled past its top; Header uses this to
   * decide whether to show its floating blurred background. */
  chatScrolled: boolean;
}

const SIDEBAR_KEY = "tot:sidebar";
const isDesktop = () => window.matchMedia("(min-width: 768px)").matches;

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode); the preference just won't stick.
  }
}

export const useStore = create<TotState>()(() => ({
  agents: [],
  agentsState: "loading",
  homeAgentId: null,
  newAgentDialogOpen: false,
  agentSettingsOpen: false,
  agentSettingsTab: "profile",
  runningAgents: new Set(),
  pendingApprovals: new Set(),

  page: "home",
  conversations: [],
  conversationsState: "loading",
  currentId: null,
  wikiPageId: null,
  wikiEvent: null,
  viewKey: 0,
  messages: {},
  detailState: {},
  activeRuns: {},
  sending: false,
  justFinished: {},
  models: [],
  providers: [],
  settings: null,
  settingsState: "loading",
  github: null,
  apps: null,
  slack: null,
  connectingProvider: null,
  draftModelId: null,

  sidebarOpen: isDesktop() && readPref(SIDEBAR_KEY) !== "closed",
  computerPanelOpen: false,
  settingsSection: null,
  settingsReturnPath: null,
  settingsDraft: null,
  settingsSecrets: EMPTY_SECRETS,
  settingsSaving: false,
  settingsConfirmOpen: false,
  settingsPendingNav: null,
  chatScrolled: false,
}));

const get = useStore.getState;
const set = useStore.setState;

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export const selectCurrentConversation = (s: TotState): Conversation | undefined =>
  s.currentId ? s.conversations.find((c) => c.id === s.currentId) : undefined;

/** The agent behind the current screen: the open chat's agent, or the home agent. */
export function selectActiveAgentId(s: TotState): string | null {
  const conversation = selectCurrentConversation(s);
  if (conversation) return conversation.agentId;
  return s.homeAgentId ?? s.agents[0]?.id ?? null;
}

export function selectActiveAgent(s: TotState): Agent | undefined {
  const id = selectActiveAgentId(s);
  return id ? s.agents.find((a) => a.id === id) : undefined;
}

export const selectCurrentModelId = (s: TotState): string =>
  selectCurrentConversation(s)?.modelId ??
  s.draftModelId ??
  selectActiveAgent(s)?.modelId ??
  s.settings?.defaultModelId ??
  AUTO_MODEL_ID;

/** True while any of an agent's chats has a run in flight (sidebar/mascot indicator). */
export function selectAgentWorking(s: TotState, agentId: string): boolean {
  if (s.runningAgents.has(agentId)) return true;
  return Object.keys(s.activeRuns).some(
    (conversationId) => s.conversations.find((c) => c.id === conversationId)?.agentId === agentId,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function sortConversations(list: Conversation[]): Conversation[] {
  return [...list].sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt));
}

function upsertConversation(list: Conversation[], conversation: Conversation): Conversation[] {
  return sortConversations([conversation, ...list.filter((c) => c.id !== conversation.id)]);
}

function patchConversation(id: string, patch: Partial<Conversation>) {
  set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
}

function setMessages(id: string, update: (messages: Message[]) => Message[]) {
  set((s) => ({ messages: { ...s.messages, [id]: update(s.messages[id] ?? []) } }));
}

/** Toast an error once, even if several requests fail the same way. */
export function notifyError(error: unknown) {
  const message = errorMessage(error);
  toast.error(message, { id: message });
}

let localIds = 0;
const localId = () => `local-${Date.now().toString(36)}-${(localIds++).toString(36)}`;

// ---------------------------------------------------------------------------
// Bootstrapping & reference data
// ---------------------------------------------------------------------------

let initialized = false;

export function initApp() {
  if (initialized) return;
  initialized = true;
  void loadAgents();
  void loadConversations();
  void refreshProviders();
  void loadSettings();
  void loadGithubStatus();
  void loadAppsStatus();
  void loadSlackStatus();
}

export async function loadAgents() {
  const hadAgents = get().agents.length > 0;
  set({ agentsState: hadAgents ? "ready" : "loading" });
  try {
    const agents = await api.listAgents();
    set({ agents, agentsState: "ready" });
    const s = get();
    const homeUnresolved =
      s.page === "home" && (s.homeAgentId === null || !agents.some((a) => a.id === s.homeAgentId));
    if (homeUnresolved && agents.length > 0) redirectHome();
  } catch (error) {
    set({ agentsState: hadAgents ? "ready" : "error" });
    notifyError(error);
  }
}

export async function loadConversations({ quiet = false } = {}) {
  try {
    const conversations = await api.listConversations();
    set({ conversations: sortConversations(conversations), conversationsState: "ready" });
  } catch (error) {
    if (get().conversationsState !== "ready") set({ conversationsState: "error" });
    if (!quiet) notifyError(error);
  }
}

/** Providers and models change together (login state gates availability). */
export async function refreshProviders({ quiet = false } = {}) {
  const [models, providers] = await Promise.allSettled([api.listModels(), api.listProviders()]);
  if (models.status === "fulfilled") set({ models: models.value });
  if (providers.status === "fulfilled") set({ providers: providers.value });
  const failure = [models, providers].find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failure && !quiet) notifyError(failure.reason);
}

const LOGIN_POLL_MS = 3_000;
const LOGIN_TIMEOUT_MS = 3 * 60_000;
let loginPoll: number | undefined;

/**
 * Browser login (ChatGPT): open the provider's login page in a new tab, then
 * poll provider status until it reports loggedIn (or we give up).
 */
export async function connectProvider(id: ProviderId) {
  // Open the tab synchronously (inside the click) so popup blockers allow it.
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  let url: string;
  try {
    ({ url } = await api.loginProvider(id));
  } catch (error) {
    tab?.close();
    notifyError(error);
    return;
  }
  if (tab) tab.location.href = url;
  else window.open(url, "_blank", "noopener");

  window.clearInterval(loginPoll);
  set({ connectingProvider: id });
  const startedAt = Date.now();
  const label = PROVIDER_LABELS[id];

  loginPoll = window.setInterval(async () => {
    if (Date.now() - startedAt > LOGIN_TIMEOUT_MS) {
      window.clearInterval(loginPoll);
      set({ connectingProvider: null });
      toast.error(`Didn't see a ${label} login yet. Finish signing in, then press Refresh.`);
      return;
    }
    try {
      const providers = await api.listProviders({ refresh: true });
      set({ providers });
      if (providers.find((p) => p.id === id)?.loggedIn) {
        window.clearInterval(loginPoll);
        set({ connectingProvider: null });
        toast.success(`${label} connected`);
        void refreshProviders({ quiet: true });
      }
    } catch {
      // Keep polling; the server may be restarting the harness.
    }
  }, LOGIN_POLL_MS);
}

export async function loadSettings() {
  set({ settingsState: get().settings ? "ready" : "loading" });
  try {
    set({ settings: await api.getSettings(), settingsState: "ready" });
  } catch (error) {
    set({ settingsState: get().settings ? "ready" : "error" });
    notifyError(error);
  }
}

export async function saveSettings(patch: SettingsPatch): Promise<boolean> {
  try {
    set({ settings: await api.updateSettings(patch) });
    void refreshProviders({ quiet: true });
    return true;
  } catch (error) {
    notifyError(error);
    return false;
  }
}

/** Loaded at app init and refreshed whenever the Settings dialog opens; also kept live via the `github` AppEvent. */
export async function loadGithubStatus() {
  try {
    setGithubStatus(await api.getGithubStatus());
  } catch (error) {
    notifyError(error);
  }
}

/** Set after a connect/disconnect/writes-toggle call, or from the `github` AppEvent. */
export function setGithubStatus(status: GitHubStatus) {
  set({ github: status });
}

/** Loaded at app init and refreshed whenever the Settings dialog opens; also kept live via the `apps` AppEvent. */
export async function loadAppsStatus() {
  try {
    setAppsStatus(await api.getApps());
  } catch (error) {
    notifyError(error);
  }
}

/** Set after a setup/stop call, a poll, or from the `apps` AppEvent. */
export function setAppsStatus(status: AppsStatus) {
  set({ apps: status });
}

/** Loaded at app init and refreshed whenever the Settings dialog opens; also kept live via the `slack` AppEvent. */
export async function loadSlackStatus() {
  try {
    setSlackStatus(await api.getSlack());
  } catch (error) {
    notifyError(error);
  }
}

/** Set after a connect/patch/disconnect call, or from the `slack` AppEvent. */
export function setSlackStatus(status: SlackStatus) {
  set({ slack: status });
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export const setNewAgentDialogOpen = (open: boolean) => set({ newAgentDialogOpen: open });

/** Opens the settings panel for an agent (switching to it first), in place of the computer panel. */
export function openAgentSettings(agentId: string, tab: AgentSettingsTab = "profile") {
  if (selectActiveAgentId(get()) !== agentId) navigateToAgentHome(agentId);
  set({ agentSettingsOpen: true, agentSettingsTab: tab, computerPanelOpen: false });
}

export const closeAgentSettings = () => set({ agentSettingsOpen: false });

export function setAgentSettingsTab(tab: AgentSettingsTab) {
  set({ agentSettingsTab: tab });
}

export async function createAgent(input: AgentInput): Promise<Agent | null> {
  try {
    const agent = await api.createAgent(input);
    set((s) => ({ agents: [...s.agents, agent] }));
    setNewAgentDialogOpen(false);
    return agent;
  } catch (error) {
    notifyError(error);
    return null;
  }
}

export async function updateAgent(id: string, input: Partial<AgentInput>): Promise<boolean> {
  try {
    const agent = await api.updateAgent(id, input);
    set((s) => ({ agents: s.agents.map((a) => (a.id === id ? agent : a)) }));
    return true;
  } catch (error) {
    notifyError(error);
    return false;
  }
}

export async function deleteAgent(id: string): Promise<boolean> {
  if (get().agents.length <= 1) {
    toast.error("You need at least one agent.");
    return false;
  }
  const wasActive = selectActiveAgentId(get()) === id;
  const fallbackId = get().agents.find((a) => a.id !== id)?.id ?? null;
  try {
    await api.deleteAgent(id);
  } catch (error) {
    notifyError(error);
    return false;
  }
  set((s) => ({
    agents: s.agents.filter((a) => a.id !== id),
    conversations: s.conversations.filter((c) => c.agentId !== id),
  }));
  closeAgentSettings();
  if (wasActive && fallbackId) navigateToAgentHome(fallbackId);
  void loadConversations({ quiet: true });
  return true;
}

export async function stopAgentComputer(agentId: string) {
  try {
    const computer = await api.stopAgentComputer(agentId);
    set((s) => ({
      agents: s.agents.map((a) => (a.id === agentId ? { ...a, computer } : a)),
      conversations: s.conversations.map((c) => (c.agentId === agentId ? { ...c, computer } : c)),
    }));
  } catch (error) {
    notifyError(error);
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function showAgentHome(agentId: string | null) {
  set({ currentId: null, homeAgentId: agentId, computerPanelOpen: false });
}

function showWiki(agentId: string, pageId: string | null) {
  set({ currentId: null, homeAgentId: agentId, wikiPageId: pageId, computerPanelOpen: false, agentSettingsOpen: false });
}

function redirectHome() {
  const target = get().agents[0]?.id ?? null;
  replacePath(target ? agentPath(target) : "/");
  set({ page: "home" });
  showAgentHome(target);
}

/** Apply the current URL (initial load and back/forward). */
export function syncWithLocation() {
  const pathname = window.location.pathname;
  set((s) => ({ viewKey: s.viewKey + 1 }));

  if (isSettingsPath(pathname)) {
    set({ page: "settings", settingsSection: settingsSectionFromPath(pathname) });
    return;
  }
  if (pathname === MASCOTS_PATH) {
    set({ page: "mascots" });
    return;
  }
  const wiki = wikiFromPath(pathname);
  if (wiki) {
    set({ page: "wiki" });
    showWiki(wiki.agentId, wiki.pageId);
    return;
  }
  const conversationId = conversationIdFromPath(pathname);
  if (conversationId) {
    set({ page: "chat" });
    void openConversation(conversationId);
    return;
  }
  const agentId = agentIdFromPath(pathname);
  if (agentId) {
    set({ page: "home" });
    showAgentHome(agentId);
    return;
  }
  redirectHome();
}

/** Go to an agent's home (new-chat) screen. */
export function navigateToAgentHome(agentId: string) {
  if (!isDesktop()) set({ sidebarOpen: false });
  const s = get();
  if (s.currentId === null && s.page === "home" && s.homeAgentId === agentId) return;
  pushPath(agentPath(agentId));
  set((s2) => ({ viewKey: s2.viewKey + 1, page: "home" }));
  showAgentHome(agentId);
}

/** Open a conversation. */
export function navigateToConversation(id: string) {
  if (!isDesktop()) set({ sidebarOpen: false });
  if (id === get().currentId) return;
  pushPath(conversationPath(id));
  set((s) => ({ viewKey: s.viewKey + 1, page: "chat" }));
  void openConversation(id);
}

/** Open an agent's wiki (optionally to a specific page); makes that agent active and pushes a fresh history entry. */
export function navigateToWiki(agentId: string, pageId?: string | null) {
  if (!isDesktop()) set({ sidebarOpen: false });
  const s = get();
  const targetPageId = pageId ?? null;
  if (s.page === "wiki" && s.homeAgentId === agentId && s.wikiPageId === targetPageId) return;
  pushPath(wikiPath(agentId, targetPageId));
  set((s2) => ({ viewKey: s2.viewKey + 1, page: "wiki" }));
  showWiki(agentId, targetPageId);
}

/**
 * Switch the page shown within the wiki that's already open, without remounting
 * the view (so the tree's scroll position and search box survive) — mirrors how
 * `sendMessage` moves from the home screen into a chat without a route change.
 */
export function openWikiPage(pageId: string | null) {
  const s = get();
  if (s.page !== "wiki" || !s.homeAgentId || s.wikiPageId === pageId) return;
  pushPath(wikiPath(s.homeAgentId, pageId));
  set({ wikiPageId: pageId });
}

async function openConversation(id: string) {
  if (get().currentId !== id) set({ currentId: id, computerPanelOpen: false });
  // While we follow a live run, the in-memory messages are the freshest copy.
  if (streams.has(id)) return;
  await loadConversation(id);
}

/**
 * Fetch a conversation and its messages. If a run is still active, drop the
 * partial assistant message and rebuild it from the replayed event stream.
 */
async function loadConversation(id: string, { attach = true } = {}) {
  set((s) => ({ detailState: { ...s.detailState, [id]: s.messages[id] ? "ready" : "loading" } }));
  try {
    const detail = await api.getConversation(id);
    if (streams.has(id)) {
      // A message was sent while we were loading: keep the live messages and
      // put the fetched history in front of them.
      set((s) => {
        const live = s.messages[id] ?? [];
        const liveIds = new Set(live.map((m) => m.id));
        const history = detail.messages.filter((m) => !liveIds.has(m.id) && m.status !== "streaming");
        return {
          conversations: upsertConversation(s.conversations, detail.conversation),
          messages: { ...s.messages, [id]: [...history, ...live] },
          detailState: { ...s.detailState, [id]: "ready" },
        };
      });
      return;
    }
    const runId = attach ? detail.activeRunId : null;
    const messages = runId
      ? detail.messages.filter((m) => !(m.role === "assistant" && m.status === "streaming"))
      : detail.messages;
    set((s) => ({
      conversations: upsertConversation(s.conversations, detail.conversation),
      messages: { ...s.messages, [id]: messages },
      detailState: { ...s.detailState, [id]: "ready" },
    }));
    if (runId) attachRun(id, runId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      forgetConversation(id);
      if (get().currentId === id) {
        toast.error("That chat doesn't exist anymore.");
        redirectHome();
      }
      return;
    }
    set((s) => ({ detailState: { ...s.detailState, [id]: s.messages[id] ? "ready" : "error" } }));
    notifyError(error);
  }
}

export function retryConversation(id: string) {
  void loadConversation(id);
}

function forgetConversation(id: string) {
  const stream = streams.get(id);
  if (stream) detachRun(id, stream.runId);
  set((s) => ({
    conversations: s.conversations.filter((c) => c.id !== id),
    messages: without(s.messages, id),
    detailState: without(s.detailState, id),
    activeRuns: without(s.activeRuns, id),
  }));
}

// ---------------------------------------------------------------------------
// Runs & streaming
// ---------------------------------------------------------------------------

const streams = new Map<string, { runId: string; unsubscribe: () => void }>();
const lostCounts = new Map<string, number>();
const justFinishedTimers = new Map<string, number>();

function attachRun(conversationId: string, runId: string) {
  const existing = streams.get(conversationId);
  if (existing?.runId === runId) return;
  if (existing) detachRun(conversationId, existing.runId);

  set((s) => ({
    activeRuns: { ...s.activeRuns, [conversationId]: { runId, messageId: null, stopping: false } },
    justFinished: without(s.justFinished, conversationId),
  }));
  const unsubscribe = subscribeToRun(runId, {
    onEvent: (event) => enqueue(conversationId, runId, event),
    onLost: () => handleLostRun(conversationId, runId),
  });
  streams.set(conversationId, { runId, unsubscribe });
}

function detachRun(conversationId: string, runId: string) {
  const stream = streams.get(conversationId);
  if (stream?.runId !== runId) return;
  stream.unsubscribe();
  streams.delete(conversationId);
}

/**
 * The stream ended without `run-end` (e.g. HTTP 204: the run is unknown or
 * already fully delivered). Re-fetch to get the final persisted messages.
 */
function handleLostRun(conversationId: string, runId: string) {
  flushEvents();
  detachRun(conversationId, runId);
  set((s) => ({ activeRuns: without(s.activeRuns, conversationId) }));
  const attempts = (lostCounts.get(runId) ?? 0) + 1;
  lostCounts.set(runId, attempts);
  // Only re-attach a couple of times, so a broken run can't loop forever.
  window.setTimeout(() => void loadConversation(conversationId, { attach: attempts < 3 }), 500);
}

/** Mark a conversation's mascot "happy" briefly, then let it settle to idle. */
function markJustFinished(conversationId: string) {
  set((s) => ({ justFinished: { ...s.justFinished, [conversationId]: true } }));
  window.clearTimeout(justFinishedTimers.get(conversationId));
  justFinishedTimers.set(
    conversationId,
    window.setTimeout(() => {
      set((s) => ({ justFinished: without(s.justFinished, conversationId) }));
      justFinishedTimers.delete(conversationId);
    }, MASCOT_HAPPY_MS),
  );
}

// Events are applied in batches, once per frame, so fast token streams and
// replays render smoothly instead of re-rendering per delta.
let queue: { conversationId: string; runId: string; event: RunEvent }[] = [];
let flushScheduled = false;

function enqueue(conversationId: string, runId: string, event: RunEvent) {
  queue.push({ conversationId, runId, event });
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(flushEvents);
  window.setTimeout(flushEvents, 250); // rAF doesn't fire in background tabs.
}

function flushEvents() {
  flushScheduled = false;
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];

  let { conversations, messages, activeRuns, agents } = get();
  const finished: { conversationId: string; runId: string; happy: boolean }[] = [];
  let conversationsChanged = false;

  for (const { conversationId, runId, event } of batch) {
    const run = activeRuns[conversationId];
    if (run?.runId !== runId) continue; // Stale stream.
    const list = messages[conversationId] ?? [];

    switch (event.type) {
      case "run-start":
        activeRuns = { ...activeRuns, [conversationId]: { ...run, messageId: event.messageId } };
        messages = { ...messages, [conversationId]: upsertMessage(list, createAssistantMessage(event)) };
        break;
      case "conversation":
        conversations = upsertConversation(conversations, event.conversation);
        conversationsChanged = true;
        break;
      case "computer": {
        conversations = conversations.map((c) =>
          c.id === conversationId ? { ...c, computer: event.computer } : c,
        );
        const ownerId = conversations.find((c) => c.id === conversationId)?.agentId;
        if (ownerId) {
          agents = agents.map((a) => (a.id === ownerId ? { ...a, computer: event.computer } : a));
        }
        break;
      }
      case "run-end":
        messages = { ...messages, [conversationId]: upsertMessage(list, event.message) };
        activeRuns = without(activeRuns, conversationId);
        finished.push({ conversationId, runId, happy: event.message.status === "complete" });
        conversationsChanged = true;
        break;
      default: {
        const messageId = run.messageId;
        if (!messageId) break; // Nothing to apply to before run-start.
        messages = {
          ...messages,
          [conversationId]: list.map((m) => (m.id === messageId ? applyRunEvent(m, event) : m)),
        };
      }
    }
  }

  set({ conversations, messages, activeRuns, agents });
  for (const { conversationId, runId, happy } of finished) {
    detachRun(conversationId, runId);
    lostCounts.delete(runId);
    if (happy) markJustFinished(conversationId);
  }
  if (conversationsChanged) scheduleConversationsRefresh();
}

let refreshTimer: number | undefined;

function scheduleConversationsRefresh() {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void loadConversations({ quiet: true }), 400);
}

// ---------------------------------------------------------------------------
// Chat actions
// ---------------------------------------------------------------------------

export interface SendMessageOptions {
  thinkHarder?: boolean;
  attachments?: Attachment[];
}

/** Send a message; creates the conversation first on an agent's home screen. */
export async function sendMessage(
  text: string,
  { thinkHarder = false, attachments = [] }: SendMessageOptions = {},
): Promise<boolean> {
  const body = text.trim();
  if ((!body && attachments.length === 0) || get().sending) return false;
  set({ sending: true });

  let conversationId = get().currentId;
  const tempId = localId();
  try {
    if (!conversationId) {
      const { homeAgentId, agents, draftModelId, settings } = get();
      const conversation = await api.createConversation({
        agentId: homeAgentId ?? agents[0]?.id,
        modelId: draftModelId ?? settings?.defaultModelId ?? AUTO_MODEL_ID,
      });
      conversationId = conversation.id;
      set((s) => ({
        conversations: upsertConversation(s.conversations, conversation),
        messages: { ...s.messages, [conversation.id]: [] },
        detailState: { ...s.detailState, [conversation.id]: "ready" },
        currentId: conversation.id,
        page: "chat",
        draftModelId: null,
      }));
      pushPath(conversationPath(conversation.id));
    }

    const id = conversationId;
    const parts: Message["parts"] = [
      ...attachments.map((attachment) => ({
        type: "file" as const,
        id: `${tempId}-file-${attachment.id}`,
        attachment,
      })),
      ...(body ? [{ type: "text" as const, id: `${tempId}-text`, text: body }] : []),
    ];
    setMessages(id, (list) => [
      ...list,
      {
        id: tempId,
        conversationId: id,
        role: "user",
        parts,
        status: "complete",
        createdAt: Date.now(),
      },
    ]);

    const modelId = get().conversations.find((c) => c.id === id)?.modelId;
    const response = await api.sendMessage(id, {
      text: body,
      modelId,
      ...(attachments.length ? { attachments: attachments.map((a) => a.id) } : {}),
      ...(thinkHarder ? { thinkHarder: true } : {}),
    });

    set((s) => ({
      conversations: upsertConversation(s.conversations, response.conversation),
      messages: {
        ...s.messages,
        [id]: (s.messages[id] ?? []).map((m) => (m.id === tempId ? response.userMessage : m)),
      },
    }));
    attachRun(id, response.runId);
    return true;
  } catch (error) {
    if (conversationId) {
      setMessages(conversationId, (list) => list.filter((m) => m.id !== tempId));
    }
    notifyError(error);
    return false;
  } finally {
    set({ sending: false });
  }
}

export async function stopRun(conversationId: string) {
  const run = get().activeRuns[conversationId];
  if (!run || run.stopping) return;
  const setStopping = (stopping: boolean) =>
    set((s) => {
      const current = s.activeRuns[conversationId];
      return current?.runId === run.runId
        ? { activeRuns: { ...s.activeRuns, [conversationId]: { ...current, stopping } } }
        : {};
    });

  setStopping(true);
  try {
    await api.stopRun(run.runId); // The stream then ends with run-end "stopped".
  } catch (error) {
    setStopping(false);
    notifyError(error);
  }
}

/** Change the model of the open chat, or of the next new chat. */
export async function setModel(modelId: string) {
  const conversation = selectCurrentConversation(get());
  if (!conversation) {
    set({ draftModelId: modelId });
    return;
  }
  if (conversation.modelId === modelId) return;
  await updateConversation(conversation.id, { modelId });
}

async function updateConversation(id: string, patch: UpdateConversationRequest) {
  const previous = get().conversations.find((c) => c.id === id);
  if (!previous) return;
  patchConversation(id, patch);
  try {
    const updated = await api.updateConversation(id, patch);
    set((s) => ({ conversations: upsertConversation(s.conversations, updated) }));
  } catch (error) {
    const revert: Partial<Conversation> = {};
    if (patch.title !== undefined) revert.title = previous.title;
    if (patch.pinned !== undefined) revert.pinned = previous.pinned;
    if (patch.modelId !== undefined) revert.modelId = previous.modelId;
    patchConversation(id, revert);
    notifyError(error);
  }
}

export function renameConversation(id: string, title: string) {
  const trimmed = title.trim();
  const current = get().conversations.find((c) => c.id === id);
  if (!trimmed || trimmed === current?.title) return;
  void updateConversation(id, { title: trimmed });
}

export function togglePinned(id: string) {
  const current = get().conversations.find((c) => c.id === id);
  if (current) void updateConversation(id, { pinned: !current.pinned });
}

export async function deleteConversation(id: string) {
  try {
    await api.deleteConversation(id);
  } catch (error) {
    notifyError(error);
    return;
  }
  const wasCurrent = get().currentId === id;
  const agentId = get().conversations.find((c) => c.id === id)?.agentId ?? null;
  forgetConversation(id);
  if (wasCurrent) {
    if (agentId) navigateToAgentHome(agentId);
    else redirectHome();
  }
}

// ---------------------------------------------------------------------------
// Live app events (GET /api/events, see useAppEvents) — keeps every tab in
// sync with background work: routine runs, agents created/edited/deleted
// elsewhere, chats appearing/disappearing, computers starting and stopping.
// ---------------------------------------------------------------------------

/** Ids of agents with a run in flight, from `useRunningAgents()`. */
export function setRunningAgents(ids: Set<string>) {
  set({ runningAgents: ids });
}

function handleAgentEvent(agent: Agent) {
  set((s) => ({
    agents: s.agents.some((a) => a.id === agent.id)
      ? s.agents.map((a) => (a.id === agent.id ? agent : a))
      : [...s.agents, agent],
  }));
}

function handleAgentDeletedEvent(agentId: string) {
  if (!get().agents.some((a) => a.id === agentId)) return;
  const wasActive = selectActiveAgentId(get()) === agentId;
  const fallbackId = get().agents.find((a) => a.id !== agentId)?.id ?? null;
  set((s) => ({
    agents: s.agents.filter((a) => a.id !== agentId),
    conversations: s.conversations.filter((c) => c.agentId !== agentId),
  }));
  if (wasActive && fallbackId) navigateToAgentHome(fallbackId);
}

function handleConversationEvent(conversation: Conversation) {
  set((s) => ({ conversations: upsertConversation(s.conversations, conversation) }));
}

function handleConversationDeletedEvent(conversationId: string) {
  if (!get().conversations.some((c) => c.id === conversationId)) return;
  const wasCurrent = get().currentId === conversationId;
  const agentId = get().conversations.find((c) => c.id === conversationId)?.agentId ?? null;
  forgetConversation(conversationId);
  if (wasCurrent) {
    toast.message("This chat was deleted.");
    if (agentId) navigateToAgentHome(agentId);
    else redirectHome();
  }
}

function handleComputerEvent(agentId: string, computer: ComputerSummary) {
  set((s) => ({
    agents: s.agents.map((a) => (a.id === agentId ? { ...a, computer } : a)),
    conversations: s.conversations.map((c) => (c.agentId === agentId ? { ...c, computer } : c)),
  }));
}

/**
 * An agent's wiki changed (a tool call, or the background keeper). `wikiEvent`
 * is a plain ping an open WikiView watches to refetch; when the change also
 * touched a chat (the keeper folding in what it learned), reload that chat's
 * messages too, unless it's actively streaming and already showing them live.
 */
function handleWikiEvent(agentId: string, conversationId?: string) {
  set({ wikiEvent: { agentId, conversationId, at: Date.now() } });
  if (conversationId && get().currentId === conversationId && !get().activeRuns[conversationId]) {
    void loadConversation(conversationId);
  }
}

/**
 * The Slack bot's state or its people changed. Toasts once per newly-seen
 * request so the user notices someone wants access, with a shortcut into the
 * Slack settings section to review it.
 */
function handleSlackEvent(status: SlackStatus) {
  const previous = get().slack;
  setSlackStatus(status);
  if (!previous) return; // Don't toast for the first status a tab ever sees.
  const previousIds = new Set(previous.requests.map((r) => r.id));
  for (const person of status.requests) {
    if (previousIds.has(person.id)) continue;
    toast(`${person.name} wants to use TOT in Slack`, {
      action: { label: "Review", onClick: () => goToSettings("slack") },
    });
  }
}

/**
 * A chat is waiting for the user's approval, or no longer is (answered,
 * expired, or a background routine run moved on). Tracks `pendingApprovals`
 * for the sidebar's attention dot, and nudges with a toast when the
 * conversation isn't the one currently open.
 */
function handleApprovalEvent(event: Extract<AppEvent, { type: "approval" }>) {
  set((s) => {
    if (s.pendingApprovals.has(event.conversationId) === event.pending) return {};
    const next = new Set(s.pendingApprovals);
    if (event.pending) next.add(event.conversationId);
    else next.delete(event.conversationId);
    return { pendingApprovals: next };
  });
  if (!event.pending || get().currentId === event.conversationId) return;
  const agentName = get().agents.find((a) => a.id === event.agentId)?.name ?? "Your agent";
  toast(`${agentName} needs your OK`, {
    description: truncate(event.message, 140),
    action: { label: "Open", onClick: () => navigateToConversation(event.conversationId) },
  });
}

/** Dispatch one app-wide SSE event into the store. Pass to `useAppEvents`. */
export function handleAppEvent(event: AppEvent) {
  switch (event.type) {
    case "agent":
      handleAgentEvent(event.agent);
      break;
    case "agent-deleted":
      handleAgentDeletedEvent(event.agentId);
      break;
    case "conversation":
      handleConversationEvent(event.conversation);
      break;
    case "conversation-deleted":
      handleConversationDeletedEvent(event.conversationId);
      break;
    case "computer":
      handleComputerEvent(event.agentId, event.computer);
      break;
    case "wiki":
      handleWikiEvent(event.agentId, event.conversationId);
      break;
    case "github":
      setGithubStatus(event.status);
      break;
    case "apps":
      setAppsStatus(event.status);
      break;
    case "slack":
      handleSlackEvent(event.status);
      break;
    case "approval":
      handleApprovalEvent(event);
      break;
    case "run":
      // Handled separately by useRunningAgents() + setRunningAgents.
      break;
  }
}

/** The app-events channel dropped and came back; no-replay, so refetch lists. */
export function handleAppReconnect() {
  void loadAgents();
  void loadConversations({ quiet: true });
}

// ---------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------

export function setSidebarOpen(open: boolean) {
  set({ sidebarOpen: open });
  if (isDesktop()) writePref(SIDEBAR_KEY, open ? "open" : "closed");
}

export const toggleSidebar = () => setSidebarOpen(!get().sidebarOpen);
/** The computer and agent-settings panels share the right side, so opening one closes the other. */
export const setComputerPanelOpen = (open: boolean) =>
  set(open ? { computerPanelOpen: true, agentSettingsOpen: false } : { computerPanelOpen: false });
export function setChatScrolled(value: boolean) {
  if (get().chatScrolled !== value) set({ chatScrolled: value });
}

// ---------------------------------------------------------------------------
// Settings page (General / Models / Memory / Computer / GitHub / Apps / Plugins)
// ---------------------------------------------------------------------------

/** Navigate straight to settings (or a section within it); no unsaved-changes guard. */
function openSettingsRaw(section?: SettingsSection) {
  const s = get();
  const path = settingsPath(section);
  if (s.page === "settings") {
    if (window.location.pathname === path) return;
    pushPath(path);
    set({ settingsSection: section ?? null });
    return;
  }
  const returnPath = window.location.pathname;
  if (!isDesktop()) set({ sidebarOpen: false });
  pushPath(path);
  set((s2) => ({
    viewKey: s2.viewKey + 1,
    page: "settings",
    settingsSection: section ?? null,
    settingsReturnPath: returnPath,
    settingsDraft: s2.settings,
    settingsSecrets: EMPTY_SECRETS,
  }));
}

/** Leave settings for wherever the user was before (or the active agent's home); no guard. */
function closeSettingsRaw() {
  const s = get();
  const agentId = selectActiveAgentId(s);
  pushPath(s.settingsReturnPath ?? (agentId ? agentPath(agentId) : "/"));
  syncWithLocation();
  set({ settingsReturnPath: null, settingsDraft: null, settingsSecrets: EMPTY_SECRETS });
}

/** Run `action` now, or defer it behind the "Discard unsaved changes?" confirm when `settingsDraft` is dirty. */
function navigateSettingsGuarded(action: () => void) {
  if (!selectSettingsDirty(get())) {
    action();
    return;
  }
  set({ settingsConfirmOpen: true, settingsPendingNav: action });
}

/** Open settings, or switch to a section within it. The one entry point every "go to Settings" link should use. */
export function goToSettings(section?: SettingsSection) {
  navigateSettingsGuarded(() => openSettingsRaw(section));
}

/** Settings' own back arrow / Escape: leave settings entirely. */
export function exitSettings() {
  navigateSettingsGuarded(closeSettingsRaw);
}

/** Mobile only: back out of an open section to the section list, without leaving settings. */
export function backToSettingsList() {
  navigateSettingsGuarded(() => {
    pushPath(settingsPath());
    set({ settingsSection: null });
  });
}

/** Confirm leaving a dirty section: discard the draft, then run the navigation that was waiting on it. */
export function confirmSettingsDiscard() {
  const action = get().settingsPendingNav;
  set((s) => ({
    settingsConfirmOpen: false,
    settingsPendingNav: null,
    settingsDraft: s.settings,
    settingsSecrets: EMPTY_SECRETS,
  }));
  action?.();
}

export function cancelSettingsDiscard() {
  // `ConfirmDialog`'s Confirm button fires `onOpenChange(false)` (routed here) just
  // before `onConfirm` (routed to `confirmSettingsDiscard`), so `settingsPendingNav`
  // must survive this call — only `confirmSettingsDiscard` clears it, once it's read.
  set({ settingsConfirmOpen: false });
}

export function setSettingsDraft(next: Settings) {
  set({ settingsDraft: next });
}

export function setSettingsSecrets(update: (current: SecretDrafts) => SecretDrafts) {
  set((s) => ({ settingsSecrets: update(s.settingsSecrets) }));
}

export function discardSettingsDraft() {
  set((s) => ({ settingsDraft: s.settings, settingsSecrets: EMPTY_SECRETS }));
}

/** Save the pending patch across General/Models/Computer (whichever fields differ from `settings`). */
export async function saveSettingsDraft(): Promise<boolean> {
  const patch = selectSettingsPatch(get());
  set({ settingsSaving: true });
  const ok = await saveSettings(patch);
  set({ settingsSaving: false });
  if (ok) {
    set((s) => ({ settingsDraft: s.settings, settingsSecrets: EMPTY_SECRETS }));
    toast.success("Settings saved");
  }
  return ok;
}

export function selectSettingsPatch(s: TotState): SettingsPatch {
  if (!s.settings || !s.settingsDraft) return {};
  return buildSettingsPatch(s.settings, s.settingsDraft, s.settingsSecrets);
}

export function selectSettingsDirty(s: TotState): boolean {
  return Object.keys(selectSettingsPatch(s)).length > 0;
}

export function selectSettingsValid(s: TotState): boolean {
  if (!s.settingsDraft) return true;
  return s.settingsDraft.computer.mode === "off" || isValidIdleMinutes(s.settingsDraft.computer.idleStopMinutes);
}

/** Open the sidebar (if needed) and focus its search box. */
export function focusSearch() {
  if (!get().sidebarOpen) setSidebarOpen(true);
  requestAnimationFrame(() => document.getElementById("chat-search")?.focus());
}
