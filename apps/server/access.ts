import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { RemoteAccessMode } from "@tot/shared/types";
import { ACCESS_TOKEN, ENV_REMOTE, getSecret, HOST, RAW_HOST_EXPOSED, setSecret } from "./config.ts";
import { db, parseJson, type Row } from "./db.ts";
import { isTailscaleAddress } from "./net.ts";
import { safeEqual, tokenMatches } from "./session.ts";

/**
 * Remote access (roadmap module 07): whether phones and other computers may reach this device, and how they
 * sign in. This computer never signs in. Everything else needs the password the user sets in the app (or the
 * legacy TOT_ACCESS_TOKEN), or a one-time code from a QR code shown on this computer.
 *
 * State only: the HTTP side is auth.ts and devices/routes.ts; the network side is listeners.ts.
 */

export class AccessError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 | 429,
  ) {
    super(message);
  }
}

const listeners = new Set<() => void>();

/** Runs `run` whenever the mode or the password changes (listeners.ts opens or closes network listeners). */
export function onAccessChange(run: () => void): () => void {
  listeners.add(run);
  return () => listeners.delete(run);
}

const changed = () => {
  for (const run of listeners) run();
};

// ---------------------------------------------------------------------------
// The mode: off, Tailscale, or this network
// ---------------------------------------------------------------------------

let stored: RemoteAccessMode | null = null;

function storedMode(): RemoteAccessMode {
  if (stored) return stored;
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'access'`).get() as Row | undefined;
  const mode = parseJson<{ mode?: string }>(row?.value, {}).mode;
  stored = mode === "tailscale" || mode === "lan" ? mode : "off";
  return stored;
}

/** Which .env variable fixes the mode (legacy), so the app's switch can't change it. */
export function setBy(): "TOT_LAN" | "TOT_HOST" | null {
  return ENV_REMOTE?.variable ?? (RAW_HOST_EXPOSED ? "TOT_HOST" : null);
}

export function effectiveMode(): RemoteAccessMode {
  if (ENV_REMOTE) return ENV_REMOTE.mode;
  if (RAW_HOST_EXPOSED) return isTailscaleAddress(HOST) ? "tailscale" : "lan";
  return storedMode();
}

export function setMode(mode: RemoteAccessMode) {
  if (setBy()) throw new AccessError(`Remote access is set by ${setBy()} in .env. Remove it there and restart TOT to manage it here.`, 409);
  if (mode !== "off" && !signInReady()) throw new AccessError("Set a password first: other devices sign in with it.", 400);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('access', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    JSON.stringify({ mode }),
  );
  stored = mode;
  if (mode === "off") clearSignInCodes();
  changed();
}

// ---------------------------------------------------------------------------
// The password
// ---------------------------------------------------------------------------

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;
/** scrypt N = 2^15, r = 8, p = 1: about 32 MiB and a few dozen ms per guess. Node's default maxmem is too small for it. */
const SCRYPT = { log2N: 15, r: 8, p: 1, keylen: 32 };
const MAXMEM = 64 * 1024 * 1024;

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCallback(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))));

const normalize = (password: string) => password.normalize("NFKC");

let passwordKnown: boolean | null = null;

export function passwordSet(): boolean {
  passwordKnown ??= Boolean(getSecret("signInPassword"));
  return passwordKnown;
}

/**
 * Other devices can sign in: a password is set, or TOT_ACCESS_TOKEN. While this is false nothing but this
 * computer can connect (no network listeners; routes.ts pins the Host), so auth.ts treats every request as
 * local. It only ever goes from false to true while TOT runs: a password can be changed, never removed.
 */
export function signInReady(): boolean {
  return passwordSet() || Boolean(ACCESS_TOKEN);
}

export function passwordProblem(password: string): string | null {
  const length = [...normalize(password)].length;
  if (length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (length > MAX_PASSWORD) return `Keep it under ${MAX_PASSWORD} characters.`;
  return null;
}

export async function setPassword(password: string) {
  const problem = passwordProblem(password);
  if (problem) throw new AccessError(problem, 400);
  const salt = randomBytes(16);
  const { log2N, r, p, keylen } = SCRYPT;
  const key = await scrypt(normalize(password), salt, keylen, { N: 2 ** log2N, r, p, maxmem: MAXMEM });
  setSecret("signInPassword", `scrypt$${log2N}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`);
  passwordKnown = true;
  clearSignInCodes();
  changed();
}

async function matchesStored(candidate: string): Promise<boolean> {
  const stored = getSecret("signInPassword");
  const [kind, log2N, r, p, salt, hash] = stored?.split("$") ?? [];
  if (kind !== "scrypt" || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await scrypt(normalize(candidate), Buffer.from(salt, "base64url"), expected.length, {
    N: 2 ** Number(log2N),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// ---------------------------------------------------------------------------
// Wrong guesses
// ---------------------------------------------------------------------------

// Counted globally: per-client keys would come from spoofable headers. With an 8+ character password and
// 20 guesses a minute, guessing takes years; a real user can still retry.
const MAX_FAILURES_PER_MINUTE = 20;
let failures = { count: 0, resetAt: 0 };

export function lockedOut(): boolean {
  if (Date.now() > failures.resetAt) failures = { count: 0, resetAt: Date.now() + 60_000 };
  return failures.count >= MAX_FAILURES_PER_MINUTE;
}

export const recordFailure = () => void failures.count++;

/** One scrypt at a time, so a flood of guesses can't take all the memory. */
let hashing: Promise<unknown> = Promise.resolve();

/** Checks a password (or the legacy access token). Wrong ones count toward the lockout. */
export async function checkGuess(candidate: unknown): Promise<"ok" | "wrong" | "locked"> {
  if (lockedOut()) return "locked";
  if (typeof candidate !== "string" || !candidate || candidate.length > MAX_PASSWORD * 4) {
    recordFailure();
    return "wrong";
  }
  if (ACCESS_TOKEN && tokenMatches(candidate, ACCESS_TOKEN)) return "ok";
  const turn = hashing.then(() => matchesStored(candidate));
  hashing = turn.catch(() => false);
  if (await turn.catch(() => false)) return "ok";
  recordFailure();
  return "wrong";
}

// ---------------------------------------------------------------------------
// One-time sign-in codes (the QR code that signs a phone in)
// ---------------------------------------------------------------------------

const CODE_TTL_MS = 5 * 60_000;
let liveCode: { hash: string; expiresAt: number } | null = null;

const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");

/** A new code replaces the last one. 128 random bits: it can't be guessed, so it isn't subject to the lockout. */
export function newSignInCode(): { code: string; expiresAt: number } {
  const code = randomBytes(16).toString("base64url");
  liveCode = { hash: hashCode(code), expiresAt: Date.now() + CODE_TTL_MS };
  return { code, expiresAt: liveCode.expiresAt };
}

/** Uses up the live code if this is it. */
export function redeemSignInCode(code: unknown): boolean {
  const live = liveCode;
  if (!live || live.expiresAt < Date.now() || typeof code !== "string" || !safeEqual(hashCode(code), live.hash)) return false;
  liveCode = null;
  return true;
}

export function clearSignInCodes() {
  liveCode = null;
}
