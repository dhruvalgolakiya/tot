import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { Readable } from "node:stream";
import type { Context } from "hono";
import { PORT, WEB_PORT } from "./config.ts";

/**
 * Development only: a phone or another computer reaching TOT over remote access (listeners.ts) gets the web
 * app from the local Vite server through here, so Vite itself never listens on the network. Pages and
 * assets only (GET/HEAD); the API is served directly. Sign-in was already checked (requireAuth). Live
 * reload doesn't reach other devices: reload by hand.
 */

/** Hop-by-hop headers, and what would carry the visitor's own sign-in or address to Vite. */
const DROPPED = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization"]);
const FORWARDED_REQUEST = ["accept", "accept-language", "if-none-match", "if-modified-since", "user-agent", "range"];

export async function devWeb(c: Context): Promise<Response> {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.text("Not here.", 405);
  if (c.req.path.startsWith("/api/")) return c.json({ error: "Not found." }, 404);
  // Would ask itself for the page, forever.
  if (WEB_PORT === PORT) return c.text("TOT's web app isn't running.", 502);

  const url = new URL(c.req.url);
  const headers: Record<string, string> = { host: `localhost:${WEB_PORT}` };
  for (const name of FORWARDED_REQUEST) {
    const value = c.req.header(name);
    if (value) headers[name] = value;
  }
  try {
    const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
      // "localhost" with autoSelectFamily: Vite listens on ::1 or 127.0.0.1, depending on the machine.
      const options: RequestOptions & { autoSelectFamily: boolean } = {
        host: "localhost",
        port: WEB_PORT,
        path: url.pathname + url.search,
        method: c.req.method,
        headers,
        autoSelectFamily: true,
      };
      const req = httpRequest(options, resolve);
      req.on("error", reject);
      req.setTimeout(15_000, () => req.destroy(new Error("timeout")));
      req.end();
    });
    const out = new Headers();
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (value === undefined || DROPPED.has(name) || name === "set-cookie") continue;
      out.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const body = c.req.method === "HEAD" ? null : (Readable.toWeb(upstream) as ReadableStream);
    return new Response(body, { status: upstream.statusCode ?? 502, headers: out });
  } catch {
    return c.text("TOT's web app isn't running. Start it with npm run dev.", 502);
  }
}
