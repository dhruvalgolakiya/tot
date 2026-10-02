import type {
  CommandRun,
  GateReport,
  Playbook,
  PlaybookInput,
  PlaybookMatch,
  PlaybookPatch,
  RepoProfile,
  RepoProfileInput,
  Review,
  TrustCheckRequest,
  TrustReviewRequest,
  WorkflowSettings,
} from "@shared/types";
import { redirectToSignIn } from "../../lib/api";

/**
 * Fetch client for module 03's endpoints: repo profiles, playbooks, workflow
 * defaults, and the dev-only check and review routes (mirrors ../../lib/api.ts).
 */

/** A failed trust API call. `status` is 0 when the server couldn't be reached at all. */
export class TrustApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TrustApiError";
    this.status = status;
  }
}

const UNREACHABLE = "Can't reach the TOT server. Is it running?";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new TrustApiError(UNREACHABLE, 0);
  }

  if (response.status === 401) redirectToSignIn();
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof data.error === "string" && data.error
        ? data.error
        : response.status >= 500 && !data
          ? UNREACHABLE
          : `Request failed (${response.status})`;
    throw new TrustApiError(message, response.status);
  }
  return data as T;
}

const seg = encodeURIComponent;

export const trustApi = {
  profile: (brainId: string) => request<RepoProfile | null>("GET", `/brains/${seg(brainId)}/profile`),
  saveProfile: (brainId: string, input: RepoProfileInput) => request<RepoProfile>("PUT", `/brains/${seg(brainId)}/profile`, input),
  draftProfile: (brainId: string, agentId: string) => request<RepoProfile>("POST", `/brains/${seg(brainId)}/profile/draft`, { agentId }),
  runCommand: (brainId: string, agentId: string, command: string) =>
    request<CommandRun>("POST", `/brains/${seg(brainId)}/profile/run`, { agentId, command }),

  playbooks: () => request<Playbook[]>("GET", "/playbooks"),
  createPlaybook: (input: PlaybookInput) => request<Playbook>("POST", "/playbooks", input),
  updatePlaybook: (id: string, patch: PlaybookPatch) => request<Playbook>("PATCH", `/playbooks/${seg(id)}`, patch),
  deletePlaybook: (id: string) => request<{ ok: true }>("DELETE", `/playbooks/${seg(id)}`),
  matchPlaybook: (goal: string) => request<PlaybookMatch>("POST", "/playbooks/match", { goal }),

  workflows: () => request<WorkflowSettings>("GET", "/workflows"),
  updateWorkflows: (patch: Partial<WorkflowSettings>) => request<WorkflowSettings>("PATCH", "/workflows", patch),

  check: (input: TrustCheckRequest) => request<GateReport>("POST", "/trust/check", input),
  review: (input: TrustReviewRequest) => request<Review>("POST", "/trust/review", input),
};
