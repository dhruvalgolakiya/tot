import type {
  AccountPatch,
  AccountStatus,
  Agent,
  AgentInput,
  AppsStatus,
  Attachment,
  ApprovalAnswer,
  Brain,
  Conversation,
  ConversationDetail,
  CreateConversationRequest,
  DevicesStatus,
  GitHubStatus,
  KnowledgeCommit,
  KnowledgeStatus,
  LandTaskRequest,
  LiveRuns,
  Memory,
  MemoryCommit,
  MemoryFile,
  MemoryRepoSummary,
  Message,
  MessagePart,
  MissionOverview,
  ModelOption,
  Persona,
  Plugin,
  Project,
  ProviderAccount,
  ProviderStatus,
  SendMessageRequest,
  SendMessageResponse,
  Settings,
  SettingsPatch,
  SlackStatus,
  TaskChanges,
  TaskLandOptions,
  TaskPlan,
  UpdateConversationRequest,
  WikiPage,
  WikiPageSummary,
  WikiSearchHit,
} from "@tot/shared/types";
import { tokenRefused, useConnection } from "./connection";
import { adopt, apiPath, deviceFor } from "./devices";

/**
 * The TOT API, ported from apps/web/src/lib/api.ts: the same paths and types (packages/shared/types.ts), sent to
 * the signed-in TOT's address with its token instead of same-origin with a cookie. Another device's things
 * go through /api/d/<id>/… (devices.ts). Only the calls the app uses are ported; later milestones port more.
 */

