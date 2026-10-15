import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { authRoutes, requireAuth } from "./auth.ts";
import { IS_PROD } from "./config.ts";
import { devWeb } from "./dev-web.ts";
import { openDeviceRoutes } from "./devices/routes.ts";
import { mcpRoutes } from "./mcp/server.ts";
import { clientAddress, isThisMachine } from "./net.ts";
import { api } from "./routes.ts";

const gzipAsync = promisify(gzip);
/** Smaller JSON isn't worth compressing. */
const GZIP_MIN_BYTES = 1024;

/** Whether the request comes from this computer itself (directly, or through the local dev proxy); unknown counts as yes. */
function fromThisMachine(c: Context): boolean {
  let peer: string | undefined;
  try {
    peer = getConnInfo(c).remote.address;
  } catch {
    return true;
  }
  return !peer || isThisMachine(clientAddress(peer, c.req.header("x-forwarded-for")));
}

/**
 * The API's JSON, gzipped for other devices (a phone or another computer over Wi-Fi or Tailscale), where a chat's
 * megabytes take real time to cross. Not for this computer (the Mac app and the local web app load it from localhost,
 * where compressing costs more than it saves), never for event streams, and not under 1 KB.
 */
const gzipForOtherDevices: MiddlewareHandler = async (c, next) => {
  await next();
  const res = c.res;
  if (
    fromThisMachine(c) ||
    c.req.method === "HEAD" ||
    !res.body ||
    res.headers.has("content-encoding") ||
    !/^application\/json/i.test(res.headers.get("content-type") ?? "") ||
    !/\bgzip\b/i.test(c.req.header("accept-encoding") ?? "")
  ) {
    return;
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length < GZIP_MIN_BYTES) {
    c.res = new Response(body, res);
  } else {
    c.res = new Response(await gzipAsync(body), res);
    c.res.headers.set("content-encoding", "gzip");
    c.res.headers.delete("content-length");
    const etag = c.res.headers.get("etag");
    if (etag && !etag.startsWith("W/")) c.res.headers.set("etag", `W/${etag}`);
  }
  c.res.headers.append("vary", "Accept-Encoding");
};

/**
 * Built files (/assets/…) are named by their content's hash, so browsers may keep them for good; the page itself is
 * checked every time, so a new build shows on the next load. (The web app's page answering for a missing asset is
 * a page, not an asset.)
 */
export const cacheBuilt: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.res.status !== 200) return;
  const page = (c.res.headers.get("content-type") ?? "").startsWith("text/html");
  if (page) c.res.headers.set("cache-control", "no-cache");
  else if (c.req.path.startsWith("/assets/")) c.res.headers.set("cache-control", "public, max-age=31536000, immutable");
};

/**
 * The whole HTTP surface: MCP, sign-in, API, and the web app (built, in production; through the Vite dev
 * server, for other devices in development). The same app serves the main listener and the remote-access
 * listeners (listeners.ts); requireAuth tells this computer from other devices per request.
 */
export function createApp(): Hono {
  const app = new Hono();
  // Order matters: MCP has its own bearer token, and the sign-in page must be reachable signed out.
  app.route("/mcp", mcpRoutes);
  app.route("/", authRoutes);
  app.route("/", openDeviceRoutes);
  // The icon and the web app manifest load without sign-in (browsers fetch the manifest without cookies).
  if (IS_PROD) {
    app.get("/tot.svg", serveStatic({ path: "./dist/tot.svg" }));
    app.get("/manifest.webmanifest", serveStatic({ path: "./dist/manifest.webmanifest" }));
    app.get("/icons/*", serveStatic({ root: "./dist" }));
  } else {
    app.get("/tot.svg", devWeb);
    app.get("/manifest.webmanifest", devWeb);
    app.get("/icons/*", devWeb);
  }
  app.use("*", requireAuth);
  app.use("/api/*", gzipForOtherDevices);
  app.route("/api", api);

  if (IS_PROD) {
    app.use("/*", cacheBuilt);
    app.use("/*", serveStatic({ root: "./dist" }));
    app.get("*", serveStatic({ path: "./dist/index.html" }));
  } else {
    app.on(["GET", "HEAD"], "*", devWeb);
  }
  return app;
}
