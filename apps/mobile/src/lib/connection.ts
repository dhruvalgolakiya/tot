import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import type { AppSignInResponse } from "@shared/types";
import { dropSnapshot } from "./cache";

/**
 * The TOTs this app is signed in to (roadmap module 14): each one's address, name and session token from /login,
 * kept in the Keychain, and which one is open now. Nothing else about TOT is stored here (the last loaded lists
 * are a cache, lib/cache.ts). Usually one TOT is enough (it shows its paired devices' agents too); a second one
 * (a work Mac on another network, say) is added from Settings → TOT servers.
 */

export interface SavedServer {
  /** Random, for the Keychain key of its token. */
  id: string;
  /** "http://100.101.4.2:5173", no trailing slash. */
  url: string;
  /** The TOT's own name, e.g. "Mac mini", once known. */
  deviceName: string | null;
  /** Signed in with a token (false for a TOT that doesn't ask for sign-in). Kept here so the list shows it without reading every token. */
  signedIn: boolean;
}

interface Connection {
  /** Loaded from the Keychain; until then nothing renders. */
  loaded: boolean;
  /** Every saved TOT, in the order they were added. */
  servers: SavedServer[];
  /** The open TOT's id; null shows Connect. */
  serverId: string | null;
  /** The open TOT's address. Null until connected. */
  url: string | null;
  /** "tots_…" from /login; null for a TOT that doesn't ask for sign-in (this Mac's simulator, remote access off). */
  token: string | null;
  deviceName: string | null;
  /** Connect is open to add another TOT (Settings → TOT servers), so it shows even while one is open. */
  adding: boolean;
}

export const useConnection = create<Connection>()(() => ({ loaded: false, servers: [], serverId: null, url: null, token: null, deviceName: null, adding: false }));
const set = useConnection.setState;
const get = useConnection.getState;

const KEYS = { servers: "tot.servers", active: "tot.active" } as const;
const tokenKey = (id: string) => `tot.server.${id}.token`;
/** M1–M4 kept a single TOT under these; moved into the list the first time M5 opens. */
const OLD = { url: "tot.url", token: "tot.token", deviceName: "tot.deviceName" } as const;
const LAST_URL = "tot.lastUrl";

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export async function loadConnection() {
  let servers = parseServers(await SecureStore.getItemAsync(KEYS.servers));
  let active = await SecureStore.getItemAsync(KEYS.active);
  if (!servers.length) {
    const [url, token, deviceName] = await Promise.all([SecureStore.getItemAsync(OLD.url), SecureStore.getItemAsync(OLD.token), SecureStore.getItemAsync(OLD.deviceName)]);
    if (url) {
      const id = newId();
      servers = [{ id, url, deviceName, signedIn: Boolean(token) }];
      active = id;
      if (token) await SecureStore.setItemAsync(tokenKey(id), token);
      await persist(servers, active);
    }
    for (const key of Object.values(OLD)) await SecureStore.deleteItemAsync(key);
  }
  const server = servers.find((s) => s.id === active) ?? null;
  const token = server?.signedIn ? await SecureStore.getItemAsync(tokenKey(server.id)) : null;
  set({ loaded: true, servers, ...opened(server, token) });
}

function parseServers(json: string | null): SavedServer[] {
  try {
    const list = json ? (JSON.parse(json) as SavedServer[]) : [];
    return Array.isArray(list) ? list.filter((s) => s && typeof s.id === "string" && typeof s.url === "string") : [];
  } catch {
    return [];
  }
}

const opened = (server: SavedServer | null, token: string | null) => ({
  serverId: server?.id ?? null,
  url: server?.url ?? null,
  token: server ? token : null,
  deviceName: server?.deviceName ?? null,
});

async function persist(servers: SavedServer[], active: string | null) {
  await SecureStore.setItemAsync(KEYS.servers, JSON.stringify(servers));
  if (active) await SecureStore.setItemAsync(KEYS.active, active);
  else await SecureStore.deleteItemAsync(KEYS.active);
}

/** Saves a TOT just connected to (a new one, or the same address again with a new token) and opens it. */
async function keep(url: string, token: string | null, deviceName: string | null) {
  const servers = get().servers.slice();
  const index = servers.findIndex((s) => s.url === url);
  const server: SavedServer = { id: index === -1 ? newId() : servers[index]!.id, url, deviceName: deviceName ?? servers[index]?.deviceName ?? null, signedIn: Boolean(token) };
  if (index === -1) servers.push(server);
  else servers[index] = server;
  if (token) await SecureStore.setItemAsync(tokenKey(server.id), token);
  else await SecureStore.deleteItemAsync(tokenKey(server.id));
  await persist(servers, server.id);
  // Remembered after signing out, to fill in the Connect screen next time.
  await SecureStore.setItemAsync(LAST_URL, url);
  set({ servers, adding: false, ...opened(server, token) });
}

