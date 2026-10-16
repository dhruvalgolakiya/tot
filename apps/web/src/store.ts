import { useMemo } from "react";
import { create } from "zustand";
import { toast } from "sonner";
import type {
  Agent,
  AgentInput,
  AppEvent,
  AppsStatus,
  Attachment,
  ChatWorkspaceMode,
  ComputerSummary,
  Conversation,
  Brain,
  GitHubStatus,
  MailSummary,
  Message,
  MessagePart,
  ModelOption,
  Persona,
  ProviderId,
  ProviderStatus,
  RunEvent,
  Settings,
  SettingsPatch,
  SlackStatus,
  TaskPatch,
  UpdateConversationRequest,
} from "@shared/types";
import { api, ApiError, errorMessage } from "./lib/api";
import { toMs, truncate } from "./lib/format";
import { AUTO_MODEL_ID, PROVIDER_LABELS } from "./lib/models";
import { deviceOf, onDevice } from "./lib/devices";
import { isCodeProject, loadProjects, upsertProject, useProjects } from "./lib/projects";
import { memoryChanged } from "./lib/memory";
import { handleDeviceDeleted, handleDeviceEvent, loadDevices, whenDevicesLoaded } from "./lib/remote";
import { applyRunEvent, createAssistantMessage, upsertMessage } from "./lib/reducer";
import {
  agentIdFromPath,
  agentPath,
  compareGroupFromPath,
  comparePath,
  conversationIdFromPath,
  conversationPath,
  CREW_PATH,
  isCrewPath,
  isSettingsPath,
  MASCOTS_PATH,
  missionFromLocation,
  missionPath,
  projectFromPath,
  projectPath,
  pushPath,
  replacePath,
  settingsPath,
  settingsSectionFromPath,
  type SettingsSection,
  TRUST_LAB_PATH,
  wikiFromPath,
  wikiPath,
} from "./lib/router";
import { buildSettingsPatch, EMPTY_SECRETS, isValidCleanupDays, isValidIdleMinutes, isValidTaskLimit, TASK_LIMITS, type SecretDrafts } from "./lib/settings";
import { newRequestId } from "./lib/mission";
import { subscribeToRun } from "./lib/stream";
import { isTask } from "./lib/tasks";

export type AgentSettingsTab = "profile" | "routines";
/** Tabs of the task side panel; later modules add their own (e.g. checks, the pull request). */
export type TaskPanelTab = "plan" | "changes" | "activity";
type LoadState = "loading" | "ready" | "error";

/**
 * Which top-level screen is showing; drives what `App` mounts. "mission" and "compare" are module 09's board and
 * best-of view; "crew" is every agent at a glance.
 */
export type Page = "home" | "chat" | "project" | "mascots" | "wiki" | "settings" | "trust-lab" | "mission" | "compare" | "crew";

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
  /** The open page of the wiki; null shows the open brain's Overview. Only meaningful when `page === "wiki"`. */
  wikiPageId: string | null;
  /** The brain open in the wiki; null means the open page's brain, or else the agent's notebook. */
  wikiBrainId: string | null;
  /** The project whose page is open; only meaningful when `page === "project"`. */
  projectId: string | null;
  /** Mission control's project filter (null = every project); only meaningful when `page === "mission"`. */
  missionProjectId: string | null;
  /** The best-of group being compared; only meaningful when `page === "compare"`. */
  compareGroup: string | null;
  /** Bumped whenever a brain's pages change (an AppEvent), for the open WikiView to react to. */
  wikiEvent: { brainId: string; conversationId?: string; at: number } | null;
  /** Every brain (notebooks and shared ones); null while still loading. */
  brains: Brain[] | null;
  /** Bumped on every navigation so the chat view remounts fresh. */
  viewKey: number;
  messages: Record<string, Message[]>;
  detailState: Record<string, LoadState>;
  activeRuns: Record<string, ActiveRun>;
  /** A message is on its way to the server (before a run id exists). */
  sending: boolean;
  /** Text of a message that failed after its chat was created elsewhere (a project's page), for the chat's composer to take back. */
  composerDraft: string | null;
  /** Conversations whose run just completed; mascot stays "happy" briefly. */
  justFinished: Record<string, boolean>;
  models: ModelOption[];
  /** Paired devices' models (module 07): another device's agent picks from its own device's. */
  deviceModels: Record<string, ModelOption[]>;
  /** Paired devices' brains (module 07): another device's agent's notebook and brains are on its device. */
  deviceBrains: Record<string, Brain[]>;
  providers: ProviderStatus[];
  settings: Settings | null;
  settingsState: LoadState;
  /** The app's one connected GitHub account (or null if none); null while still loading. */
  github: GitHubStatus | null;
  /** Apps (Executor): shared across agents; null while still loading. */
  apps: AppsStatus | null;
  /** TOT's Slack bot: shared across agents; null while still loading. */
  slack: SlackStatus | null;
  /** Identities agents can work as (own mailbox, optional GitHub). */
  personas: Persona[];
  personasState: LoadState;
  /** Bumped on every `mail` AppEvent; an open inbox watches this to insert the message live. */
  mailEvent: { personaId: string; mail: MailSummary; at: number } | null;
  /** Model picked before a conversation exists. */
  draftModelId: string | null;
  /** The project a new chat (one not sent yet) starts in: picked in its composer, or set by a project's "New chat". */
  draftProjectId: string | null;
  /** Where that new chat works when its project has code: the main checkout, or a new worktree of its own. */
  draftWorkspace: ChatWorkspaceMode;

  sidebarOpen: boolean;
  computerPanelOpen: boolean;
  /** Right-hand panel with the open task's plan, changes and activity. */
  taskPanelOpen: boolean;
  taskPanelTab: TaskPanelTab;
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
  wikiBrainId: null,
  projectId: null,
  missionProjectId: null,
  compareGroup: null,
  wikiEvent: null,
  brains: null,
  viewKey: 0,
  messages: {},
  detailState: {},
  activeRuns: {},
  sending: false,
  composerDraft: null,
  justFinished: {},
  models: [],
  deviceModels: {},
  deviceBrains: {},
  providers: [],
  settings: null,
  settingsState: "loading",
  github: null,
  apps: null,
  slack: null,
  personas: [],
  personasState: "loading",
  mailEvent: null,
  draftModelId: null,
  draftProjectId: null,
  draftWorkspace: "checkout",

  sidebarOpen: isDesktop() && readPref(SIDEBAR_KEY) !== "closed",
  computerPanelOpen: false,
  taskPanelOpen: false,
  taskPanelTab: "plan",
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

