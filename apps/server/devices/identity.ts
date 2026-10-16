import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import type { Device } from "@tot/shared/types";
import { HOST, IS_PROD, PORT, RAW_HOST_EXPOSED, WEB_PORT } from "../config.ts";
import { db, parseJson, type Row } from "../db.ts";
import { listeners } from "../listeners.ts";
import { isTailscaleAddress } from "../net.ts";

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

/** TOT_PUBLIC_URL: the address to give other devices when it can't be found out (a tunnel, a custom name). */
const publicUrl = () => process.env.TOT_PUBLIC_URL?.trim().replace(/\/+$/, "") || null;

/** Whether other devices can reach TOT at all: remote access is listening, TOT_HOST put it on the network, or TOT_PUBLIC_URL names it. */
export function reachable(): boolean {
  return Boolean(publicUrl()) || listeners.bound().length > 0 || (IS_PROD && RAW_HOST_EXPOSED);
}

/** The port another machine opens: the web server's (Vite in development), not the API's. */
export function webPort(): number {
  return WEB_PORT;
}

const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

/** What an address goes over, from its host: Tailscale, the home network, or something else (a tunnel). */
export function networkOf(address: string): "tailscale" | "lan" | null {
  try {
    const host = new URL(address).hostname;
    if (isTailscaleAddress(host) || host.endsWith(".ts.net")) return "tailscale";
    if (isPrivate(host) || host.endsWith(".local")) return "lan";
  } catch {
    // not a URL
  }
  return null;
}

/** Addresses another computer could use, Tailscale first (it works from anywhere and is encrypted), then the home network. */
export function addresses(): { url: string; network: "tailscale" | "lan" | null }[] {
  const found: { url: string; network: "tailscale" | "lan" | null }[] = [];
  const pinned = publicUrl();
  if (pinned) found.push({ url: pinned, network: networkOf(pinned) });
  for (const { address, network } of listeners.bound()) found.push({ url: `http://${address}:${WEB_PORT}`, network });
  // TOT_HOST put the server itself on the network (advanced): one address, or every interface for 0.0.0.0.
  if (IS_PROD && RAW_HOST_EXPOSED) {
    for (const list of Object.values(networkInterfaces())) {
      for (const entry of list ?? []) {
        if (entry.family !== "IPv4" || entry.internal || (HOST !== "0.0.0.0" && entry.address !== HOST)) continue;
        const network = isTailscaleAddress(entry.address) ? "tailscale" : isPrivate(entry.address) ? "lan" : null;
        if (network) found.push({ url: `http://${entry.address}:${PORT}`, network });
      }
    }
  }
  return found.sort((a, b) => Number(b.network === "tailscale") - Number(a.network === "tailscale") || Number(b.url === pinned) - Number(a.url === pinned));
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
    canReachUs: true,
    lastSeenAt: Date.now(),
    pairedAt: null,
    problem: null,
    warnings: [],
  };
}
