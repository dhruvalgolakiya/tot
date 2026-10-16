import type { AppEvent, Device } from "../../shared/types.ts";
import { appEvents } from "../app-events.ts";
import { networkOf } from "./identity.ts";
import { peers, type Peer } from "./peers.ts";

/**
 * Keeps one event stream open to each paired device (roadmap module 07). While it's up the device is
 * online; its events reach this device's screens wrapped as `remote` events, tagged with the device.
 * A device that drops is retried with backoff, up to every 30 s; one that refuses our token is retried
 * rarely, so a stale pairing doesn't count against sign-in's wrong-guess limit.
 */

/** What another device's screens need to show its agents live. Settings, logins and mail stay on the device. */
const FORWARDED = new Set<AppEvent["type"]>([
  "conversation",
  "conversation-deleted",
  "run",
  "computer",
  "agent",
  "agent-deleted",
  "wiki",
  "brains",
  "approval",
  "task",
  "project",
]);

const MAX_RETRY_MS = 30_000;
/** The other side pings every 15 s, so this long without a byte means the connection is dead (e.g. it slept). */
const QUIET_LIMIT_MS = 45_000;
const REJECTED_RETRY_MS = 10 * 60_000;

interface Link {
  controller: AbortController | null;
  timer: NodeJS.Timeout | null;
  online: boolean;
  problem: string | null;
  retryMs: number;
  stopped: boolean;
  /** A connection attempt (or the open stream) is in progress. */
  busy: boolean;
}

const links = new Map<string, Link>();
/** Event streams each paired device has open to us: when it has one, it can reach this device. */
const inbound = new Map<string, number>();
/** Things to fix found when it connects, e.g. both answering the same Slack workspace (M4). */
const warnings = new Map<string, string[]>();
let infoCheck: ((peer: Peer) => Promise<string[]>) | null = null;
/** Memory repo (module 10): who hears every event a paired device sends, forwarded or not (memory sync). */
const listeners: ((deviceId: string, event: AppEvent) => void)[] = [];

function toDevice(peer: Peer): Device {
  const link = links.get(peer.id);
  return {
    id: peer.id,
    name: peer.name,
    address: peer.address || null,
    network: peer.address ? networkOf(peer.address) : null,
    self: false,
    online: link?.online ?? false,
    canReachUs: (inbound.get(peer.id) ?? 0) > 0,
    lastSeenAt: peer.lastSeenAt,
    pairedAt: peer.pairedAt,
    problem: peer.address ? (link?.problem ?? null) : `${peer.name} can't be reached from this device: it had no address when you paired.`,
    warnings: warnings.get(peer.id) ?? [],
  };
}

function announce(id: string) {
  const peer = peers.get(id);
  if (peer) appEvents.publish({ type: "device", device: toDevice(peer) });
}

function forward(id: string, event: AppEvent) {
  for (const listener of listeners) listener(id, event);
  if (event.type === "device") {
    // It renamed itself.
    if (event.device.self && event.device.name !== peers.get(id)?.name) {
      peers.update(id, { name: event.device.name });
      announce(id);
    }
    return;
  }
  if (FORWARDED.has(event.type)) appEvents.publish({ type: "remote", deviceId: id, event });
}

function handleBlock(id: string, link: Link, block: string) {
  let name = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (name === "ready") {
    link.online = true;
    link.problem = null;
    link.retryMs = 1000;
    peers.update(id, { lastSeenAt: Date.now() });
    announce(id);
    void checkInfo(id);
    return;
  }
  if (!data) return;
  try {
    forward(id, JSON.parse(data) as AppEvent);
  } catch {
    // not an event
  }
}

async function checkInfo(id: string) {
  const peer = peers.get(id);
  if (!peer || !infoCheck) return;
  const found = await infoCheck(peer).catch(() => []);
  if (JSON.stringify(found) === JSON.stringify(warnings.get(id) ?? [])) return;
  warnings.set(id, found);
  announce(id);
}

