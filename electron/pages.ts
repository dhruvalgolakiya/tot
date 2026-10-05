/**
 * The few pages the Mac app draws itself, before TOT's own UI is there (roadmap module 08): "Starting TOT…",
 * and what went wrong with a way out. They look like TOT (DESIGN.md: neutral greys, the rings, pill buttons;
 * light and dark follow macOS). Buttons are links to `tot-app:` actions, which the window catches (main.ts).
 */

export type PageAction = "start" | "log";

/** What a link to `tot-app:<action>` asks for. */
export const ACTION_SCHEME = "tot-app:";

const RINGS = `<svg width="56" height="28" viewBox="0 0 56 28" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><circle cx="14" cy="14" r="10.9" fill="none" stroke="url(#g)" stroke-width="5.6"/><circle cx="42" cy="14" r="10.9" fill="none" stroke="url(#g)" stroke-width="5.6"/></svg>`;

const STYLE = `
:root{color-scheme:light dark;--canvas:#fff;--fg:oklch(20.5% 0 0);--muted:oklch(43.9% 0 0);--edge:rgb(0 0 0/.12);--hover:rgb(0 0 0/.045)}
@media (prefers-color-scheme:dark){:root{--canvas:#212121;--fg:oklch(97% 0 0);--muted:oklch(70.8% 0 0);--edge:rgb(255 255 255/.12);--hover:rgb(255 255 255/.07)}}
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;background:var(--canvas);color:var(--fg);font:14px/20px -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased;user-select:none;-webkit-app-region:drag}
main{max-width:400px;padding:24px;text-align:center}
svg{display:block;margin:0 auto 20px}
h1{margin:0;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.015em}
p{margin:6px 0 0;color:var(--muted);line-height:1.6}
.actions{display:flex;gap:8px;justify-content:center;margin-top:24px}
a{-webkit-app-region:no-drag;display:inline-flex;align-items:center;height:36px;padding:0 16px;border:1px solid var(--edge);border-radius:9999px;color:var(--fg);font-weight:500;text-decoration:none;transition:background-color 150ms}
a:hover{background:var(--hover)}
a.primary{border-color:transparent;background:var(--fg);color:var(--canvas)}
a.primary:hover{opacity:.9}
.starting svg{animation:breathe 1.6s ease-in-out infinite}
@keyframes breathe{50%{opacity:.5}}
@media (prefers-reduced-motion:reduce){.starting svg{animation:none}}
`;

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function page(body: string, className = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>TOT</title><style>${STYLE}</style></head><body><main class="${className}">${RINGS}${body}</main></body></html>`;
}

/** A page with a title, a sentence or two, and up to two buttons (the first one primary). */
function problem(title: string, detail: string, actions: [PageAction, string][]): string {
  const buttons = actions.map(([action, label], i) => `<a href="${ACTION_SCHEME}${action}"${i === 0 ? ' class="primary"' : ""}>${escape(label)}</a>`).join("");
  return page(`<h1>${escape(title)}</h1><p>${escape(detail)}</p><div class="actions">${buttons}</div>`);
}

export const pageUrl = (html: string) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

export const startingPage = () => page(`<p>Starting TOT…</p>`, "starting");

export const stoppedPage = (exit: { code: number | null; signal: string | null }) =>
  problem("TOT stopped", `The TOT server quit unexpectedly (${exit.signal ?? `exit code ${exit.code}`}). The log may say why.`, [
    ["start", "Restart"],
    ["log", "Show log"],
  ]);

export const didntStartPage = () =>
  problem("TOT didn't start", "The TOT server didn't answer within a minute. The log may say why.", [
    ["start", "Try again"],
    ["log", "Show log"],
  ]);

export const portTakenPage = (port: number) =>
  problem(
    `Port ${port} is in use`,
    `Another program is using port ${port}, so TOT can't start there. Quit that program and try again, or start TOT with TOT_PORT set to a free port.`,
    [["start", "Try again"]],
  );

export const notBuiltPage = () =>
  problem("TOT's web app isn't built", "Run npm run build in the TOT folder, then try again.", [["start", "Try again"]]);

export const unreachablePage = (port: number) =>
  problem("Can't reach TOT", `Nothing answers at localhost:${port} any more. Try again to start it.`, [
    ["start", "Try again"],
    ["log", "Show log"],
  ]);
