import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { isThisMachine, isTrustedLocalHost } from "./server/net.ts";
import { SESSION_COOKIE, readCookie } from "./server/session.ts";

// The same .env the server reads (real environment variables win).
try {
  process.loadEnvFile(".env");
} catch {
  // no .env — that's fine
}

// The dev API (server/config.ts): its own port, apart from the installed TOT.app's 8787.
const apiPort = Number(process.env.TOT_PORT ?? 8790);
/** Must match the server's WEB_PORT: remote access, paired devices and the agents' sandbox all assume it. */
const webPort = Number(process.env.TOT_WEB_PORT ?? 5173);

// Tunnels pointed straight at the dev server (`ngrok http 5173`) and hosts in TOT_ALLOWED_HOSTS. Vite refuses
// unknown Host headers otherwise; their visitors still sign in (requireSignIn below).
const tunnelHosts = [
  ".ngrok-free.app",
  ".ngrok-free.dev",
  ".ngrok.app",
  ".ngrok.dev",
  ...(process.env.TOT_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean) ?? []),
];

/** Recently confirmed sign-in cookies, so page loads don't each ask the API. */
const confirmed = new Map<string, number>();
const CONFIRMED_FOR_MS = 5000;

/** Whether the API knows this browser's sign-in (sessions live in its database; module 07). */
async function signedIn(cookie: string | undefined): Promise<boolean> {
  if (!cookie) return false;
  if ((confirmed.get(cookie) ?? 0) > Date.now()) return true;
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/current`, {
      headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    const ok = res.ok && Boolean(((await res.json()) as { id: string | null }).id);
    if (ok) confirmed.set(cookie, Date.now() + CONFIRMED_FOR_MS);
    else confirmed.delete(cookie);
    return ok;
  } catch {
    return false;
  }
}

/**
 * The dev server only listens on this computer (localhost), and other devices reach the app through TOT's
 * own remote-access listeners (server/dev-web.ts). Anything else reaching Vite (a tunnel pointed straight
 * at it) must have signed in, so nothing Vite serves reaches a visitor who hasn't. This computer itself
 * never signs in. The icon, the web app manifest, /.well-known/tot and the pairing page are open.
 */
function requireSignIn(): Plugin {
  const open = /^\/(api\/|login(\?|$)|logout(\?|$)|pair(\?|$)|tot\.svg|manifest\.webmanifest|icons\/|\.well-known\/tot)/;
  return {
    name: "tot-require-sign-in",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "/";
        const local = isThisMachine(req.socket.remoteAddress) && !req.headers["x-forwarded-for"] && isTrustedLocalHost(req.headers.host ?? "");
        if (local || open.test(url) || (await signedIn(readCookie(req.headers.cookie, SESSION_COOKIE)))) return next();
        const pageLoad = req.headers["sec-fetch-dest"] === "document" || req.headers.accept?.includes("text/html");
        if (req.method === "GET" && pageLoad) {
          res.writeHead(302, { Location: `/login?next=${encodeURIComponent(url)}` }).end();
        } else {
          res.writeHead(401, { "Content-Type": "text/plain" }).end("Sign in to TOT first.");
        }
      });
    },
  };
}

// xfwd: the API learns which device the browser is on (X-Forwarded-For), e.g. to allow
// app sign-ins only from this machine.
const api = { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false, xfwd: true };

export default defineConfig({
  plugins: [react(), tailwindcss(), requireSignIn()],
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("./shared", import.meta.url)) },
  },
  server: {
    port: webPort,
    strictPort: true,
    // Localhost only: other devices come through TOT's remote access (Settings → Devices).
    allowedHosts: tunnelHosts,
    // The API compares Origin with the Host header to block cross-site requests,
    // so the proxy passes the browser's Host through unchanged.
    proxy: {
      "/api": api,
      "^/(login|logout)(\\?|$)": api,
      "/.well-known/tot": api,
      // The page a pairing link opens (module 07); the code stays in the #fragment.
      "^/pair(\\?|$)": api,
    },
  },
  build: { outDir: "dist" },
});
