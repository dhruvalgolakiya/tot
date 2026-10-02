import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { ACCESS_TOKEN, authRoutes, requireAuth } from "./auth.ts";
import { IS_PROD } from "./config.ts";
import { mcpRoutes } from "./mcp/server.ts";
import { api } from "./routes.ts";

/** The whole HTTP surface: MCP, sign-in, API, and (in production) the built web app. */
export function createApp(): Hono {
  const app = new Hono();
  // Order matters: MCP has its own bearer token, and the login page must be reachable signed out.
  app.route("/mcp", mcpRoutes);
  app.route("/", authRoutes);
  if (IS_PROD) app.get("/tot.svg", serveStatic({ path: "./dist/tot.svg" }));
  if (ACCESS_TOKEN) app.use("*", requireAuth);
  app.route("/api", api);

  if (IS_PROD) {
    app.use("/*", serveStatic({ root: "./dist" }));
    app.get("*", serveStatic({ path: "./dist/index.html" }));
  }
  return app;
}
