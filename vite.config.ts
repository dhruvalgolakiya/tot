import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { SESSION_COOKIE, readCookie, safeEqual, sessionValue, tokenProblem } from "./server/session.ts";

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

/**
 * With an access token set, the dev server requires sign-in as well (the API checks
 * it too), so nothing Vite serves reaches a visitor who hasn't signed in.
 */
function requireSignIn(token: string): Plugin {
  const session = sessionValue(token);
  const open = /^\/(api\/|login(\?|$)|logout(\?|$)|tot\.svg)/;
  return {
    name: "tot-require-sign-in",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "/";
        const cookie = readCookie(req.headers.cookie, SESSION_COOKIE);
        if (open.test(url) || (cookie && safeEqual(cookie, session))) return next();
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
  plugins: [react(), tailwindcss(), ...(accessToken ? [requireSignIn(accessToken)] : [])],
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("./shared", import.meta.url)) },
  },
  server: {
    port: 5173,
    // IPv4 only: many networks hand out public IPv6 addresses, and "all addresses"
    // would put TOT on the internet rather than just the LAN.
    host: lan ? "0.0.0.0" : undefined,
    // Bonjour names (e.g. my-mac.local); IP addresses are always allowed.
    allowedHosts: lan ? [".local"] : undefined,
    // The API compares Origin with the Host header to block cross-site requests,
    // so the proxy passes the browser's Host through unchanged.
    proxy: {
      "/api": api,
      "^/(login|logout)(\\?|$)": api,
    },
  },
  build: { outDir: "dist" },
});
