import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { authRoutes, requireAuth } from "./auth.ts";
import { IS_PROD } from "./config.ts";
import { devWeb } from "./dev-web.ts";
import { openDeviceRoutes } from "./devices/routes.ts";
import { mcpRoutes } from "./mcp/server.ts";
import { api } from "./routes.ts";

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
  app.route("/api", api);

  if (IS_PROD) {
    app.use("/*", serveStatic({ root: "./dist" }));
    app.get("*", serveStatic({ path: "./dist/index.html" }));
  } else {
    app.on(["GET", "HEAD"], "*", devWeb);
  }
  return app;
}
