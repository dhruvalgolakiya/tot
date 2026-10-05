import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { ACCESS_TOKEN } from "./config.ts";
import { checkSession, createSession, describeBrowser, endSession } from "./devices/sessions.ts";
import { clientAddress, isThisMachine } from "./net.ts";
import { SESSION_COOKIE, tokenMatches } from "./session.ts";

/**
 * Sign-in for reaching TOT beyond this machine. With TOT_ACCESS_TOKEN set, every
 * page and API call needs that token — as a login cookie (browsers, via /login)
 * or an `Authorization: Bearer` header (scripts). Each browser that signs in gets
 * its own session (devices/sessions.ts), so it can be signed out on its own.
 * Without a token, TOT only serves this machine (see the host/origin guard in routes.ts).
 */

export { ACCESS_TOKEN };

const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

// Wrong guesses are counted globally: per-client keys would come from spoofable headers.
// With a 12+ character token this makes guessing hopeless while a real user can retry.
const MAX_FAILURES_PER_MINUTE = 20;
let failures = { count: 0, resetAt: 0 };

function lockedOut(): boolean {
  if (Date.now() > failures.resetAt) failures = { count: 0, resetAt: Date.now() + 60_000 };
  return failures.count >= MAX_FAILURES_PER_MINUTE;
}

const recordFailure = () => void failures.count++;

type AuthResult = "ok" | "missing" | "wrong-token" | "locked";

function check(c: Context): AuthResult {
  if (!ACCESS_TOKEN) return "ok";
  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer ")) {
    if (lockedOut()) return "locked";
    if (tokenMatches(header.slice(7), ACCESS_TOKEN)) return "ok";
    recordFailure();
    return "wrong-token";
  }
  return checkSession(getCookie(c, SESSION_COOKIE)) ? "ok" : "missing";
}

export const isAuthenticated = (c: Context) => check(c) === "ok";

/** The signed-in browser asking, or null (an access-token caller, or sign-in is off). */
export const currentSessionId = (c: Context): string | null => (ACCESS_TOKEN ? checkSession(getCookie(c, SESSION_COOKIE)) : null);

function onThisMachine(c: Context): boolean {
  try {
    return isThisMachine(clientAddress(getConnInfo(c).remote.address, c.req.header("x-forwarded-for")));
  } catch {
    return false;
  }
}

/** Guards pages and the API when an access token is set. */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const result = check(c);
  if (result === "ok") return next();
  if (result === "locked") return c.json({ error: "Too many wrong tokens — wait a minute." }, 429);
  if (c.req.path.startsWith("/api/")) return c.json({ error: "Sign in to TOT first." }, 401);
  const target = encodeURIComponent(c.req.path + (new URL(c.req.url).search || ""));
  return c.redirect(`/login?next=${target}`, 302);
};

/** Only same-site relative paths are allowed as post-login destinations. */
const safeNext = (value: string | undefined) => (value && /^\/(?!\/)/.test(value) ? value : "/");

