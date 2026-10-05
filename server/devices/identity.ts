import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import type { Device } from "../../shared/types.ts";
import { HOST, IS_PROD, LAN, PORT } from "../config.ts";
import { db, parseJson, type Row } from "../db.ts";
import { isLoopbackBind } from "../net.ts";

/**
 * This device: the computer running this TOT (roadmap module 07). Its id is made once and never
 * changes, so other devices can recognise it; its name is the computer's own unless the user renames it.
 */

const MAX_NAME = 40;

interface Stored {
  id?: string;
  /** Set only when the user renamed it. */
  name?: string;
}

function read(): Stored {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'device'`).get() as Row | undefined;
  return parseJson<Stored>(row?.value, {});
}

function write(value: Stored) {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('device', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    JSON.stringify(value),
  );
}

let computerName: string | undefined;

/** "Mac mini" (the name in System Settings → General → Sharing), else the host name. */
function ownName(): string {
  if (computerName === undefined) {
    try {
      computerName = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim();
    } catch {
      computerName = "";
    }
    computerName ||= hostname().replace(/\.local$/i, "") || "This computer";
  }
  return computerName;
}

export function deviceId(): string {
  const stored = read();
  if (stored.id) return stored.id;
  const id = randomUUID();
  write({ ...stored, id });
  return id;
}

export function deviceName(): string {
  return read().name || ownName();
}

/** An empty name goes back to the computer's own name. */
export function renameDevice(name: string) {
  const clean = name.replace(/\s+/g, " ").trim();
  if (clean.length > MAX_NAME) throw new Error(`Keep the name under ${MAX_NAME} characters.`);
  write({ ...read(), id: deviceId(), name: clean || undefined });
}

// ---------------------------------------------------------------------------
// Where other computers reach it
// ---------------------------------------------------------------------------

/** Whether TOT accepts other machines at all: the dev web server on the network, or the production server not on loopback. */
export function reachable(): boolean {
  return IS_PROD ? !isLoopbackBind(HOST) : LAN;
}

/** The port another machine opens: the web server's (Vite in development), not the API's. */
function webPort(): number {
  return IS_PROD ? PORT : Number(process.env.TOT_WEB_PORT ?? 5173);
}

const isTailscale = (ip: string) => {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127; // 100.64.0.0/10
};
const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

/** Addresses another computer could use, Tailscale first (it works from anywhere and is encrypted), then the home network. */
export function addresses(): { url: string; network: "tailscale" | "lan" }[] {
  if (!reachable()) return [];
  const port = webPort();
  // A production server bound to one address is only reachable there.
  const bound = IS_PROD && HOST !== "0.0.0.0" ? HOST : null;
  const found: { url: string; network: "tailscale" | "lan" }[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family !== "IPv4" || entry.internal || (bound && entry.address !== bound)) continue;
      const network = isTailscale(entry.address) ? "tailscale" : isPrivate(entry.address) ? "lan" : null;
      if (network) found.push({ url: `http://${entry.address}:${port}`, network });
    }
  }
  return found.sort((a, b) => Number(b.network === "tailscale") - Number(a.network === "tailscale"));
}

export function selfDevice(): Device {
  const best = addresses()[0];
  return {
    id: deviceId(),
    name: deviceName(),
    address: best?.url ?? null,
    network: best?.network ?? null,
    self: true,
    online: true,
    lastSeenAt: Date.now(),
    pairedAt: null,
  };
}
