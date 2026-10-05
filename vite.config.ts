import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { SESSION_COOKIE, readCookie, tokenProblem } from "./server/session.ts";

// The same .env the server reads (real environment variables win).
try {
  process.loadEnvFile(".env");
} catch {
  // no .env — that's fine
}

const apiPort = Number(process.env.TOT_PORT ?? 8787);
const accessToken = process.env.TOT_ACCESS_TOKEN?.trim() || undefined;
const lan = /^(1|true|yes|on)$/i.test(process.env.TOT_LAN?.trim() ?? "");

if (lan && !accessToken) {
  throw new Error("TOT_LAN is on but TOT_ACCESS_TOKEN is empty. Set one in .env first (e.g. `openssl rand -hex 16`).");
}
const weakToken = accessToken && tokenProblem(accessToken);
if (weakToken) throw new Error(weakToken);

// With sign-in on, TOT may also be reached through an ngrok tunnel (`ngrok http 5173`)
// or hosts listed in TOT_ALLOWED_HOSTS; Vite refuses unknown Host headers otherwise.
const tunnelHosts = accessToken
  ? [".ngrok-free.app", ".ngrok-free.dev", ".ngrok.app", ".ngrok.dev", ...(process.env.TOT_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean) ?? [])]
  : [];

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
 * With an access token set, the dev server requires sign-in as well (the API checks
 * it too), so nothing Vite serves reaches a visitor who hasn't signed in. The icon,
 * the web app manifest and /.well-known/tot are open (browsers fetch the manifest
 * without cookies).
 */
function requireSignIn(): Plugin {
  const open = /^\/(api\/|login(\?|$)|logout(\?|$)|tot\.svg|manifest\.webmanifest|icons\/|\.well-known\/tot)/;
  return {
    name: "tot-require-sign-in",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "/";
        if (open.test(url) || (await signedIn(readCookie(req.headers.cookie, SESSION_COOKIE)))) return next();
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
  plugins: [react(), tailwindcss(), ...(accessToken ? [requireSignIn()] : [])],
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("./shared", import.meta.url)) },
  },
  server: {
    port: 5173,
    // IPv4 only: many networks hand out public IPv6 addresses, and "all addresses"
    // would put TOT on the internet rather than just the LAN.
    host: lan ? "0.0.0.0" : undefined,
    // Bonjour names (e.g. my-mac.local) and tunnels; IP addresses are always allowed.
    allowedHosts: [...(lan ? [".local"] : []), ...tunnelHosts],
    // The API compares Origin with the Host header to block cross-site requests,
    // so the proxy passes the browser's Host through unchanged.
    proxy: {
      "/api": api,
      "^/(login|logout)(\\?|$)": api,
      "/.well-known/tot": api,
    },
  },
  build: { outDir: "dist" },
});
