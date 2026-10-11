import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import type { AppSignInResponse } from "@shared/types";

/**
 * The one TOT this app is signed in to (roadmap module 14): its address and the session token from /login,
 * kept in the Keychain. Nothing else about TOT is stored on the phone.
 */

interface Connection {
  /** Loaded from the Keychain; until then nothing renders. */
  loaded: boolean;
  /** "http://100.101.4.2:5173", no trailing slash. Null until connected. */
  url: string | null;
  /** "tots_…" from /login; null for a TOT that doesn't ask for sign-in (this Mac's simulator, remote access off). */
  token: string | null;
  /** The TOT's own name, e.g. "Mac mini", once known. */
  deviceName: string | null;
}

export const useConnection = create<Connection>()(() => ({ loaded: false, url: null, token: null, deviceName: null }));

const KEYS = { url: "tot.url", token: "tot.token", deviceName: "tot.deviceName" } as const;

export async function loadConnection() {
  const [url, token, deviceName] = await Promise.all([
    SecureStore.getItemAsync(KEYS.url),
    SecureStore.getItemAsync(KEYS.token),
    SecureStore.getItemAsync(KEYS.deviceName),
  ]);
  useConnection.setState({ loaded: true, url, token, deviceName });
}

async function save(next: Omit<Connection, "loaded">) {
  useConnection.setState(next);
  for (const key of Object.keys(KEYS) as (keyof typeof KEYS)[]) {
    const value = next[key];
    if (value) await SecureStore.setItemAsync(KEYS[key], value);
    else await SecureStore.deleteItemAsync(KEYS[key]);
  }
  // Remembered after signing out, to fill in the Connect screen next time.
  if (next.url) await SecureStore.setItemAsync(LAST_URL, next.url);
}

const LAST_URL = "tot.lastUrl";

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
  const url = normalizeAddress(address)!;
  await save({ url, token: null, deviceName: null });
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
  await save({ url, token: data.token, deviceName: data.deviceName });
}

/** Forgets the TOT here; with a token, also ends the session there (best effort: it may be unreachable). */
export async function signOut() {
  const { url, token } = useConnection.getState();
  if (url && token) {
    await call(url, "/logout", { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => {});
  }
  await save({ url: null, token: null, deviceName: null });
}

/** The server refused the token (signed out in Settings → Devices, or the password changed): back to Connect. */
export async function tokenRefused() {
  if (useConnection.getState().url) await save({ url: null, token: null, deviceName: null });
}

/** The address kept after a sign-out, to fill in the Connect screen. */
export async function lastAddress(): Promise<string | null> {
  return SecureStore.getItemAsync(LAST_URL);
}

export function setDeviceName(deviceName: string) {
  if (useConnection.getState().deviceName === deviceName) return;
  useConnection.setState({ deviceName });
  void SecureStore.setItemAsync(KEYS.deviceName, deviceName);
}
