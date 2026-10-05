import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { checkGuess, lockedOut, recordFailure, redeemSignInCode, signInReady } from "./access.ts";
import { ACCESS_TOKEN } from "./config.ts";
import { deviceName } from "./devices/identity.ts";
import { DEVICE_TOKEN_PREFIX, peers } from "./devices/peers.ts";
import { checkSession, createSession, describeBrowser, endSession } from "./devices/sessions.ts";
import { clientAddress, isThisMachine, isTrustedLocalHost } from "./net.ts";
import { loginPage } from "./pages.ts";
import { SESSION_COOKIE, tokenMatches } from "./session.ts";

/**
 * Who may use TOT (roadmap module 07). This computer never signs in. Any other device (a phone, another
 * browser, a paired computer) does: a session cookie from /login (the password set in Settings → Devices,
 * the legacy TOT_ACCESS_TOKEN, or a one-time code from a QR code), a paired device's token, or the access
 * token as a Bearer header for scripts. Until sign-in is set up, only this computer can connect at all
 * (access.ts signInReady), and every request is local.
 */

export { ACCESS_TOKEN };

const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

/**
 * Who a request is from: this computer, a script with the access token, a signed-in browser (its
 * session), or a paired device (module 07; its own token, never the access token).
 */
export type Caller = { kind: "local" } | { kind: "token" } | { kind: "session"; id: string } | { kind: "device"; id: string };

/** The caller, and whether the request comes straight from this computer (which may, e.g., reset the password). */
interface Auth {
  caller: Caller;
  local: boolean;
}

const LOCAL: Caller = { kind: "local" };

function peerAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

/**
 * Straight from this computer: the connection comes from this machine, nothing forwarded it from elsewhere
 * (a tunnel or proxy adds X-Forwarded-For), and the Host is a loopback name (not this computer's LAN or
 * Tailscale address, which a container, VM or DNS-rebinding site could use). An unknown peer is remote.
 */
function requestIsLocal(c: Context): boolean {
  const peer = peerAddress(c);
  if (!peer || !isTrustedLocalHost(c.req.header("host") ?? "")) return false;
  return isThisMachine(clientAddress(peer, c.req.header("x-forwarded-for")));
}

type AuthResult = Auth | "missing" | "wrong-token" | "locked";

function decide(c: Context): AuthResult {
  if (!signInReady()) return { caller: LOCAL, local: true };
  const local = requestIsLocal(c);
  // A Bearer header first: a paired device on this same computer must still count as that device.
  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer ")) {
    if (lockedOut()) return "locked";
    const token = header.slice(7).trim();
    const device = peers.byToken(token);
    if (device) return { caller: { kind: "device", id: device }, local: false };
    if (ACCESS_TOKEN && !token.startsWith(DEVICE_TOKEN_PREFIX) && tokenMatches(token, ACCESS_TOKEN)) return { caller: { kind: "token" }, local };
    recordFailure();
    return "wrong-token";
  }
  const session = checkSession(getCookie(c, SESSION_COOKIE));
  if (session) return { caller: { kind: "session", id: session }, local };
  return local ? { caller: LOCAL, local: true } : "missing";
}

const decided = new WeakMap<Request, Auth>();

/** Decided once per request (in requireAuth, before anything awaits), then reused. */
function authOf(c: Context): Auth {
  const known = decided.get(c.req.raw);
  if (known) return known;
  const result = decide(c);
  const auth = typeof result === "object" ? result : { caller: { kind: "token" } as Caller, local: false };
  decided.set(c.req.raw, auth);
  return auth;
}

/** Who's asking. Only meaningful behind requireAuth (or with sign-in not set up, when everyone is local). */
export const callerOf = (c: Context): Caller => authOf(c).caller;

/** The request comes straight from this computer. */
export const onThisMachine = (c: Context): boolean => authOf(c).local;

export const isAuthenticated = (c: Context) => typeof decide(c) === "object";

/** The signed-in browser asking, or null (this computer without a session, a script, or a paired device). */
export const currentSessionId = (c: Context): string | null => {
  const caller = callerOf(c);
  return caller.kind === "session" ? caller.id : null;
};

/** What closes this caller's event streams when it's signed out or unpaired: its session, or `device:<id>`. */
export const callerKey = (c: Context): string | null => {
  const caller = callerOf(c);
  return caller.kind === "session" ? caller.id : caller.kind === "device" ? `device:${caller.id}` : null;
};

/** Lets this computer through, and anyone else who signed in; others get 401 (the API) or the sign-in page. */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const result = decide(c);
  if (typeof result === "object") {
    decided.set(c.req.raw, result);
    return next();
  }
  if (result === "locked") return c.json({ error: "Too many wrong tries. Wait a minute." }, 429);
  if (c.req.path.startsWith("/api/")) return c.json({ error: "Sign in to TOT first." }, 401);
  const target = encodeURIComponent(c.req.path + (new URL(c.req.url).search || ""));
  return c.redirect(`/login?next=${target}`, 302);
};

/** Only same-site relative paths are allowed as post-login destinations. */
const safeNext = (value: string | undefined) => (value && /^\/(?!\/)/.test(value) ? value : "/");

export const authRoutes = new Hono();

authRoutes.get("/login", (c) => {
  const next = safeNext(c.req.query("next"));
  // This computer, or a browser that's already signed in: nothing to do here.
  if (isAuthenticated(c)) return c.redirect(next, 302);
  return loginPage(c, { deviceName: deviceName(), next });
});

authRoutes.post("/login", async (c) => {
  if (!signInReady()) return c.redirect("/", 302);
  const form = await c.req.parseBody();
  const next = safeNext(typeof form.next === "string" ? form.next : undefined);
  const name = deviceName();
  if (typeof form.code === "string") {
    // From a phone's QR code. Codes can't be guessed, so they work even while wrong passwords are locked out.
    if (!redeemSignInCode(form.code)) {
      return loginPage(c, { deviceName: name, next, error: `This sign-in link has expired or was already used. Show a new code on ${name}: Settings → Devices → Add a phone.` }, 401);
    }
  } else {
    // "token": the field's old name, for old bookmarks and scripts.
    const guess = await checkGuess(form.password ?? form.token);
    if (guess === "locked") return loginPage(c, { deviceName: name, next, error: "Too many wrong tries. Wait a minute, then try again." }, 429);
    if (guess === "wrong") return loginPage(c, { deviceName: name, next, error: "That password didn't match." }, 401);
  }
  // Lax, so a link to TOT opened from another app (Messages, Mail) arrives signed in. Cross-site writes are
  // still refused by the Origin check in routes.ts.
  setCookie(c, SESSION_COOKIE, createSession(describeBrowser(c.req.header("user-agent"), requestIsLocal(c))), {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  return c.redirect(next, 302);
});

authRoutes.post("/logout", (c) => {
  const session = currentSessionId(c);
  if (session) endSession(session);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/login", 302);
});