function loginPage(error = "", next = "/"): string {
  const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#ffffff">
<!-- Inter (variable weight + optical size), same link as index.html. -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..700&display=swap">
<script>
  // Same saved theme as the app (src/lib/theme.ts): localStorage, falling back to the device setting.
  (function () {
    var saved = null;
    try { saved = localStorage.getItem("tot-theme"); } catch (e) {}
    var dark = saved === "dark" || (saved !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    document.querySelector('meta[name="theme-color"]').setAttribute("content", dark ? "#08080a" : "#ffffff");
  })();
</script>
<title>Sign in · TOT</title><link rel="icon" href="/tot.svg">
<style>
  /* Hand-mirrors DESIGN.md's tokens (src/index.css) since this page is plain server-rendered HTML/CSS,
     not Tailwind — same surfaces, text tiers, radii and focus ring as the app's Modal. */
  :root { --accent: #a78bfa; --accent-glow: color-mix(in oklch, var(--accent) 16%, transparent); }
  :root:not(.dark) {
    color-scheme: light;
    --bg: #f1f1f3; --card: #ffffff; --line: rgb(9 9 11 / 0.12);
    --text: oklch(14.1% 0.005 285.823); --muted: oklch(44.2% 0.017 285.786);
    --field: rgb(9 9 11 / 0.025); --focus: color-mix(in oklch, var(--accent) 62%, black);
    --primary-bg: oklch(21% 0.006 285.885); --primary-fg: #ffffff;
    --error: oklch(57.7% 0.245 27.325);
    --shadow: 0 2px 6px -2px rgb(9 9 11 / 0.06), 0 32px 64px -24px rgb(9 9 11 / 0.3);
  }
  :root.dark {
    color-scheme: dark;
    --bg: #111114; --card: #16161a; --line: rgb(255 255 255 / 0.1);
    --text: oklch(98.5% 0 none); --muted: oklch(70.5% 0.015 286.067);
    --field: rgb(255 255 255 / 0.025); --focus: color-mix(in oklch, var(--accent) 80%, transparent);
    --primary-bg: oklch(96.7% 0.001 286.375); --primary-fg: #08080a;
    --error: oklch(70.4% 0.191 22.216);
    --shadow: inset 0 1px 0 0 rgb(255 255 255 / 0.05), 0 32px 80px -16px rgb(0 0 0 / 0.8);
  }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
    font-size: 16px; line-height: 1.5; }
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  form { width: min(360px, 88vw); display: grid; gap: 16px; padding: 32px; border-radius: 16px;
    border: 1px solid var(--line); background: var(--card); box-shadow: var(--shadow); }
  h1 { margin: 0 0 4px; font-size: 20px; line-height: 28px; font-weight: 600; letter-spacing: -0.015em; }
  p { margin: 0 0 8px; color: var(--muted); font-size: 14px; line-height: 1.625; }
  input { height: 36px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--field);
    color: inherit; font: inherit; font-size: 14px; outline: none; }
  input:focus { border-color: var(--focus); box-shadow: 0 0 0 3px var(--accent-glow); }
  button { height: 36px; padding: 0 14px; border: 0; border-radius: 8px; background: var(--primary-bg);
    color: var(--primary-fg); font: inherit; font-size: 14px; font-weight: 500; cursor: pointer;
    transition: opacity 150ms; }
  button:hover { opacity: 0.9; }
  .error { color: var(--error); font-size: 12px; line-height: 1.5; margin: 0; }
  img { width: 40px; height: 40px; }
</style></head>
<body><form method="post" action="/login">
  <img src="/tot.svg" alt="">
  <h1>Welcome to TOT</h1>
  <p>Enter your access token to reach your agents. Dashes and capitals don't matter.</p>
  <input type="password" name="token" placeholder="Access token" autocomplete="current-password"
    autocapitalize="none" autocorrect="off" spellcheck="false" autofocus required>
  <input type="hidden" name="next" value="${escape(next)}">
  ${error ? `<p class="error">${escape(error)}</p>` : ""}
  <button type="submit">Sign in</button>
</form></body></html>`;
}

export const authRoutes = new Hono();

authRoutes.get("/login", (c) => {
  if (!ACCESS_TOKEN || isAuthenticated(c)) return c.redirect(safeNext(c.req.query("next")), 302);
  return c.html(loginPage("", safeNext(c.req.query("next"))));
});

authRoutes.post("/login", async (c) => {
  if (!ACCESS_TOKEN) return c.redirect("/", 302);
  const form = await c.req.parseBody();
  const next = safeNext(typeof form.next === "string" ? form.next : undefined);
  if (lockedOut()) return c.html(loginPage("Too many wrong tokens — wait a minute and try again.", next), 429);
  if (typeof form.token !== "string" || !tokenMatches(form.token, ACCESS_TOKEN)) {
    recordFailure();
    return c.html(loginPage("That token didn't match.", next), 401);
  }
  setCookie(c, SESSION_COOKIE, createSession(describeBrowser(c.req.header("user-agent"), onThisMachine(c))), {
    httpOnly: true,
    sameSite: "Strict",
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
