import type {
  Agent,
  ApprovalAnswer,
  Conversation,
  ConversationDetail,
  CreateConversationRequest,
  DevicesStatus,
  LandTaskRequest,
  LiveRuns,
  Message,
  MissionOverview,
  Project,
  SendMessageRequest,
  SendMessageResponse,
  TaskLandOptions,
  UpdateConversationRequest,
} from "@shared/types";
import { tokenRefused, useConnection } from "./connection";
import { adopt, apiPath, deviceFor } from "./devices";

/**
 * The TOT API, ported from the web app's src/lib/api.ts: the same paths and types (shared/types.ts), sent to
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
  if (response.status === 401 && !device) void tokenRefused();
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

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}

const seg = encodeURIComponent;

export const api = {
  health: () => request<{ ok: true; version: string }>("GET", "/health"),

  listAgents: () => request<Agent[]>("GET", "/agents"),
  listConversations: (agentId?: string) => request<Conversation[]>("GET", agentId ? `/conversations?agentId=${seg(agentId)}` : "/conversations"),
  createConversation: (body: CreateConversationRequest) => request<Conversation>("POST", "/conversations", body),
  getConversation: (id: string) => request<ConversationDetail>("GET", `/conversations/${seg(id)}`),
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
  /** Mission control: open tasks, finished ones still to land (with their land order), and the last day's landed ones. */
  getMission: () => request<MissionOverview>("GET", "/mission"),

  listProjects: () => request<Project[]>("GET", "/projects"),
  /** The project's Lead chat: made the first time (for `agentId`), the same one after. */
  openLead: (projectId: string, agentId?: string | null) => request<Conversation>("POST", `/projects/${seg(projectId)}/lead`, agentId ? { agentId } : {}),
  archiveProject: (id: string) => request<Project>("DELETE", `/projects/${seg(id)}`),
  getDevices: () => request<DevicesStatus>("GET", "/devices"),
};
