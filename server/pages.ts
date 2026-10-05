import { randomBytes } from "node:crypto";
import type { Context } from "hono";

/**
 * TOT's few server-rendered pages: signing in from another device, and where a pairing link points. They
 * load before the app (signed out), so they're plain HTML hand-matching the app's design tokens
 * (src/index.css): canvas, text tiers, hairlines, the Funnel fonts, light and dark.
 */

const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The TOT mark (two rings), as in src/components/ui/Logo.tsx. */
const LOGO = `<svg viewBox="8 12 48 40" width="44" height="37" fill="none" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><circle cx="20" cy="32" r="9" stroke="url(#g)" stroke-width="5"/><circle cx="44" cy="32" r="9" stroke="url(#g)" stroke-width="5"/></svg>`;

const STYLE = `
  :root { --accent: #8b7cf6; color-scheme: light;
    --canvas: #ffffff; --text: oklch(14.5% 0 0); --muted: oklch(43.9% 0 0); --subtle: oklch(50% 0 0);
    --field: rgb(0 0 0 / 0.025); --line: rgb(0 0 0 / 0.12); --hairline: rgb(0 0 0 / 0.08);
    --primary: oklch(14.5% 0 0); --on-primary: #fff; --danger: oklch(57.7% 0.245 27.325); --code: rgb(0 0 0 / 0.05); }
  :root.dark { color-scheme: dark;
    --canvas: #212121; --text: oklch(97% 0 0); --muted: oklch(70.8% 0 0); --subtle: oklch(68% 0 0);
    --field: rgb(255 255 255 / 0.03); --line: rgb(255 255 255 / 0.12); --hairline: rgb(255 255 255 / 0.08);
    --primary: oklch(97% 0 0); --on-primary: #171717; --danger: oklch(70.4% 0.191 22.216); --code: rgb(255 255 255 / 0.06); }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; display: grid; place-items: center; padding: 24px; background: var(--canvas); color: var(--text);
    font: 16px/1.5 "Funnel Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased; }
  main { width: min(360px, 100%); display: grid; gap: 24px; }
  header { display: grid; gap: 6px; justify-items: start; }
  header svg { margin-bottom: 14px; }
  h1 { margin: 0; font: 600 26px/1.2 "Funnel Display", "Funnel Sans", ui-sans-serif, system-ui, sans-serif; letter-spacing: -0.02em; }
  p { margin: 0; color: var(--muted); font-size: 15px; }
  form { display: grid; gap: 12px; }
  .field { position: relative; }
  input { width: 100%; height: 48px; padding: 0 48px 0 16px; border-radius: 14px; border: 1px solid var(--line);
    background: var(--field); color: inherit; font: inherit; outline: none; transition: border-color 150ms, box-shadow 150ms; }
  input:focus { border-color: color-mix(in oklch, var(--accent) 70%, transparent); box-shadow: 0 0 0 4px color-mix(in oklch, var(--accent) 16%, transparent); }
  .reveal { position: absolute; top: 6px; right: 6px; width: 36px; height: 36px; display: grid; place-items: center; border: 0; border-radius: 10px;
    background: transparent; color: var(--subtle); cursor: pointer; }
  .reveal:hover { color: var(--text); background: var(--code); }
  button.primary { height: 48px; border: 0; border-radius: 999px; background: var(--primary); color: var(--on-primary);
    font-family: inherit; font-size: 15px; font-weight: 500; cursor: pointer; transition: opacity 150ms; }
  p strong { color: var(--text); font-weight: 500; }
  button.primary:hover { opacity: 0.88; }
  button.primary:disabled { opacity: 0.5; cursor: default; }
  .error { color: var(--danger); font-size: 14px; }
  .hint { font-size: 13px; color: var(--subtle); border-top: 1px solid var(--hairline); padding-top: 16px; }
  .hint strong { color: var(--muted); font-weight: 500; }
  code { display: block; padding: 12px 14px; border-radius: 12px; background: var(--code); font: 13px/1.5 ui-monospace, "Geist Mono", monospace; word-break: break-all; }
  .busy { display: flex; align-items: center; gap: 10px; color: var(--muted); }
  .spinner { width: 16px; height: 16px; border-radius: 999px; border: 2px solid var(--line); border-top-color: var(--text); animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  :focus-visible { outline: 2px solid color-mix(in oklch, var(--accent) 70%, transparent); outline-offset: 2px; }
  [hidden] { display: none !important; }
`;

