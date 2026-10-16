/**
 * Which paired device things live on (roadmap module 07), so every call about them goes there.
 *
 * Everything another device sends (agents, chats, runs, projects, messages) is "owned" by it: the ids
 * in it are remembered, and any later API call naming one of those ids goes to /api/d/<device>/…,
 * which this device forwards. Ids are random UUIDs, so one never belongs to two devices. Calls that
 * name no id (list another device's agents, make an agent there, upload a file to its chat) say which
 * device with `onDevice`.
 */

const owners = new Map<string, string>();
let pinned: string | null = null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Keys whose values are ids worth remembering: `id`, `agentId`, `runId`, `activeRunId`… */
const ID_KEY = /^(id|.+Id)$/;
/** Keys whose values are URLs the browser fetches from the device: `url`, `screenshotUrl`… */
const URL_KEY = /^(url|.+Url)$/;

/** The paired device an id belongs to; null for this device's own things. */
export function deviceOf(id: string | null | undefined): string | null {
  return id ? (owners.get(id) ?? null) : null;
}

/**
 * Takes in something another device sent: remembers its ids as that device's, and points its own
 * URLs (`/api/uploads/…`, screenshots) at it through this device. Returns the same object, updated.
 */
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

/** A device was unpaired: its ids are forgotten. */
export function forgetDevice(deviceId: string) {
  for (const [id, owner] of owners) if (owner === deviceId) owners.delete(id);
}

/** Runs `call` with its API requests sent to `deviceId` (or this device when null). */
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

/** The URL for an API path on a device: "/api/…" here, "/api/d/<id>/…" on a paired one. */
export function apiUrl(path: string, deviceId: string | null): string {
  return deviceId ? `/api/d/${encodeURIComponent(deviceId)}${path}` : `/api${path}`;
}