async function connect(id: string) {
  const link = links.get(id);
  const peer = peers.get(id);
  const token = peers.tokenFor(id);
  if (!link || link.stopped || link.busy || !peer || !token || !peer.address) return;
  link.busy = true;
  const controller = new AbortController();
  link.controller = controller;
  let quiet: NodeJS.Timeout | undefined;
  const heard = () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => controller.abort(), QUIET_LIMIT_MS);
  };
  try {
    heard();
    const res = await fetch(`${peer.address}/api/events`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      signal: controller.signal,
    });
    // Right after pairing the other side may not have saved us yet: that's not a refusal.
    if ((res.status === 401 || res.status === 403) && Date.now() - peer.pairedAt > 60_000) {
      link.problem = `${peer.name} doesn't accept this device anymore. Unpair it here, then pair them again.`;
      link.retryMs = REJECTED_RETRY_MS;
      announce(id);
    } else if (res.ok && res.body) {
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        heard();
        buffer += value.replace(/\r\n/g, "\n");
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          handleBlock(id, link, buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
      }
    }
  } catch {
    // unreachable, dropped or aborted: retried below
  } finally {
    clearTimeout(quiet);
    link.busy = false;
  }
  if (link.stopped) return;
  if (link.online) {
    link.online = false;
    peers.update(id, { lastSeenAt: Date.now() });
    announce(id);
  }
  link.timer = setTimeout(() => void connect(id), link.retryMs);
  if (link.retryMs < REJECTED_RETRY_MS) link.retryMs = Math.min(link.retryMs * 2, MAX_RETRY_MS);
}

export const relay = {
  startAll() {
    for (const peer of peers.list()) relay.start(peer.id);
  },

  /** Starts (or restarts, e.g. after its address changed) the stream to a paired device. */
  start(id: string) {
    relay.stop(id);
    links.set(id, { controller: null, timer: null, online: false, problem: null, retryMs: 1000, stopped: false, busy: false });
    void connect(id);
  },

  stop(id: string) {
    const link = links.get(id);
    if (!link) return;
    link.stopped = true;
    link.controller?.abort();
    if (link.timer) clearTimeout(link.timer);
    links.delete(id);
  },

  stopAll() {
    for (const id of [...links.keys()]) relay.stop(id);
  },

  /** Tries a dropped device again now instead of waiting out its backoff. */
  retry(id: string) {
    const link = links.get(id);
    if (!link || link.online || link.busy) return;
    if (link.timer) clearTimeout(link.timer);
    link.retryMs = 1000;
    link.problem = null;
    void connect(id);
  },

  online(id: string): boolean {
    return links.get(id)?.online ?? false;
  },

  devices(): Device[] {
    return peers.list().map(toDevice);
  },

  device(id: string): Device | null {
    const peer = peers.get(id);
    return peer ? toDevice(peer) : null;
  },

  /** A paired device opened an event stream to us. Returns the function to call when it closes. */
  connected(id: string): () => void {
    const before = inbound.get(id) ?? 0;
    inbound.set(id, before + 1);
    if (before === 0) announce(id);
    // It can reach us, so it's up: try reaching it now rather than waiting out a backoff.
    relay.retry(id);
    let left = false;
    return () => {
      if (left) return;
      left = true;
      const now = (inbound.get(id) ?? 1) - 1;
      if (now > 0) inbound.set(id, now);
      else inbound.delete(id);
      if (now === 0) announce(id);
    };
  },

  /** Memory repo (module 10): hears every event a paired device sends (its own memory changed, say). */
  onEvent(listener: (deviceId: string, event: AppEvent) => void) {
    listeners.push(listener);
  },

  /** How to find warnings about a device when it connects (set by M4's device-info check). */
  useInfoCheck(check: (peer: Peer) => Promise<string[]>) {
    infoCheck = check;
  },
};
