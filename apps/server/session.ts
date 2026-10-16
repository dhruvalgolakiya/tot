import { createHash, timingSafeEqual } from "node:crypto";

/**
 * What a signed-in session looks like. Shared by the API server (auth.ts) and
 * the Vite dev server (vite.config.ts), so both enforce the same sign-in.
 */

export const SESSION_COOKIE = "tot_session";
const MIN_TOKEN_LENGTH = 12;

/** Tokens compare case-insensitively, ignoring spaces and dashes, so they're easy to type on a phone. */
export function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[\s-]/g, "");
}

/** Why a token is too weak to protect TOT, or null when it's fine. */
export function tokenProblem(token: string): string | null {
  return normalizeToken(token).length < MIN_TOKEN_LENGTH
    ? `TOT_ACCESS_TOKEN is too short: use at least ${MIN_TOKEN_LENGTH} letters or digits (e.g. \`openssl rand -hex 16\`).`
    : null;
}

/** The cookie holds a hash of the token, so the token itself never sits in the browser. */
export function sessionValue(token: string): string {
  return createHash("sha256").update(`tot:${normalizeToken(token)}`).digest("hex");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export function tokenMatches(candidate: string | undefined, token: string): boolean {
  return candidate !== undefined && safeEqual(normalizeToken(candidate), normalizeToken(token));
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}
