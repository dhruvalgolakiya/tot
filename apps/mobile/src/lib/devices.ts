/**
 * Which paired device things live on (roadmap module 07), ported from apps/web/src/lib/devices.ts.
 *
 * Everything another device sends (agents, chats, runs, messages) is "owned" by it: its ids are remembered,
 * and any later API call naming one of them goes to /api/d/<device>/…, which the signed-in TOT forwards.
 * Calls that name no id (list another device's agents) say which device with `onDevice`.
 */

const owners = new Map<string, string>();
let pinned: string | null = null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_KEY = /^(id|.+Id)$/;
const URL_KEY = /^(url|.+Url)$/;

/** The paired device an id belongs to; null for the signed-in TOT's own things. */
export function deviceOf(id: string | null | undefined): string | null {
  return id ? (owners.get(id) ?? null) : null;
}

/** Takes in something another device sent: its ids become that device's, its /api/ URLs go through this TOT. */
export function adopt<T>(deviceId: string, value: T): T {
  walk(deviceId, value, 0);
  return value;
}

function walk(deviceId: string, value: unknown, depth: number) {
  if (!value || typeof value !== "object" || depth > 12) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(deviceId, item, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") {
      if (ID_KEY.test(key) && UUID.test(item)) owners.set(item, deviceId);
      else if (URL_KEY.test(key) && item.startsWith("/api/") && !item.startsWith("/api/d/")) record[key] = `/api/d/${deviceId}${item.slice(4)}`;
    } else {
      walk(deviceId, item, depth + 1);
    }
  }
}

export function forgetDevices() {
  owners.clear();
}

/** Runs `call` with its API requests sent to `deviceId` (or this TOT when null). */
export function onDevice<T>(deviceId: string | null | undefined, call: () => T): T {
  const before = pinned;
  pinned = deviceId ?? null;
  try {
    return call();
  } finally {
    pinned = before;
  }
}

/** Where an API call goes: the pinned device, else the device owning an id in its path or body, else here. */
export function deviceFor(path: string, body?: unknown): string | null {
  if (pinned) return pinned;
  for (const part of path.split(/[/?&=]/)) {
    const owner = part && owners.get(decodeURIComponent(part));
    if (owner) return owner;
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    for (const [key, item] of Object.entries(body)) {
      const owner = ID_KEY.test(key) && typeof item === "string" ? owners.get(item) : undefined;
      if (owner) return owner;
    }
  }
  return null;
}

/** The API path on a device: "/api/…" here, "/api/d/<id>/…" on a paired one. */
export function apiPath(path: string, deviceId: string | null): string {
  return deviceId ? `/api/d/${encodeURIComponent(deviceId)}${path}` : `/api${path}`;
}

/** Every remembered id and its device, for the offline cache (lib/cache.ts). */
export function ownedIds(): [string, string][] {
  return [...owners];
}

/** Puts back the cache's ids, so rows shown from it still send their calls to their device. */
export function restoreOwners(entries: [string, string][]) {
  for (const [id, deviceId] of entries) if (!owners.has(id)) owners.set(id, deviceId);
}
