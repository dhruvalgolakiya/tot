import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { ACCESS_TOKEN } from "./config.ts";
import { SESSION_COOKIE, safeEqual, sessionValue, tokenMatches } from "./session.ts";

/**
 * Sign-in for reaching TOT beyond this machine. With TOT_ACCESS_TOKEN set, every
 * page and API call needs that token — as a login cookie (browsers, via /login)
 * or an `Authorization: Bearer` header (scripts). Without it, TOT only serves
 * this machine (see the host/origin guard in routes.ts).
 */

export { ACCESS_TOKEN };

const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const SESSION = ACCESS_TOKEN ? sessionValue(ACCESS_TOKEN) : "";

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
  const cookie = getCookie(c, SESSION_COOKIE);
  return cookie && safeEqual(cookie, SESSION) ? "ok" : "missing";
}

export const isAuthenticated = (c: Context) => check(c) === "ok";

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
  :root { color-scheme: light; --bg: #f7f7f8; --card: #ffffff; --text: #09090b; --muted: rgb(9 9 11 / 0.55);
    --field: #ffffff; --line: rgb(9 9 11 / 0.12); --lift: 0 0 0 1px rgb(9 9 11 / 0.06), 0 24px 60px -28px rgb(9 9 11 / 0.3);
    --error: #b91c1c; }
  :root.dark { color-scheme: dark; --bg: #08080a; --card: #111114; --text: #f4f4f5; --muted: rgb(255 255 255 / 0.55);
    --field: #0b0b0e; --line: rgb(255 255 255 / 0.08); --lift: inset 0 1px 0 rgb(255 255 255 / 0.05), 0 30px 80px rgb(0 0 0 / 0.5);
    --error: #fca5a5; }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text);
    font: 16px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; }
  form { width: min(360px, 88vw); display: grid; gap: 14px; padding: 32px; border-radius: 24px; background: var(--card);
    box-shadow: var(--lift); }
  h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: -0.02em; }
  p { margin: 0 0 8px; color: var(--muted); font-size: 14px; }
  input { padding: 12px 14px; border-radius: 14px; border: 1px solid var(--line); background: var(--field);
    color: inherit; font: inherit; outline: none; }
  input:focus { border-color: #a78bfa; box-shadow: 0 0 0 3px rgb(167 139 250 / 0.25); }
  button { padding: 12px; border: 0; border-radius: 14px; background: #a78bfa; color: #0b0b0f; font: inherit;
    font-weight: 600; cursor: pointer; }
  .error { color: var(--error); font-size: 13px; margin: 0; }
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
  setCookie(c, SESSION_COOKIE, SESSION, {
    httpOnly: true,
    sameSite: "Strict",
    secure: new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  return c.redirect(next, 302);
});

authRoutes.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/login", 302);
});
