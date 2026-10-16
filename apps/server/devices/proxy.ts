import type { Context } from "hono";
import { peers } from "./peers.ts";

/**
 * Forwards /api/d/<deviceId>/… to a paired device's /api/… with this device's token for it (roadmap
 * module 07). The browser only ever talks to the device it's signed in to: no CORS, and it never holds
 * another device's token. Streams (app events, a run's events with Last-Event-ID) pass straight through.
 */

/** Never forwarded: they belong to this hop, or would carry this device's own sign-in. */
const DROPPED_REQUEST = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "origin",
  "proxy-authorization",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);
/** fetch() already decoded the body, so its encoding and length no longer apply. */
const DROPPED_RESPONSE = new Set(["connection", "content-encoding", "content-length", "keep-alive", "set-cookie", "transfer-encoding"]);

/** Long enough for an upload; streams are exempt once the other side answers. */
const ANSWER_TIMEOUT_MS = 60_000;

/**
 * Never forwarded: the memory sync bundle (module 10) is for paired devices themselves. Forwarded, it would hand
 * the other device's whole memory to whoever is signed in here, under this device's token.
 */
export function proxyRefuses(path: string): boolean {
  let parts: string[];
  try {
    parts = path.split("/").filter(Boolean).map((part) => decodeURIComponent(part).toLowerCase());
  } catch {
    return true;
  }
  return parts[0] === "memory" && parts[1] === "sync";
}

export async function proxy(c: Context, id: string): Promise<Response> {
  const peer = peers.get(id);
  if (!peer) return c.json({ error: "That device isn't paired anymore." }, 404);
  const token = peers.tokenFor(id);
  if (!peer.address || !token) return c.json({ error: `${peer.name} can't be reached from this device.` }, 502);

  const url = new URL(c.req.url);
  const rest = url.pathname.replace(/^\/api\/d\/[^/]+/, "");
  if (proxyRefuses(rest)) return c.json({ error: "Another device's memory syncs between the devices themselves; it can't be fetched through this one." }, 403);
  const target = `${peer.address}/api${rest}${url.search}`;
  const headers = new Headers();
  for (const [name, value] of c.req.raw.headers) if (!DROPPED_REQUEST.has(name.toLowerCase())) headers.set(name, value);
  headers.set("authorization", `Bearer ${token}`);

  // Not tied to the request's own signal: Node ends that once the request body is read, which would cut
  // streams short. A browser that leaves cancels the response body, and that closes the upstream call.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANSWER_TIMEOUT_MS);
  const method = c.req.method;
  let res: Response;
  try {
    res = await fetch(target, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : c.req.raw.body,
      redirect: "manual",
      signal: controller.signal,
      // Required by Node to send a streamed request body.
      duplex: "half",
    } as RequestInit);
  } catch {
    return c.json({ error: `${peer.name} is offline. Its chats are safe on it.` }, 502);
  } finally {
    clearTimeout(timer);
  }

  // Its refusal must not look like this browser's sign-in expiring (the app would go to the login page).
  if (res.status === 401) {
    await res.body?.cancel();
    return c.json({ error: `${peer.name} doesn't accept this device anymore. Unpair it in Settings → Devices, then pair them again.` }, 502);
  }
  const out = new Headers();
  for (const [name, value] of res.headers) if (!DROPPED_RESPONSE.has(name.toLowerCase())) out.set(name, value);
  return new Response(res.body, { status: res.status, headers: out });
}
