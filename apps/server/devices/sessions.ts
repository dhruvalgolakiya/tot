import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SignInSession } from "@tot/shared/types";
import { ACCESS_TOKEN } from "../config.ts";
import { db, type Row } from "../db.ts";
import { safeEqual, sessionValue } from "../session.ts";

/**
 * Sign-in sessions (roadmap module 07): one per browser or phone signed in to this device, so each can be
 * listed and signed out on its own. The cookie holds "<id>.<secret>"; only the secret's hash is stored.
 * Signing one out ends its requests at once and closes its open event streams.
 */

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** last_seen_at is written at most this often per session. */
const TOUCH_EVERY_MS = 60_000;

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

let tokenChecked = false;

/** Sessions belong to the access token they were made with: a new token signs every browser out, as it always has. */
function forgetIfTokenChanged() {
  if (tokenChecked || !ACCESS_TOKEN) return;
  tokenChecked = true;
  const fingerprint = hash(`sessions:${sessionValue(ACCESS_TOKEN)}`);
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'sign-in'`).get() as Row | undefined;
  if (row?.value === fingerprint) return;
  db.exec(`DELETE FROM sessions`);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('sign-in', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    fingerprint,
  );
}

/** Starts a session; returns the cookie value. */
export function createSession(label: string): string {
  forgetIfTokenChanged();
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (id, secret_hash, label, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    hash(secret),
    label,
    now,
    now,
  );
  return `${id}.${secret}`;
}

const lastTouched = new Map<string, number>();

/** The session a cookie belongs to, or null when it's missing, made up, signed out or expired. */
export function checkSession(cookie: string | undefined): string | null {
  forgetIfTokenChanged();
  const dot = cookie?.indexOf(".") ?? -1;
  if (!cookie || dot < 1) return null;
  const id = cookie.slice(0, dot);
  const row = db.prepare(`SELECT secret_hash, created_at FROM sessions WHERE id = ?`).get(id) as Row | undefined;
  if (!row || !safeEqual(String(row.secret_hash), hash(cookie.slice(dot + 1)))) return null;
  const now = Date.now();
  if (now - Number(row.created_at) > MAX_AGE_MS) {
    endSession(id);
    return null;
  }
  if (now - (lastTouched.get(id) ?? 0) > TOUCH_EVERY_MS) {
    lastTouched.set(id, now);
    db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).run(now, id);
  }
  return id;
}

const streams = new Map<string, Set<() => void>>();

/** Runs `close` when this caller is signed out or unpaired (for open event streams). Returns the unsubscribe. */
export function onSignOut(key: string | null, close: () => void): () => void {
  if (!key) return () => {};
  const set = streams.get(key) ?? new Set();
  streams.set(key, set);
  set.add(close);
  return () => {
    set.delete(close);
    if (!set.size && streams.get(key) === set) streams.delete(key);
  };
}

/** Closes every open stream of a caller: a session id, or `device:<id>` for a paired device. */
export function closeStreams(key: string) {
  const closers = streams.get(key);
  streams.delete(key);
  for (const close of closers ?? []) close();
}

export function endSession(id: string) {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  lastTouched.delete(id);
  closeStreams(id);
}

export function endOtherSessions(currentId: string | null) {
  const rows = db.prepare(`SELECT id FROM sessions WHERE id != ?`).all(currentId ?? "") as Row[];
  for (const row of rows) endSession(String(row.id));
}

export function listSessions(currentId: string | null): SignInSession[] {
  forgetIfTokenChanged();
  for (const row of db.prepare(`SELECT id FROM sessions WHERE created_at < ?`).all(Date.now() - MAX_AGE_MS) as Row[]) {
    endSession(String(row.id));
  }
  const rows = db.prepare(`SELECT * FROM sessions ORDER BY last_seen_at DESC, created_at DESC`).all() as Row[];
  return rows.map((row) => ({
    id: String(row.id),
    label: String(row.label),
    current: row.id === currentId,
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
  }));
}

/** "Safari on iPhone", "Chrome on this Mac". Good enough to tell your own browsers apart; never shown to anyone else. */
export function describeBrowser(userAgent: string | undefined, onThisMachine: boolean): string {
  const ua = userAgent ?? "";
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "A browser";
  const system = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux|CrOS/.test(ua)
              ? "Linux"
              : null;
  if (onThisMachine) return `${browser} on this ${system === "Mac" ? "Mac" : "computer"}`;
  return system ? `${browser} on ${system}` : browser;
}
