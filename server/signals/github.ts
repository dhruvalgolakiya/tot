import { createHash } from "node:crypto";
import { GITHUB_API_URL } from "../config.ts";
import { scrub } from "../trust/secrets.ts";

/**
 * Module 12 (docs/roadmap/12-coordinator.md), lane A: reading GitHub for the pull-request watcher. GET only, with
 * the GitHub connection's token; nothing is ever written. Answers are cached by ETag, so asking again about a PR
 * that didn't change costs nothing against the rate limit. A used-up rate limit (primary or secondary) comes back
 * as RateLimited with the time it resets; anything else GitHub refuses as GitHubReadError (status 0: unreachable).
 */

export class RateLimited extends Error {
  constructor(readonly until: number) {
    super(`GitHub's rate limit is used up until ${new Date(until).toLocaleTimeString()}.`);
  }
}

export class GitHubReadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 20_000;
const MAX_CACHED = 1000;
/** A secondary rate limit without a Retry-After waits at least this long. */
const SECONDARY_WAIT_MS = 60_000;

/** Path (and which token) → the last answer and its ETag. */
const cache = new Map<string, { etag: string; body: unknown }>();

const tokenKey = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 12);

/** When a refused answer says the rate limit is used up: until when, else null. */
function limitedUntil(res: Response, said: string): number | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const retryAfter = Number(res.headers.get("retry-after"));
  if (retryAfter > 0) return Date.now() + retryAfter * 1000;
  if (res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    return reset > 0 ? reset * 1000 : Date.now() + SECONDARY_WAIT_MS;
  }
  if (res.status === 429 || /rate limit/i.test(said)) return Date.now() + SECONDARY_WAIT_MS;
  return null;
}

/** GET `path` from GitHub's API as JSON. */
export async function readGitHub<T>(path: string, token: string): Promise<T> {
  const key = `${tokenKey(token)} ${path}`;
  const cached = cache.get(key);
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API_URL}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "TOT",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(cached ? { "If-None-Match": cached.etag } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new GitHubReadError(0, "Couldn't reach GitHub.");
  }
  if (res.status === 304 && cached) return cached.body as T;
  if (!res.ok) {
    const said = scrub(String(((await res.json().catch(() => ({}))) as { message?: unknown }).message ?? "")).slice(0, 200);
    const until = limitedUntil(res, said);
    if (until) throw new RateLimited(until);
    throw new GitHubReadError(res.status, `GitHub answered ${res.status}${said ? `: ${said}` : ""}.`);
  }
  const body = (await res.json()) as T;
  const etag = res.headers.get("etag");
  if (etag) {
    cache.delete(key);
    cache.set(key, { etag, body });
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  }
  return body;
}

/** Tests: forget cached answers. */
export function clearGitHubCache(): void {
  cache.clear();
}