/** The models the active agent can use: its own device's (module 07). */
export const selectActiveModels = (s: TotState): ModelOption[] => {
  const deviceId = selectActiveAgent(s)?.deviceId;
  return deviceId ? (s.deviceModels[deviceId] ?? s.models) : s.models;
};

export function setDeviceModels(deviceId: string, models: ModelOption[]) {
  set((s) => ({ deviceModels: { ...s.deviceModels, [deviceId]: models } }));
}

export function setDeviceBrains(deviceId: string, brains: Brain[]) {
  set((s) => ({ deviceBrains: { ...s.deviceBrains, [deviceId]: brains } }));
}

export const selectCurrentModelId = (s: TotState): string =>
  selectCurrentConversation(s)?.modelId ??
  s.draftModelId ??
  selectActiveAgent(s)?.modelId ??
  s.settings?.defaultModelId ??
  AUTO_MODEL_ID;

/** This device's own agents, not a paired device's (module 07): for this device's settings, like Slack and personas. */
export function useLocalAgents(): Agent[] {
  const agents = useStore((s) => s.agents);
  return useMemo(() => agents.filter((a) => !a.deviceId), [agents]);
}

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

/** Plain-data equality (JSON-like values), for keeping unchanged objects as they are. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, index) => sameValue(item, other[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => key in right && sameValue(left[key], right[key]));
}

/**
 * A chat as it arrives from the server, against the copy in the store. A slim list's task (`partial`) keeps the whole
 * task the chat's own load or a live event brought, as long as what the list carries still matches it. When nothing
 * changed, the stored object itself comes back, so whatever shows it doesn't re-render.
 */
function shareConversation(existing: Conversation | undefined, incoming: Conversation): Conversation {
  let next = incoming;
  const whole = existing?.task;
  const partial = incoming.task;
  if (whole && !whole.partial && partial?.partial && partial.brief?.goal === whole.brief?.goal && partial.result?.summary === whole.result?.summary) {
    const { partial: _partial, ...rest } = partial;
    next = { ...incoming, task: { ...rest, brief: whole.brief, result: whole.result, handoff: whole.handoff } };
  }
  return existing && sameValue(existing, next) ? existing : next;
}

/** Whether two lists hold the same objects in the same order. */
function sameItems<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** A list of chats from the server, sharing every unchanged chat (and the list itself, when nothing changed) with `current`. */
function shareConversations(current: Conversation[], incoming: Conversation[]): Conversation[] {
  const byId = new Map(current.map((c) => [c.id, c]));
  const next = sortConversations(incoming.map((c) => shareConversation(byId.get(c.id), c)));
  return sameItems(next, current) ? current : next;
}

function upsertConversation(list: Conversation[], conversation: Conversation): Conversation[] {
  const existing = list.find((c) => c.id === conversation.id);
  const next = shareConversation(existing, conversation);
  if (next === existing) return list;
  return sortConversations([next, ...list.filter((c) => c.id !== conversation.id)]);
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
  void refreshProviders().then(watchProviders);
  void loadSettings();
  void loadGithubStatus();
  void loadBrains();
  void loadAppsStatus();
  void loadSlackStatus();
  void loadPersonas();
  void loadProjects().catch(notifyError);
  // Paired devices' agents, chats and projects join the lists (module 07); then a home agent from one resolves.
  void loadDevices().then(resolveHome);
}

/** The home agent named in the URL doesn't exist (anymore): go to the first agent. */
function resolveHome() {
  const s = get();
  if (s.page === "home" && s.agents.length > 0 && (s.homeAgentId === null || !s.agents.some((a) => a.id === s.homeAgentId))) redirectHome();
}

export async function loadAgents() {
  const hadAgents = get().agents.length > 0;
  set({ agentsState: hadAgents ? "ready" : "loading" });
  try {
    const agents = await api.listAgents();
    // Paired devices' agents (module 07) are loaded with their device.
    set((s) => ({ agents: [...agents, ...s.agents.filter((a) => a.deviceId)], agentsState: "ready" }));
    const s = get();
    // The home agent may live on a paired device that hasn't loaded yet.
    if (s.page === "home" && s.homeAgentId !== null && !s.agents.some((a) => a.id === s.homeAgentId)) void whenDevicesLoaded().then(resolveHome);
    else resolveHome();
  } catch (error) {
    set({ agentsState: hadAgents ? "ready" : "error" });
    notifyError(error);
  }
}