/** A failed API call. `status` is 0 when the server couldn't be reached at all. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Ok = { ok: true };

/** The headers every call to the signed-in TOT carries. */
export function authHeaders(): Record<string, string> {
  const { token } = useConnection.getState();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** The full URL of an API path on a device. */
export function apiUrl(path: string, device: string | null): string {
  return `${useConnection.getState().url ?? ""}${apiPath(path, device)}`;
}

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const device = deviceFor(path, body);
  const base = useConnection.getState().url;
  const name = useConnection.getState().deviceName ?? "TOT";
  let response: Response;
  try {
    response = await fetch(apiUrl(path, device), {
      method,
      headers: { ...authHeaders(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(`Can't reach ${name}. Is it on, and is this phone on its Wi‑Fi or Tailscale?`, 0);
  }
  // Signed out in Settings → Devices (or the password changed): only this TOT's own 401 means that.
  if (response.status === 401 && !device) void tokenRefused(base);
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  // An older TOT answers an API path it doesn't know with its web page, not a 404.
  if (response.ok && (response.headers.get("content-type") ?? "").includes("text/html")) {
    throw new ApiError(`${name} doesn't know this yet. Update TOT there.`, 404);
  }
  if (!response.ok) {
    const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  return (device ? adopt(device, data) : data) as T;
}

/** A photo picked on the phone, sent as the web's file input sends a file: multipart, one "file" field. */
export interface LocalFile {
  uri: string;
  name: string;
  type: string;
}

/**
 * POST /api/uploads (the web's uploadFile): resolves with the attachment to send with a message. Call it inside
 * `onDevice(agent.deviceId, …)` for a paired device's agent, whose turn reads the file there.
 */
async function upload(file: LocalFile): Promise<Attachment> {
  const device = deviceFor("/uploads");
  const base = useConnection.getState().url;
  const form = new FormData();
  // React Native's FormData sends a { uri, name, type } entry as the file's bytes, read from disk by its networking.
  form.append("file", file as unknown as Blob);
  // XMLHttpRequest, not fetch: the global fetch (expo/fetch) streams, but its FormData doesn't take a local file's uri.
  const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl("/uploads", device));
    for (const [name, value] of Object.entries(authHeaders())) xhr.setRequestHeader(name, value);
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => reject(new ApiError(`Can't reach ${useConnection.getState().deviceName ?? "TOT"} to send the photo.`, 0));
    xhr.ontimeout = xhr.onerror;
    xhr.timeout = 120_000;
    xhr.send(form);
  });
  if (status === 401 && !device) void tokenRefused(base);
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (status < 200 || status >= 300) {
    const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : `Upload failed (${status})`;
    throw new ApiError(message, status);
  }
  return (device ? adopt(device, data) : data) as Attachment;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}

const seg = encodeURIComponent;

export const api = {
  health: () => request<{ ok: true; version: string }>("GET", "/health"),
  upload,

  listAgents: () => request<Agent[]>("GET", "/agents"),
  /** Tasks come trimmed to what lists show (`task.partial`); a task's own load and its events have it whole. */
  listConversations: (agentId?: string) => request<Conversation[]>("GET", agentId ? `/conversations?agentId=${seg(agentId)}&slim=1` : "/conversations?slim=1"),
  createConversation: (body: CreateConversationRequest) => request<Conversation>("POST", "/conversations", body),
  /** Finished tool steps come clipped (`clipped`); getConversationPart has one whole. An older TOT ignores clip and sends them whole. */
  getConversation: (id: string) => request<ConversationDetail>("GET", `/conversations/${seg(id)}?clip=1`),
  getConversationPart: (conversationId: string, messageId: string, partId: string) =>
    request<MessagePart>("GET", `/conversations/${seg(conversationId)}/messages/${seg(messageId)}/parts/${seg(partId)}`),
  updateConversation: (id: string, body: UpdateConversationRequest) => request<Conversation>("PATCH", `/conversations/${seg(id)}`, body),
  deleteConversation: (id: string) => request<Ok>("DELETE", `/conversations/${seg(id)}`),
  sendMessage: (id: string, body: SendMessageRequest) => request<SendMessageResponse>("POST", `/conversations/${seg(id)}/messages`, body),

  /** What runs and waits for the user right now (app events only tell changes after that). */
  liveRuns: () => request<LiveRuns>("GET", "/runs/live"),
  stopRun: (runId: string) => request<Ok>("POST", `/runs/${seg(runId)}/stop`, {}),
  answerApproval: (runId: string, partId: string, answer: ApprovalAnswer) =>
    request<Ok>("POST", `/runs/${seg(runId)}/approvals/${seg(partId)}`, answer),
  /** A project Lead's land / discard / push card (module 11): answered on its own route, even after the turn. */
  answerLeadAsk: (partId: string, decision: "accept" | "decline") =>
    request<{ status: "accepted" | "declined"; ok: boolean; text: string }>("POST", `/lead/asks/${seg(partId)}`, { decision }),

  // Tasks (modules 01, 09): a task is a chat with kind "task" that works until it's done.
  /** A note for a running task; resolves with the saved message. */
  steerTask: (conversationId: string, text: string) => request<Message>("POST", `/conversations/${seg(conversationId)}/steer`, { text }),
  pauseTask: (id: string) => request<Conversation>("POST", `/tasks/${seg(id)}/pause`, {}),
  resumeTask: (id: string) => request<Conversation>("POST", `/tasks/${seg(id)}/resume`, {}),
  stopTask: (id: string) => request<Conversation>("POST", `/tasks/${seg(id)}/stop`, {}),
  runTaskNow: (id: string) => request<Conversation>("POST", `/tasks/${seg(id)}/run-now`, {}),
  /** How a finished coding task can land right now: merge into the folder's branch, or a draft PR, each with why it can't. */
  taskLandOptions: (id: string) => request<TaskLandOptions>("GET", `/tasks/${seg(id)}/land`),
  landTask: (id: string, body: LandTaskRequest) => request<Conversation>("POST", `/tasks/${seg(id)}/land`, body),
  /** Stops it, removes its worktree, and deletes its branch unless it was pushed. */
  discardTask: (id: string) => request<Conversation>("POST", `/tasks/${seg(id)}/discard`, {}),
  /** The task's branch against its base: files and the unified diff (cut short on huge changes). */
  taskChanges: (id: string) => request<TaskChanges>("GET", `/tasks/${seg(id)}/changes`),
  /** Its PLAN.md on the agent's computer; content null when there's none yet or the computer is off. */
  taskPlan: (id: string) => request<TaskPlan>("GET", `/tasks/${seg(id)}/plan`),
  /** Mission control: open tasks, finished ones still to land (with their land order), and the last day's landed ones. */
  getMission: () => request<MissionOverview>("GET", "/mission"),

  listProjects: () => request<Project[]>("GET", "/projects"),
  /** The project's Lead chat: made the first time (for `agentId`), the same one after. */
  openLead: (projectId: string, agentId?: string | null) => request<Conversation>("POST", `/projects/${seg(projectId)}/lead`, agentId ? { agentId } : {}),
  archiveProject: (id: string) => request<Project>("DELETE", `/projects/${seg(id)}`),
  getDevices: () => request<DevicesStatus>("GET", "/devices"),
  /** Signs that browser or phone out: its next request gets 401 and its event streams close. */
  signOutSession: (id: string) => request<DevicesStatus>("DELETE", `/sessions/${seg(id)}`),
  signOutOtherSessions: () => request<DevicesStatus>("POST", "/sessions/sign-out-others", {}),

  // The top bar and settings (M3). A device's settings are its own: these go to the signed-in TOT.
  listModels: () => request<ModelOption[]>("GET", "/models"),
  listProviders: () => request<ProviderStatus[]>("GET", "/providers"),
  createAgent: (input: AgentInput) => request<Agent>("POST", "/agents", input),
  updateAgent: (id: string, input: Partial<AgentInput>) => request<Agent>("PATCH", `/agents/${seg(id)}`, input),
  /** Deletes its chats and computer too; 400 for a device's last agent. */
  deleteAgent: (id: string) => request<Ok>("DELETE", `/agents/${seg(id)}`),
  getSettings: () => request<Settings>("GET", "/settings"),
  patchSettings: (patch: SettingsPatch) => request<Settings>("PATCH", "/settings", patch),
  /** Every Claude and ChatGPT sign-in; `refresh` checks them again. Env values never leave the server. */
  listAccounts: ({ refresh = false } = {}) => request<AccountStatus[]>("GET", refresh ? "/accounts?refresh=1" : "/accounts"),
  updateAccount: (id: string, patch: AccountPatch) => request<ProviderAccount>("PATCH", `/accounts/${seg(id)}`, patch),
  cleanUpWorktrees: (days?: number) => request<{ removed: number }>("POST", "/worktrees/cleanup", days === undefined ? {} : { days }),

  // Memory (module 10): the "you" repo, as in Settings → Memory.
  memoryRepos: () => request<MemoryRepoSummary[]>("GET", "/memory/repos"),
  memoryFiles: (repo: string) => request<MemoryFile[]>("GET", `/memory/${seg(repo)}/files`),
  createMemory: (content: string, repo?: string) => request<Memory>("POST", "/memories", repo ? { content, repo } : { content }),
  deleteMemory: (id: string, repo?: string) => request<Ok>("DELETE", `/memories/${seg(id)}${repo ? `?repo=${seg(repo)}` : ""}`),
  memoryHistory: (repo: string, limit: number) => request<MemoryCommit[]>("GET", `/memory/${seg(repo)}/history?limit=${limit}&skip=0`),
  revertMemory: (repo: string, sha: string) => request<MemoryCommit>("POST", `/memory/${seg(repo)}/revert`, { sha }),
  dreamMemory: (repo?: string) => request<Ok>("POST", "/memory/dream", repo ? { repo } : {}),

  // Knowledge (modules 10, 11), read-only on the phone but for a project's facts and undo: brains (each agent's
  // notebook, shared ones, each project's), their wiki pages, and a project's facts and history.
  listBrains: () => request<Brain[]>("GET", "/brains"),
  listWikiPages: (brainId: string) => request<WikiPageSummary[]>("GET", `/brains/${seg(brainId)}/wiki`),
  searchWiki: (brainId: string, q: string) => request<WikiSearchHit[]>("GET", `/brains/${seg(brainId)}/wiki?q=${seg(q)}`),
  getWikiPage: (pageId: string) => request<WikiPage>("GET", `/wiki/${seg(pageId)}`),
  knowledgeStatus: (projectId: string) => request<KnowledgeStatus>("GET", `/projects/${seg(projectId)}/knowledge`),
  knowledgeHistory: (projectId: string, limit: number) => request<KnowledgeCommit[]>("GET", `/projects/${seg(projectId)}/knowledge/history?limit=${limit}&skip=0`),
  /** Puts back what one change did, as a new change; 409 when later changes touched the same lines. */
  undoKnowledge: (projectId: string, sha: string) => request<KnowledgeCommit>("POST", `/projects/${seg(projectId)}/knowledge/undo`, { sha }),

  // Set up on the computer; the phone only shows where they stand.
  getGithub: () => request<GitHubStatus>("GET", "/github"),
  getSlack: () => request<SlackStatus>("GET", "/slack"),
  getApps: () => request<AppsStatus>("GET", "/apps"),
  listPersonas: () => request<Persona[]>("GET", "/personas"),
  listPlugins: () => request<Plugin[]>("GET", "/plugins"),
};
