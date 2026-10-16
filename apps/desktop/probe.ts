import { request } from "node:http";

/**
 * Asking a port about TOT (roadmap module 08). Before starting its own server, the Mac app asks TOT's port for
 * /.well-known/tot: a TOT already there (`npm run dev`, `npm start`, another copy of the app) is opened instead
 * of starting a second one, and anything else on the port is an error to show rather than a fight over the
 * port. The menu bar's status line comes from the same server's /api/devices.
 */

export type Probe = { kind: "tot"; id: string; name: string } | { kind: "free" } | { kind: "other"; detail: string };

/** TOT answers /.well-known/tot with its device id, name and protocol version (apps/server/devices/routes.ts). */
export function classifyAnswer(status: number, body: string): Probe {
  if (status !== 200) return { kind: "other", detail: `It answered ${status}.` };
  try {
    const info = JSON.parse(body) as { id?: unknown; name?: unknown; protocol?: unknown };
    if (typeof info.id === "string" && info.id && typeof info.name === "string" && typeof info.protocol === "number") {
      return { kind: "tot", id: info.id, name: info.name };
    }
  } catch {
    // Not JSON: a web page, another app's API.
  }
  return { kind: "other", detail: "It isn't TOT." };
}

/** A request that failed: nothing listening means the port is free; a timeout or a garbled reply is something else. */
export function classifyError(error: unknown): Probe {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ECONNREFUSED") return { kind: "free" };
  return { kind: "other", detail: code === "ETIMEDOUT" ? "It didn't answer." : "It answered, but not over HTTP." };
}

/**
 * A GET on this computer, over a connection of its own: a kept-alive one to a server that has since gone
 * would fail like a broken server, not like a free port.
 */
function get(port: number, path: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, agent: false, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy(new Error("Too long an answer."));
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("No answer."), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  });
}

export async function probeTot(port: number, timeoutMs = 1500): Promise<Probe> {
  try {
    const { status, body } = await get(port, "/.well-known/tot", timeoutMs);
    return classifyAnswer(status, body);
  } catch (err) {
    return classifyError(err);
  }
}

/** What the app does about the port: open the TOT that's there, start its own, or say the port is taken. */
export function planLaunch(probe: Probe): "attach" | "start" | "blocked" {
  return probe.kind === "tot" ? "attach" : probe.kind === "free" ? "start" : "blocked";
}

/** The menu bar's status line, from GET /api/devices → access.mode. */
export function accessLabel(mode: string | null | undefined): string {
  switch (mode) {
    case "off":
      return "Remote access: off";
    case "lan":
      return "Remote access: on · this Wi‑Fi";
    case "tailscale":
      return "Remote access: on · Tailscale";
    default:
      return "Remote access: unknown";
  }
}

/** Remote access as the server reports it, or null if it can't be asked. This computer never signs in. */
export async function accessMode(port: number, timeoutMs = 800): Promise<string | null> {
  try {
    const { status, body } = await get(port, "/api/devices", timeoutMs);
    if (status !== 200) return null;
    return (JSON.parse(body) as { access?: { mode?: string } }).access?.mode ?? null;
  } catch {
    return null;
  }
}