export async function loadConversations({ quiet = false } = {}) {
  try {
    const conversations = await api.listConversations();
    // Unchanged chats keep their objects, and the list itself when nothing changed, so the sidebar doesn't re-render.
    set((s) => ({
      conversations: shareConversations(s.conversations, [...conversations, ...s.conversations.filter((c) => deviceOf(c.agentId))]),
      conversationsState: "ready",
    }));
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

/**
 * The Mac app opens its window as TOT starts, while the server may still be checking the Claude and
 * ChatGPT logins: that first answer can come without a provider's models, and the model picker then
 * shows raw ids. So check again shortly after start (fresh, past the server's 30 s cache) while any
 * provider has no models, and whenever the window comes back into focus.
 */
const PROVIDER_RECHECK_MS = [3_000, 10_000, 30_000];
const FOCUS_RECHECK_MS = 30_000;

function watchProviders() {
  for (const delay of PROVIDER_RECHECK_MS) {
    window.setTimeout(() => {
      if (!get().providers.some((p) => p.models.length === 0)) return;
      void api
        .listProviders({ refresh: true })
        .then(() => refreshProviders({ quiet: true }))
        .catch(() => {});
    }, delay);
  }
  let checkedAt = Date.now();
  window.addEventListener("focus", () => {
    if (Date.now() - checkedAt < FOCUS_RECHECK_MS) return;
    checkedAt = Date.now();
    void refreshProviders({ quiet: true });
  });
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

/** Loaded at app init; kept live via the `brains` AppEvent. */
export async function loadBrains() {
  try {
    set({ brains: await api.listBrains() });
  } catch (error) {
    notifyError(error);
  }
}

/** Puts a brain the server just returned into the list (before its AppEvent arrives). */
export function upsertBrain(brain: Brain) {
  set((s) => ({
    brains: s.brains?.some((b) => b.id === brain.id) ? s.brains.map((b) => (b.id === brain.id ? brain : b)) : [...(s.brains ?? []), brain],
  }));
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

/** Loaded at app init and refreshed whenever the Settings dialog opens; also kept live via the `persona`/`persona-deleted` AppEvents. */
export async function loadPersonas() {
  const had = get().personas.length > 0;
  set({ personasState: had ? "ready" : "loading" });
  try {
    set({ personas: await api.listPersonas(), personasState: "ready" });
  } catch (error) {
    set({ personasState: had ? "ready" : "error" });
    notifyError(error);
  }
}

/** Upsert one persona: after a create/patch/mailbox/GitHub call, or from the `persona` AppEvent. */
export function setPersona(persona: Persona) {
  set((s) => ({
    personas: s.personas.some((p) => p.id === persona.id)
      ? s.personas.map((p) => (p.id === persona.id ? persona : p))
      : [...s.personas, persona],
  }));
}

/** Forget a persona: after a delete call, or from the `persona-deleted` AppEvent. */
export function removePersona(id: string) {
  set((s) => ({ personas: s.personas.filter((p) => p.id !== id) }));
}

/** A mail message was opened (the server marks it read); reflect that in the persona's unread count right away. */
export function markPersonaMailRead(personaId: string) {
  set((s) => ({
    personas: s.personas.map((p) => (p.id === personaId && p.unread > 0 ? { ...p, unread: p.unread - 1 } : p)),
  }));
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export const setNewAgentDialogOpen = (open: boolean) => set({ newAgentDialogOpen: open });

/** Opens the settings panel for an agent (switching to it first), in place of the computer panel. */
export function openAgentSettings(agentId: string, tab: AgentSettingsTab = "profile") {
  if (selectActiveAgentId(get()) !== agentId) navigateToAgentHome(agentId);
  set({ agentSettingsOpen: true, agentSettingsTab: tab, computerPanelOpen: false, taskPanelOpen: false });
}

export const closeAgentSettings = () => set({ agentSettingsOpen: false });

export function setAgentSettingsTab(tab: AgentSettingsTab) {
  set({ agentSettingsTab: tab });
}

/** An agent as the server sent it, tagged with its paired device when it lives on one (module 07). */
function withDevice(agent: Agent): Agent {
  const deviceId = deviceOf(agent.id);
  return deviceId ? { ...agent, deviceId } : agent;
}

/** Makes an agent here, or on a paired device (`deviceId`, module 07). */
export async function createAgent(input: AgentInput, deviceId: string | null = null): Promise<Agent | null> {
  try {
    const agent = withDevice(await onDevice(deviceId, () => api.createAgent(input)));
    set((s) => ({ agents: s.agents.some((a) => a.id === agent.id) ? s.agents : [...s.agents, agent] }));
    setNewAgentDialogOpen(false);
    // Land on the crew, where the new agent joins the others.
    navigateToCrew();
    return agent;
  } catch (error) {
    notifyError(error);
    return null;
  }
}

export async function updateAgent(id: string, input: Partial<AgentInput>): Promise<boolean> {
  try {
    const agent = await api.updateAgent(id, input);
    set((s) => ({ agents: s.agents.map((a) => (a.id === id ? withDevice(agent) : a)) }));
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

function showAgentHome(agentId: string | null, draftProjectId: string | null = null) {
  set({ currentId: null, homeAgentId: agentId, draftProjectId, draftWorkspace: "checkout", computerPanelOpen: false, taskPanelOpen: false });
}

function showWiki(agentId: string, pageId: string | null, brainId: string | null = null) {
  set({
    currentId: null,
    homeAgentId: agentId,
    wikiPageId: pageId,
    wikiBrainId: brainId,
    computerPanelOpen: false,
    agentSettingsOpen: false,
  });
}

function showProject(agentId: string, projectId: string) {
  set({ currentId: null, homeAgentId: agentId, projectId, computerPanelOpen: false, taskPanelOpen: false });
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
  if (pathname === TRUST_LAB_PATH) {
    set({ page: "trust-lab" });
    return;
  }
  if (isCrewPath(pathname)) {
    set({ page: "crew", currentId: null, computerPanelOpen: false, taskPanelOpen: false });
    return;
  }
  const mission = missionFromLocation(pathname, window.location.search);
  if (mission) {
    set({ page: "mission", missionProjectId: mission.projectId, currentId: null, computerPanelOpen: false, taskPanelOpen: false });
    return;
  }
  const compareGroup = compareGroupFromPath(pathname);
  if (compareGroup) {
    set({ page: "compare", compareGroup, currentId: null, computerPanelOpen: false, taskPanelOpen: false });
    return;
  }
  const wiki = wikiFromPath(pathname);
  if (wiki) {
    set({ page: "wiki" });
    showWiki(wiki.agentId, wiki.pageId, wiki.brainId);
    return;
  }
  const project = projectFromPath(pathname);
  if (project) {
    set({ page: "project" });
    showProject(project.agentId, project.projectId);
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
export function navigateToAgentHome(agentId: string, draftProjectId: string | null = null) {
  if (!isDesktop()) set({ sidebarOpen: false });
  const s = get();
  if (s.currentId === null && s.page === "home" && s.homeAgentId === agentId) {
    set({ draftProjectId, draftWorkspace: "checkout" });
    return;
  }
  pushPath(agentPath(agentId));
  set((s2) => ({ viewKey: s2.viewKey + 1, page: "home" }));
  showAgentHome(agentId, draftProjectId);
}

/** A new chat in a project (the sidebar's + on its row, its menu's New chat): the project's page. */
export function newChatInProject(projectId: string) {
  // The project's page is its new chat (a composer for it, above its chats).
  navigateToProject(projectId);
}

/** The project the new chat will start in (the composer's picker); null for none. */
export function setDraftProject(projectId: string | null) {
  set({ draftProjectId: projectId, draftWorkspace: "checkout" });
}

/** Where the new chat works in its code project (the composer's second picker). */
export function setDraftWorkspace(workspace: ChatWorkspaceMode) {
  set({ draftWorkspace: workspace });
}

/** Open a project's page, seen from an agent (the active one by default): new chats there start with it. */
export function navigateToProject(projectId: string, preferredAgentId = selectActiveAgentId(get())) {
  // A project is worked on by agents on its own device (module 07): seen from another device's agent, use one of its.
  const projectDevice = useProjects.getState().projects.find((p) => p.id === projectId)?.deviceId;
  const preferred = get().agents.find((a) => a.id === preferredAgentId);
  const agentId = preferred && preferred.deviceId === projectDevice ? preferred.id : get().agents.find((a) => a.deviceId === projectDevice)?.id;
  if (!agentId) return;
  if (!isDesktop()) set({ sidebarOpen: false });
  const s = get();
  if (s.page === "project" && s.projectId === projectId && s.homeAgentId === agentId) return;
  pushPath(projectPath(agentId, projectId));
  set((s2) => ({ viewKey: s2.viewKey + 1, page: "project" }));
  showProject(agentId, projectId);
}

/** Mission control (module 09): the board of every task, or one project's (⌘⇧M, the sidebar's Tasks header, a project's page). */
export function navigateToMission(projectId: string | null = null) {
  if (!isDesktop()) set({ sidebarOpen: false });
  const path = missionPath(projectId);
  if (window.location.pathname + window.location.search !== path) window.history.pushState(null, "", path);
  // Switching the project filter keeps the board mounted.
  if (get().page === "mission") {
    set({ missionProjectId: projectId });
    return;
  }
  set((s) => ({ viewKey: s.viewKey + 1, page: "mission", missionProjectId: projectId, currentId: null, computerPanelOpen: false, taskPanelOpen: false }));
}

/** Your crew: every agent, with its island, computer, brains and model (the rail's logo, and after adding an agent). */
export function navigateToCrew() {
  if (!isDesktop()) set({ sidebarOpen: false });
  if (get().page === "crew") return;
  pushPath(CREW_PATH);
  set((s) => ({ viewKey: s.viewKey + 1, page: "crew", currentId: null, computerPanelOpen: false, taskPanelOpen: false }));
}

/** A best-of run's tasks side by side (module 09). */
export function navigateToCompare(group: string) {
  if (!isDesktop()) set({ sidebarOpen: false });
  const s = get();
  if (s.page === "compare" && s.compareGroup === group) return;
  pushPath(comparePath(group));
  set((s2) => ({ viewKey: s2.viewKey + 1, page: "compare", compareGroup: group, currentId: null, computerPanelOpen: false, taskPanelOpen: false }));
}

/** The agent rail: switch to an agent. On a project's page, stay on it (the next chat there starts with that agent). */
export function selectAgent(agentId: string) {
  const s = get();
  const projectDevice = s.projectId ? useProjects.getState().projects.find((p) => p.id === s.projectId)?.deviceId : undefined;
  const sameDevice = s.agents.find((a) => a.id === agentId)?.deviceId === projectDevice;
  if (s.page === "project" && s.projectId && s.currentId === null && sameDevice) navigateToProject(s.projectId, agentId);
  else navigateToAgentHome(agentId);
}

/** Open a conversation. A project's Lead opens as its project's page (module 11). */
export function navigateToConversation(id: string) {
  const lead = get().conversations.find((c) => c.id === id && c.lead && c.projectId);
  if (lead?.projectId) return navigateToProject(lead.projectId, lead.agentId);
  if (!isDesktop()) set({ sidebarOpen: false });
  if (id === get().currentId) return;
  pushPath(conversationPath(id));
  set((s) => ({ viewKey: s.viewKey + 1, page: "chat" }));
  void openConversation(id);
}

/**
 * Open the wiki as an agent sees it — its notebook, a page (in whichever brain it lives), or one
 * brain's Overview; makes that agent active and pushes a fresh history entry.
 */
export function navigateToWiki(agentId: string, pageId?: string | null, brainId?: string | null) {
  if (!isDesktop()) set({ sidebarOpen: false });
  const s = get();
  const targetPageId = pageId ?? null;
  const targetBrainId = targetPageId ? null : (brainId ?? null);
  if (s.page === "wiki" && s.homeAgentId === agentId && s.wikiPageId === targetPageId && s.wikiBrainId === targetBrainId) return;
  pushPath(wikiPath(agentId, targetPageId, targetBrainId));
  set((s2) => ({ viewKey: s2.viewKey + 1, page: "wiki" }));
  showWiki(agentId, targetPageId, targetBrainId);
}

/** Switch the wiki that's open to another brain (its Overview), keeping the view mounted. */
export function openBrain(brainId: string) {
  const s = get();
  if (s.page !== "wiki" || !s.homeAgentId || (s.wikiBrainId === brainId && s.wikiPageId === null)) return;
  pushPath(wikiPath(s.homeAgentId, null, brainId));
  set({ wikiBrainId: brainId, wikiPageId: null });
}

/**
 * Switch the page shown within the wiki that's already open, without remounting
 * the view (so the tree's scroll position and search box survive) — mirrors how
 * `sendMessage` moves from the home screen into a chat without a route change.
 */
export function openWikiPage(pageId: string | null, brainId?: string | null) {
  const s = get();
  if (s.page !== "wiki" || !s.homeAgentId || s.wikiPageId === pageId) return;
  // Pages of the brain that's open stay in it (the URL names only the page).
  const keepBrain = brainId ?? s.wikiBrainId;
  pushPath(pageId ? wikiPath(s.homeAgentId, pageId) : wikiPath(s.homeAgentId, null, keepBrain));
  set({ wikiPageId: pageId, wikiBrainId: keepBrain });
}

async function openConversation(id: string) {
  if (get().currentId !== id) set({ currentId: id, computerPanelOpen: false, taskPanelOpen: false });
  // While we follow a live run, the in-memory messages are the freshest copy.
  if (streams.has(id)) return;
  await loadConversation(id, { useCache: true });
}

/** What's known about each loaded chat's copy: its ETag, the updatedAt it had, and when it was last checked. */
const loadedChats = new Map<string, { etag: string | null; updatedAt: number; checkedAt: number }>();
/** Loaded chats, most recently opened first; past MAX_CACHED_CHATS the oldest ones' messages are dropped. */
let cachedChats: string[] = [];
const MAX_CACHED_CHATS = 12;
/** A cached chat checked this recently, whose updatedAt hasn't moved since, opens without asking the server. */
const FRESH_MS = 30_000;
/** Loads under way, per chat. */
const loadsInFlight = new Map<string, number>();

function rememberChat(id: string) {
  cachedChats = [id, ...cachedChats.filter((c) => c !== id)];
  if (cachedChats.length <= MAX_CACHED_CHATS) return;
  const s = get();
  // Never the open chat, or one whose turn is being followed.
  const keep = (c: string) => c === s.currentId || streams.has(c) || Boolean(s.activeRuns[c]);
  const drop = cachedChats.slice(MAX_CACHED_CHATS).filter((c) => !keep(c));
  if (!drop.length) return;
  cachedChats = cachedChats.filter((c) => !drop.includes(c));
  for (const c of drop) loadedChats.delete(c);
  set((s2) => ({
    messages: drop.reduce((all, c) => without(all, c), s2.messages),
    detailState: drop.reduce((all, c) => without(all, c), s2.detailState),
  }));
}

/** Something happened in a chat that its copy may not show yet (a turn, an answered approval): check it next time. */
function staleChat(id: string) {
  const entry = loadedChats.get(id);
  if (entry) loadedChats.set(id, { ...entry, checkedAt: 0 });
}

/** A loaded copy that can be shown without asking the server: checked recently, unchanged in the list, nothing running. */
function cachedCopyIsFresh(id: string): boolean {
  const s = get();
  const entry = loadedChats.get(id);
  const listed = s.conversations.find((c) => c.id === id);
  const cached = s.messages[id];
  return Boolean(
    entry && listed && cached && listed.updatedAt === entry.updatedAt && !listed.task?.partial &&
      Date.now() - entry.checkedAt < FRESH_MS && !s.activeRuns[id] && !streams.has(id) &&
      !cached.some((m) => m.status === "streaming"),
  );
}

/** The same message as the stored one? A clipped tool call matches the whole one it was cut from (opened earlier). */
function sameMessage(stored: Message, next: Message): boolean {
  const { parts: a, ...restA } = stored;
  const { parts: b, ...restB } = next;
  return a.length === b.length && sameValue(restA, restB) && a.every((part, i) => samePart(part, b[i]));
}

function samePart(stored: MessagePart, next: MessagePart): boolean {
  if (stored.type !== "tool" || next.type !== "tool" || (!stored.clipped && !next.clipped)) return sameValue(stored, next);
  const { input: inA, output: outA, clipped: _a, outputChars: _b, inputChars: _c, ...restA } = stored;
  const { input: inB, output: outB, clipped: _d, outputChars: _e, inputChars: _f, ...restB } = next;
  const outputSize = (p: ToolPartData) => p.outputChars ?? p.output?.length ?? 0;
  const inputSize = (p: ToolPartData) => p.inputChars ?? (typeof p.input === "string" ? p.input.length : JSON.stringify(p.input ?? null).length);
  return (
    sameValue(restA, restB) && outputSize(stored) === outputSize(next) && (outA ?? "").slice(0, 200) === (outB ?? "").slice(0, 200) &&
    (stored.inputChars === undefined && next.inputChars === undefined ? sameValue(inA, inB) : inputSize(stored) === inputSize(next))
  );
}

/**
 * Messages from the server, against the stored copy: an unchanged finished message keeps its stored object (and any
 * tool call opened whole in it), so its row doesn't re-render; the list itself stays when nothing changed.
 */
function shareMessages(stored: Message[] | undefined, incoming: Message[]): Message[] {
  if (!stored?.length) return incoming;
  const byId = new Map(stored.map((m) => [m.id, m]));
  const next = incoming.map((m) => {
    const old = byId.get(m.id);
    return old && old.status !== "streaming" && m.status !== "streaming" && sameMessage(old, m) ? old : m;
  });
  return sameItems(next, stored) ? stored : next;
}

/**
 * Fetch a conversation and its messages. If a run is still active, follow it from the reply as the server has it now
 * (or, from an older server, drop the partial reply and rebuild it from the run's events). `useCache`: a copy checked
 * in the last few seconds will do (opening a chat, prefetching one); any other load at least asks whether the copy is
 * still current, which costs a 304 when it is.
 */
export async function loadConversation(id: string, { attach = true, useCache = false, quiet = false } = {}) {
  if (useCache && cachedCopyIsFresh(id)) {
    rememberChat(id);
    if (get().detailState[id] !== "ready") set((s) => ({ detailState: { ...s.detailState, [id]: "ready" } }));
    return;
  }
  set((s) => ({ detailState: { ...s.detailState, [id]: s.messages[id] ? "ready" : "loading" } }));
  loadsInFlight.set(id, (loadsInFlight.get(id) ?? 0) + 1);
  try {
    // Opened by URL before the paired devices' chats loaded: it may be one of theirs (module 07).
    if (!deviceOf(id) && !get().conversations.some((c) => c.id === id)) await whenDevicesLoaded();
    // Only a settled copy can be "unchanged": not while a reply streams into it, nor one holding a reply that was still
    // being written (prefetched, or its stream lost), whose run a 304 wouldn't say how to follow.
    const before = get();
    const cached = before.messages[id];
    const settled = cached && !streams.has(id) && !before.activeRuns[id] && !cached.some((m) => m.status === "streaming");
    const result = await api.getConversation(id, settled ? (loadedChats.get(id)?.etag ?? null) : null);
    if (!result) {
      const entry = loadedChats.get(id);
      if (entry) loadedChats.set(id, { ...entry, checkedAt: Date.now() });
      rememberChat(id);
      set((s) => ({ detailState: { ...s.detailState, [id]: "ready" } }));
      return;
    }
    const { data: detail, etag } = result;
    loadedChats.set(id, { etag, updatedAt: detail.conversation.updatedAt, checkedAt: Date.now() });
    if (streams.has(id)) {
      // A message was sent while we were loading: keep the live messages and
      // put the fetched history in front of them.
      set((s) => {
        const live = s.messages[id] ?? [];
        const liveIds = new Set(live.map((m) => m.id));
        const history = detail.messages.filter((m) => !liveIds.has(m.id) && m.status !== "streaming");
        return {
          conversations: upsertConversation(s.conversations, detail.conversation),
          messages: { ...s.messages, [id]: [...shareMessages(s.messages[id], history), ...live] },
          detailState: { ...s.detailState, [id]: "ready" },
        };
      });
      rememberChat(id);
      return;
    }
    const runId = attach ? detail.activeRunId : null;
    // The server sent the running reply as it is now, and how far into the run that is: follow on from there.
    const snapshot = runId && detail.activeMessageId && detail.activeRunSeq !== undefined ? { messageId: detail.activeMessageId, after: detail.activeRunSeq } : null;
    const messages = runId && !snapshot
      ? detail.messages.filter((m) => !(m.role === "assistant" && m.status === "streaming"))
      : detail.messages;
    set((s) => ({
      conversations: upsertConversation(s.conversations, detail.conversation),
      messages: { ...s.messages, [id]: shareMessages(s.messages[id], messages) },
      detailState: { ...s.detailState, [id]: "ready" },
    }));
    if (runId) attachRun(id, runId, snapshot);
    rememberChat(id);
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
    if (!quiet) notifyError(error);
  } finally {
    const left = (loadsInFlight.get(id) ?? 1) - 1;
    if (left > 0) loadsInFlight.set(id, left);
    else loadsInFlight.delete(id);
  }
}

/**
 * Loads a chat ahead of opening it (the sidebar calls this on hover), so opening it shows it at once. A cached copy
 * that's still fresh is left as it is; a running turn is followed only once the chat is opened.
 */
export function prefetchConversation(id: string) {
  if (get().currentId === id || streams.has(id) || loadsInFlight.has(id)) return;
  void loadConversation(id, { attach: false, useCache: true, quiet: true });
}

export function retryConversation(id: string) {
  void loadConversation(id);
}

type ToolPartData = Extract<MessagePart, { type: "tool" }>;

/** Clipped tool calls being fetched whole, by message and part id. */
const partLoads = new Map<string, Promise<ToolPartData>>();

/** The chat and message a part is in: the message holding this very object, else one with its id (the open chat first). */
function partOwner(part: MessagePart): { conversationId: string; messageId: string } | null {
  const { messages, currentId } = get();
  const chats = Object.entries(messages);
  for (const [conversationId, list] of chats) {
    const message = list.find((m) => m.parts.includes(part));
    if (message) return { conversationId, messageId: message.id };
  }
  chats.sort(([a], [b]) => Number(b === currentId) - Number(a === currentId));
  for (const [conversationId, list] of chats) {
    const message = list.find((m) => m.parts.some((p) => p.id === part.id && p.type === part.type));
    if (message) return { conversationId, messageId: message.id };
  }
  return null;
}

/**
 * A clipped tool call, whole. A chat loads with the start of each finished call's output (the UI shows one line per
 * call until it's opened); opening one fetches the rest, which then stays in its message.
 */
export function loadFullPart(part: ToolPartData): Promise<ToolPartData> {
  const owner = partOwner(part);
  if (!owner) return Promise.reject(new Error("This step isn't loaded anymore."));
  const key = `${owner.messageId}/${part.id}`;
  const pending = partLoads.get(key);
  if (pending) return pending;
  const load = api
    .getConversationPart(owner.conversationId, owner.messageId, part.id)
    .then((full) => {
      if (full.type !== "tool") throw new Error("This step isn't a tool call anymore.");
      setMessages(owner.conversationId, (list) =>
        list.map((m) => (m.id === owner.messageId ? { ...m, parts: m.parts.map((p) => (p.id === full.id ? full : p)) } : m)),
      );
      return full;
    })
    .finally(() => partLoads.delete(key));
  partLoads.set(key, load);
  return load;
}

function forgetConversation(id: string) {
  const stream = streams.get(id);
  if (stream) detachRun(id, stream.runId);
  loadedChats.delete(id);
  cachedChats = cachedChats.filter((c) => c !== id);
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

/** `from`: the chat's load already has the reply up to that event of the run (skip replaying it). */
function attachRun(conversationId: string, runId: string, from: { messageId: string; after: number } | null = null) {
  const existing = streams.get(conversationId);
  if (existing?.runId === runId) return;
  if (existing) detachRun(conversationId, existing.runId);

  set((s) => ({
    activeRuns: { ...s.activeRuns, [conversationId]: { runId, messageId: from?.messageId ?? null, stopping: false } },
    justFinished: without(s.justFinished, conversationId),
  }));
  const unsubscribe = subscribeToRun(
    runId,
    {
      onEvent: (event) => enqueue(conversationId, runId, event),
      onLost: () => handleLostRun(conversationId, runId),
    },
    from?.after ?? 0,
  );
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
  /** Other chats attached as reference. */
  contextChats?: string[];
}

/** Send a message; creates the conversation first on an agent's home screen. */
export async function sendMessage(
  text: string,
  { thinkHarder = false, attachments = [], contextChats = [] }: SendMessageOptions = {},
): Promise<boolean> {
  const body = text.trim();
  if ((!body && attachments.length === 0) || get().sending) return false;
  set({ sending: true });
  // Any message can start tasks, which notify when they finish: ask once, while this is still the user's click.
  askForNotifications();

  let conversationId = get().currentId;
  // From a project's page the new chat opens in another view, whose composer must get the text back on failure.
  const fromProjectPage = !conversationId && get().page === "project";
  const tempId = localId();
  try {
    if (!conversationId) {
      const { homeAgentId, agents, draftModelId, draftProjectId, draftWorkspace, settings, page, projectId } = get();
      // From a project's page, the chat starts in that project; from home, in the one picked (if any).
      const target = page === "project" && projectId ? projectId : draftProjectId;
      const project = target ? useProjects.getState().projects.find((p) => p.id === target) : undefined;
      const conversation = await api.createConversation({
        agentId: homeAgentId ?? agents[0]?.id,
        modelId: draftModelId ?? settings?.defaultModelId ?? AUTO_MODEL_ID,
        ...(target ? { projectId: target } : {}),
        // In a project with code, where it works: the main checkout, or a new worktree of its own.
        ...(project && isCodeProject(project) ? { workspace: draftWorkspace } : {}),
      });
      conversationId = conversation.id;
      set((s) => ({
        conversations: upsertConversation(s.conversations, conversation),
        messages: { ...s.messages, [conversation.id]: [] },
        detailState: { ...s.detailState, [conversation.id]: "ready" },
        currentId: conversation.id,
        page: "chat",
        draftModelId: null,
        draftProjectId: null,
        draftWorkspace: "checkout",
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
        ...(contextChats.length ? { contextChats } : {}),
        createdAt: Date.now(),
      },
    ]);

    const modelId = get().conversations.find((c) => c.id === id)?.modelId;
    const response = await api.sendMessage(id, {
      text: body,
      modelId,
      ...(attachments.length ? { attachments: attachments.map((a) => a.id) } : {}),
      ...(thinkHarder ? { thinkHarder: true } : {}),
      ...(contextChats.length ? { contextChats } : {}),
    });

    set((s) => ({
      conversations: upsertConversation(s.conversations, response.conversation),
      messages: {
        ...s.messages,
        [id]: (s.messages[id] ?? []).map((m) => (m.id === tempId ? response.userMessage : m)),
      },
    }));
    // A task that was busy took the message as a note: there's no turn to follow.
    if (response.runId) attachRun(id, response.runId);
    return true;
  } catch (error) {
    if (conversationId) {
      setMessages(conversationId, (list) => list.filter((m) => m.id !== tempId));
    }
    if (fromProjectPage && conversationId && body) set({ composerDraft: body });
    notifyError(error);
    return false;
  } finally {
    set({ sending: false });
  }
}

/** "/best-of": the same goal on each signed-in provider, from the open chat (cards there), a project's page (they show in its list) or home (the compare view opens). */
export async function startBestOf(goal: string, requestId = newRequestId()): Promise<boolean> {
  const body = goal.trim();
  if (!body || get().sending) return false;
  set({ sending: true });
  askForNotifications();
  try {
    const s = get();
    const chat = selectCurrentConversation(s);
    const projectId = s.page === "project" ? s.projectId : null;
    const runs = await api.startBestOf(
      chat ? { conversationId: chat.id, goal: body, requestId } : { agentId: selectActiveAgentId(s) ?? undefined, projectId, goal: body, requestId },
    );
    set((s2) => ({ conversations: runs.reduce(upsertConversation, s2.conversations) }));
    const group = runs[0]?.task?.group;
    if (chat) void loadConversation(chat.id);
    else if (!projectId && group) navigateToCompare(group);
    return true;
  } catch (error) {
    notifyError(error);
    return false;
  } finally {
    set({ sending: false });
  }
}

/** The composer took back a failed message's text (see `composerDraft`). */
export function clearComposerDraft() {
  set({ composerDraft: null });
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

async function updateConversation(id: string, patch: UpdateConversationRequest): Promise<boolean> {
  const previous = get().conversations.find((c) => c.id === id);
  if (!previous) return false;
  patchConversation(id, patch);
  try {
    const updated = await api.updateConversation(id, patch);
    set((s) => ({ conversations: upsertConversation(s.conversations, updated) }));
  } catch (error) {
    const revert: Partial<Conversation> = {};
    if (patch.title !== undefined) revert.title = previous.title;
    if (patch.pinned !== undefined) revert.pinned = previous.pinned;
    if (patch.modelId !== undefined) revert.modelId = previous.modelId;
    if (patch.projectId !== undefined) revert.projectId = previous.projectId;
    patchConversation(id, revert);
    notifyError(error);
    return false;
  }
  return true;
}

export function renameConversation(id: string, title: string) {
  const trimmed = title.trim();
  const current = get().conversations.find((c) => c.id === id);
  if (!trimmed || trimmed === current?.title) return;
  void updateConversation(id, { title: trimmed });
}

/** "Move to project…": files a chat (and its tasks, server-side) in a project, or takes it out with null. */
export async function moveToProject(id: string, projectId: string | null) {
  const current = get().conversations.find((c) => c.id === id);
  if (!current || current.projectId === projectId) return;
  if (!(await updateConversation(id, { projectId }))) return;
  const name = projectId ? useProjects.getState().projects.find((p) => p.id === projectId)?.name : null;
  toast.success(name ? `Moved to ${name}` : "Moved out of the project");
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

function handleAgentEvent(serverAgent: Agent) {
  const agent = withDevice(serverAgent);
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
function handleWikiEvent(brainId: string, conversationId?: string) {
  set({ wikiEvent: { brainId, conversationId, at: Date.now() } });
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
 * New mail arrived in a persona's mailbox (incoming or sent). Bumps the
 * persona's unread count locally — the authoritative count also arrives via
 * the `persona` event, which just overwrites this — and pings any open inbox
 * through `mailEvent` so it can insert the message live.
 */
function handleMailEvent(personaId: string, mail: MailSummary) {
  set((s) => ({
    personas: s.personas.map((p) => (p.id === personaId && mail.unread ? { ...p, unread: p.unread + 1 } : p)),
    mailEvent: { personaId, mail, at: Date.now() },
  }));
}

/**
 * A chat is waiting for the user's approval, or no longer is (answered,
 * expired, or a background routine run moved on). Tracks `pendingApprovals`
 * for the sidebar's attention dot, and nudges with a toast when the
 * conversation isn't the one currently open.
 */
function handleApprovalEvent(event: Extract<AppEvent, { type: "approval" }>) {
  staleChat(event.conversationId);
  set((s) => {
    if (s.pendingApprovals.has(event.conversationId) === event.pending) return {};
    const next = new Set(s.pendingApprovals);
    if (event.pending) next.add(event.conversationId);
    else next.delete(event.conversationId);
    return { pendingApprovals: next };
  });
  // Answered elsewhere (a Lead's card, from another tab or device, module 11): the open chat shows it and its note.
  if (!event.pending && get().currentId === event.conversationId && !get().activeRuns[event.conversationId]) {
    void loadConversation(event.conversationId);
  }
  if (!event.pending || get().currentId === event.conversationId) return;
  const agentName = get().agents.find((a) => a.id === event.agentId)?.name ?? "Your agent";
  toast(`${agentName} needs your OK`, {
    description: truncate(event.message, 140),
    action: { label: "Open", onClick: () => navigateToConversation(event.conversationId) },
  });
}

/** Dispatch one app-wide SSE event into the store. Pass to `useAppEvents`. */
export function handleAppEvent(event: AppEvent, deviceId: string | null = null) {
  // A paired device's brains (module 07) are kept apart: they belong to its agents, not to this device's.
  if (deviceId && event.type === "brains") {
    setDeviceBrains(deviceId, event.brains);
    return;
  }
  switch (event.type) {
    case "device":
      handleDeviceEvent(event.device);
      break;
    case "device-deleted":
      handleDeviceDeleted(event.deviceId);
      break;
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
      handleWikiEvent(event.brainId, event.conversationId);
      break;
    case "brains":
      set({ brains: event.brains });
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
    case "persona":
      setPersona(event.persona);
      break;
    case "persona-deleted":
      removePersona(event.personaId);
      break;
    case "mail":
      handleMailEvent(event.personaId, event.mail);
      break;
    case "approval":
      handleApprovalEvent(event);
      break;
    case "task":
      handleTaskEvent(event.conversation);
      break;
    case "project":
      upsertProject(event.project);
      break;
    // Memory repo (module 10): open memory views reload.
    case "memory":
      memoryChanged(event.repo);
      break;
    case "run":
      // A cached copy of the chat may miss this turn: check it when it's next opened.
      staleChat(event.conversationId);
      // Running agents are tracked by useRunningAgents() + setRunningAgents; here, follow turns
      // TOT started on its own (a task's next turn, a study step) in the chat that's open.
      if (event.status === "running") followServerRun(event.conversationId);
      break;
  }
}

/** A turn started outside this tab in the open chat: load it, which attaches to the live run. */
function followServerRun(conversationId: string) {
  const s = get();
  if (s.currentId !== conversationId || s.sending || streams.has(conversationId)) return;
  void loadConversation(conversationId);
}

/** Statuses worth telling the user about when they're looking elsewhere. */
const NOTIFY_STATUSES = new Set(["done", "failed", "needs-input"]);

/**
 * A task changed. Keeps the list current; when it just finished or needs the user and they're
 * not looking at it, a toast (and a browser notification while TOT is in the background); and
 * when it finished, the chat that started it reloads to show the result note.
 */
function handleTaskEvent(conversation: Conversation) {
  const previous = get().conversations.find((c) => c.id === conversation.id);
  set((s) => ({ conversations: upsertConversation(s.conversations, conversation) }));
  if (!isTask(conversation)) return;
  const status = conversation.task.status;
  if (!previous?.task || previous.task.status === status || !NOTIFY_STATUSES.has(status)) return;

  const parentId = conversation.parentId;
  if ((status === "done" || status === "failed") && parentId && get().currentId === parentId && !get().activeRuns[parentId]) {
    void loadConversation(parentId);
  }
  const watching = get().currentId === conversation.id && document.visibilityState === "visible";
  if (watching) return;
  const headline =
    status === "needs-input" ? `“${conversation.title}” needs your input` : `“${conversation.title}” ${status === "done" ? "is done" : "failed"}`;
  const detail = status === "needs-input" ? (conversation.task.question ?? "It's waiting for your OK.") : (conversation.task.summary ?? "");
  const open = () => navigateToConversation(conversation.id);
  (status === "failed" ? toast.error : toast)(headline, {
    id: `task-${conversation.id}`,
    description: truncate(detail, 140),
    action: { label: "Open", onClick: open },
  });
  if (document.visibilityState !== "visible" && "Notification" in window && Notification.permission === "granted") {
    const notification = new Notification(headline, { body: truncate(detail, 180), tag: `task-${conversation.id}` });
    notification.onclick = () => {
      window.focus();
      open();
    };
  }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** Browser notifications are asked for once, the first time the user sends a message. */
function askForNotifications() {
  if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
}

/** A note to the open task while it runs: saved in its transcript, delivered mid-turn or with its next turn. */
export async function steerTask(conversationId: string, text: string): Promise<boolean> {
  const body = text.trim();
  if (!body) return false;
  try {
    const message = await api.steerTask(conversationId, body);
    setMessages(conversationId, (list) => upsertMessage(list, message));
    return true;
  } catch (error) {
    notifyError(error);
    return false;
  }
}

async function taskAction(action: () => Promise<Conversation>) {
  try {
    const task = await action();
    set((s) => ({ conversations: upsertConversation(s.conversations, task) }));
  } catch (error) {
    notifyError(error);
  }
}

export const pauseTask = (id: string) => taskAction(() => api.pauseTask(id));
export const resumeTask = (id: string) => taskAction(() => api.resumeTask(id));
export const stopTask = (id: string) => taskAction(() => api.stopTask(id));
export const runTaskNow = (id: string) => taskAction(() => api.runTaskNow(id));
export const patchTask = (id: string, patch: TaskPatch) => taskAction(() => api.patchTask(id, patch));

/** "Fork chat" / "Fork from here": a new chat with the history so far, which opens. */
export async function forkChat(conversationId: string, messageId?: string) {
  try {
    const fork = await api.forkChat(conversationId, messageId ? { messageId } : {});
    set((s) => ({ conversations: upsertConversation(s.conversations, fork) }));
    navigateToConversation(fork.id);
  } catch (error) {
    notifyError(error);
  }
}

/** "Bring back to …": the fork's new messages go to the chat it came from, for its next reply. */
export async function mergeBack(forkId: string) {
  try {
    const source = await api.mergeBack(forkId);
    set((s) => ({ conversations: upsertConversation(s.conversations, source) }));
    toast.success(`Brought back to “${source.title}”`, { action: { label: "Open", onClick: () => navigateToConversation(source.id) } });
  } catch (error) {
    notifyError(error);
  }
}

/** "Resume" on a paused queue: its tasks start again. */
export async function resumeQueue(agentId: string) {
  try {
    handleAgentEvent(await api.resumeQueue(agentId));
  } catch (error) {
    notifyError(error);
  }
}

/** "Continue on ChatGPT / Claude": a handoff, then a fresh session there. */
export async function continueTaskOn(id: string, provider: ProviderId) {
  const label = PROVIDER_LABELS[provider];
  const pending = toast.loading(`Writing a handoff for ${label}…`);
  try {
    const task = await api.continueTaskOn(id, provider);
    set((s) => ({ conversations: upsertConversation(s.conversations, task) }));
    toast.success(`Continuing on ${label}`, { id: pending });
    if (get().currentId === id) void loadConversation(id);
  } catch (error) {
    toast.dismiss(pending);
    notifyError(error);
  }
}

export async function taskToChat(id: string) {
  try {
    await api.taskToChat(id);
    await loadConversation(id, { attach: false });
    setTaskPanelOpen(false);
  } catch (error) {
    notifyError(error);
  }
}

/** Deletes a task with its worktree; with `deleteBranch`, its never-pushed branch too. */
export async function deleteTask(id: string, { deleteBranch = false } = {}) {
  try {
    await api.deleteConversation(id, { deleteBranch });
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

/** The app-events channel dropped and came back; no-replay, so refetch lists. */
export function handleAppReconnect() {
  void loadAgents();
  void loadConversations({ quiet: true });
  void loadPersonas();
  void loadProjects().catch(() => {});
  void loadDevices();
}

/** A paired device's agents and chats (module 07); `conversations` null keeps what's there (an offline device). */
export function mergeRemote(deviceId: string, agents: Agent[], conversations: Conversation[] | null) {
  set((s) => ({
    agents: [...s.agents.filter((a) => a.deviceId !== deviceId), ...agents],
    conversations: conversations
      ? shareConversations(s.conversations, [...s.conversations.filter((c) => deviceOf(c.agentId) !== deviceId), ...conversations])
      : s.conversations,
  }));
}

/** A device was unpaired: its agents and chats leave this screen. */
export function removeDevice(deviceId: string) {
  const s = get();
  const active = selectActiveAgent(s);
  set({
    agents: s.agents.filter((a) => a.deviceId !== deviceId),
    conversations: s.conversations.filter((c) => deviceOf(c.agentId) !== deviceId),
  });
  if (active?.deviceId === deviceId) redirectHome();
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
  set(open ? { computerPanelOpen: true, agentSettingsOpen: false, taskPanelOpen: false } : { computerPanelOpen: false });
/** The task panel shares the right side too. */
export function setTaskPanelOpen(open: boolean, tab?: TaskPanelTab) {
  set(open ? { taskPanelOpen: true, computerPanelOpen: false, agentSettingsOpen: false, ...(tab ? { taskPanelTab: tab } : {}) } : { taskPanelOpen: false });
}
export const setTaskPanelTab = (tab: TaskPanelTab) => set({ taskPanelTab: tab });
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
  const { computer, tasks } = s.settingsDraft;
  return (
    (computer.mode === "off" || isValidIdleMinutes(computer.idleStopMinutes)) &&
    isValidTaskLimit(tasks.perAgentLimit, TASK_LIMITS.perAgent) &&
    isValidTaskLimit(tasks.globalLimit, TASK_LIMITS.global) &&
    isValidTaskLimit(tasks.maxChildren, TASK_LIMITS.children) &&
    isValidCleanupDays(tasks.worktreeCleanupDays)
  );
}

/** Open the sidebar (if needed) and focus its search box. */
export function focusSearch() {
  if (!get().sidebarOpen) setSidebarOpen(true);
  requestAnimationFrame(() => document.getElementById("chat-search")?.focus());
}