/** Same saved theme as the app (src/lib/theme.ts): localStorage, falling back to the device's setting. */
const THEME = `(function () {
  var saved = null;
  try { saved = localStorage.getItem("tot-theme"); } catch (e) {}
  var dark = saved === "dark" || (saved !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.querySelector('meta[name="theme-color"]').setAttribute("content", dark ? "#212121" : "#ffffff");
})();`;

/** Sends a page with a strict policy: its own inline script only (by nonce), no framing, forms post here only. */
export function sendPage(c: Context, page: { title: string; body: string; script?: string }, status: 200 | 401 | 403 | 429 = 200) {
  const nonce = randomBytes(16).toString("base64");
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join("; "),
  );
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
  return c.html(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#ffffff"><meta name="referrer" content="no-referrer">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Funnel+Display:wght@500..700&family=Funnel+Sans:wght@400..600&display=swap">
<link rel="icon" href="/tot.svg"><title>${escape(page.title)}</title>
<script nonce="${nonce}">${THEME}</script>
<style>${STYLE}</style></head>
<body>${page.body}${page.script ? `<script nonce="${nonce}">${page.script}</script>` : ""}</body></html>`,
    status,
  );
}

const EYE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>`;

export interface LoginPageOptions {
  deviceName: string;
  error?: string;
  next?: string;
}

/**
 * Signing in from another device: the password, or (opened from a phone's QR code) a one-time code in the
 * link's #fragment, which the page posts by itself. The fragment never reaches a server log.
 */
export function loginPage(c: Context, options: LoginPageOptions, status: 200 | 401 | 403 | 429 = 200) {
  const name = escape(options.deviceName);
  return sendPage(
    c,
    {
      title: `Sign in to ${options.deviceName} · TOT`,
      body: `<main>
<header>${LOGO}<h1>Sign in to ${name}</h1><p>Enter the password you chose for TOT.</p></header>
<p class="busy" id="busy" hidden><span class="spinner"></span>Signing you in…</p>
<form method="post" action="/login" id="form">
  <div class="field">
    <input type="password" name="password" id="password" placeholder="Password" aria-label="Password" autocomplete="current-password"
      autocapitalize="none" autocorrect="off" spellcheck="false" autofocus required>
    <button type="button" class="reveal" id="reveal" aria-label="Show password" title="Show password">${EYE}</button>
  </div>
  <input type="hidden" name="next" value="${escape(options.next ?? "/")}">
  ${options.error ? `<p class="error" role="alert">${escape(options.error)}</p>` : ""}
  <button type="submit" class="primary">Sign in</button>
</form>
<form method="post" action="/login" id="code-form" hidden><input type="hidden" name="code" id="code"><input type="hidden" name="next" value="/"></form>
<p class="hint">Forgot it? On <strong>${name}</strong>, open Settings → Devices and set a new one. That computer never asks for it.</p>
</main>`,
      script: `
var reveal = document.getElementById("reveal"), field = document.getElementById("password");
reveal.addEventListener("click", function () {
  var show = field.type === "password";
  field.type = show ? "text" : "password";
  reveal.setAttribute("aria-label", show ? "Hide password" : "Show password");
  field.focus();
});
// Opened from a phone's QR code: /login#code=…  The code is used once, then removed from the address bar.
var match = /[#&]code=([\\w-]+)/.exec(location.hash);
if (match) {
  history.replaceState(null, "", location.pathname);
  document.getElementById("code").value = match[1];
  document.getElementById("form").hidden = true;
  document.getElementById("busy").hidden = false;
  document.getElementById("code-form").submit();
}
document.getElementById("form").addEventListener("submit", function (event) {
  event.submitter && (event.submitter.disabled = true);
});`,
    },
    status,
  );
}

/** Where a pairing link points when it's opened in a browser: it belongs in TOT on the other device. */
export function pairPage(c: Context, deviceName: string) {
  const name = escape(deviceName);
  return sendPage(c, {
    title: `Pair with ${deviceName} · TOT`,
    body: `<main><header>${LOGO}<h1>Pair with ${name}</h1>
<p>This link goes in TOT on your other computer: open <strong>Settings → Devices → Pair a device</strong> there, and paste it.</p></header>
<code id="link"></code>
<p class="hint">It works once, for 5 minutes. Both computers need remote access turned on.</p></main>`,
    script: `document.getElementById("link").textContent = location.href;`,
  });
}
