import type { Routine, RoutineInput } from "@shared/types";
import { redirectToSignIn } from "../../lib/api";

/**
 * Tiny fetch client for the routines endpoints (mirrors the shape of
 * ../../lib/api.ts, sharing only its sign-in redirect).
 */

/** A failed routines API call. `status` is 0 when the server couldn't be reached at all. */
export class RoutinesApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RoutinesApiError";
    this.status = status;
  }
}

const UNREACHABLE = "Can't reach the TOT server. Is it running?";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new RoutinesApiError(UNREACHABLE, 0);
  }

  if (response.status === 401) redirectToSignIn();
  const data = parseBody(await response.text());
  if (!response.ok) throw new RoutinesApiError(serverError(data, response.status), response.status);
  return data as T;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function serverError(data: unknown, status: number): string {
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string" && data.error) {
    return data.error;
  }
  // The dev proxy answers with an empty 5xx when the backend is down.
  if (status >= 500 && !data) return UNREACHABLE;
  return `Request failed (${status})`;
}

/** Human-readable message for anything thrown by a routines API call. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong.";
}

const seg = encodeURIComponent;

export const routinesApi = {
  list: (agentId: string) => request<Routine[]>("GET", `/agents/${seg(agentId)}/routines`),
  create: (agentId: string, input: RoutineInput) =>
    request<Routine>("POST", `/agents/${seg(agentId)}/routines`, input),
  update: (id: string, input: Partial<RoutineInput>) => request<Routine>("PATCH", `/routines/${seg(id)}`, input),
  remove: (id: string) => request<{ ok: true }>("DELETE", `/routines/${seg(id)}`),
  run: (id: string) => request<{ conversationId: string; runId: string }>("POST", `/routines/${seg(id)}/run`, {}),
};