/** What people type: "mac-mini.tail1234.ts.net:5173", "192.168.1.21:5173/", a full sign-in link. */
export function normalizeAddress(input: string): string | null {
  let text = input.trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  try {
    const url = new URL(text);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/** A sign-in link from Settings → Devices → Add a phone: "<address>/login#code=…". */
export function parseSignInLink(text: string): { url: string; code: string } | null {
  const match = /^(https?:\/\/[^/\s]+)\/login#code=([\w-]{16,})$/.exec(text.trim());
  return match ? { url: match[1], code: match[2] } : null;
}

const UNREACHABLE = "Can't reach TOT there. Check the address, and that this phone is on the same Wi‑Fi or Tailscale.";

async function call(url: string, path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(`${url}${path}`, { ...init, signal: controller.signal });
  } catch {
    throw new Error(UNREACHABLE);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a TOT at `url` lets this phone in without signing in. True only for a TOT with sign-in off, which
 * answers nothing but its own computer: the simulator on that Mac.
 */
export async function probe(address: string): Promise<"open" | "sign-in"> {
  const url = normalizeAddress(address);
  if (!url) throw new Error("That doesn't look like an address.");
  const res = await call(url, "/api/health");
  if (res.ok) return "open";
  if (res.status === 401) return "sign-in";
  throw new Error(res.status === 403 ? "That TOT only answers its own computer. On it, turn on remote access in Settings → Devices." : UNREACHABLE);
}

/** Connects without signing in (see probe). */
export async function connectOpen(address: string) {
  await keep(normalizeAddress(address)!, null, null);
}

/** Signs in with a one-time code from the QR code, or the password; keeps the token. */
export async function signIn(address: string, credential: { code: string } | { password: string }) {
  const url = normalizeAddress(address);
  if (!url) throw new Error("That doesn't look like an address.");
  const res = await call(url, "/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client: "mobile", deviceName: Device.deviceName ?? Device.modelName ?? "iPhone", ...credential }),
  });
  const data = (await res.json().catch(() => null)) as (AppSignInResponse & { error?: string }) | null;
  if (!res.ok || !data?.token) {
    throw new Error(data?.error ?? (res.status === 404 ? "That isn't a TOT, or it's too old for this app." : `Sign-in failed (${res.status}).`));
  }
  await keep(url, data.token, data.deviceName);
}

/** Opens another saved TOT; the screens reload from its cache, then from it. */
export async function switchServer(id: string) {
  const server = get().servers.find((s) => s.id === id);
  if (!server || server.id === get().serverId) return;
  const token = server.signedIn ? await SecureStore.getItemAsync(tokenKey(server.id)) : null;
  await SecureStore.setItemAsync(KEYS.active, server.id);
  set({ adding: false, ...opened(server, token) });
}

/**
 * Forgets a saved TOT; with a token, also ends its session there (best effort: it may be unreachable). Removing
 * the open one opens the next saved one, or Connect when it was the last.
 */
export async function removeServer(id: string, { signOutThere = true } = {}) {
  const server = get().servers.find((s) => s.id === id);
  if (!server) return;
  if (signOutThere && server.signedIn) {
    const token = await SecureStore.getItemAsync(tokenKey(id));
    if (token) await call(server.url, "/logout", { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => {});
  }
  await SecureStore.deleteItemAsync(tokenKey(id));
  await dropSnapshot(server.url);
  const servers = get().servers.filter((s) => s.id !== id);
  if (get().serverId !== id) {
    await persist(servers, get().serverId);
    set({ servers });
    return;
  }
  const next = servers[0] ?? null;
  const token = next?.signedIn ? await SecureStore.getItemAsync(tokenKey(next.id)) : null;
  await persist(servers, next?.id ?? null);
  set({ servers, ...opened(next, token) });
}

/** Signs out of the open TOT (Settings → Sign out). */
export async function signOut() {
  const { serverId } = get();
  if (serverId) await removeServer(serverId);
}

/**
 * The server refused the token (signed out in Settings → Devices, or the password changed): that TOT is forgotten
 * and the app goes back to Connect, address kept, even when others are saved: the user should see why.
 * `url` is the TOT that refused, so a late answer from a TOT switched away from doesn't drop the new one.
 */
export async function tokenRefused(url: string | null = get().url) {
  const server = get().servers.find((s) => s.url === url);
  if (!server || !server.signedIn) return;
  await SecureStore.deleteItemAsync(tokenKey(server.id));
  await SecureStore.setItemAsync(LAST_URL, server.url);
  // What it showed isn't this phone's to keep once that TOT has signed it out.
  await dropSnapshot(server.url);
  const servers = get().servers.filter((s) => s.id !== server.id);
  const open = get().serverId === server.id;
  await persist(servers, open ? null : get().serverId);
  set(open ? { servers, ...opened(null, null) } : { servers });
}

/** The address kept after a sign-out, to fill in the Connect screen. */
export async function lastAddress(): Promise<string | null> {
  return SecureStore.getItemAsync(LAST_URL);
}

export function setDeviceName(deviceName: string) {
  const { serverId, servers } = get();
  if (!serverId || get().deviceName === deviceName) return;
  const next = servers.map((s) => (s.id === serverId ? { ...s, deviceName } : s));
  set({ deviceName, servers: next });
  void SecureStore.setItemAsync(KEYS.servers, JSON.stringify(next));
}

/** Settings → TOT servers → Add another: Connect opens over the current TOT, which stays open until it succeeds. */
export function startAdding() {
  set({ adding: true });
}

export function stopAdding() {
  set({ adding: false });
}

/** "Mac mini", or the address without its scheme. */
export const serverLabel = (server: Pick<SavedServer, "deviceName" | "url">) => server.deviceName ?? server.url.replace(/^https?:\/\//, "");
