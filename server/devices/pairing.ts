import { randomInt } from "node:crypto";
import { appEvents } from "../app-events.ts";
import { addresses, deviceId, deviceName, reachable } from "./identity.ts";
import { newDeviceToken, peers } from "./peers.ts";
import { relay } from "./relay.ts";
import { closeStreams } from "./sessions.ts";

/**
 * Pairing two devices (roadmap module 07), mutual in one step:
 *
 * 1. Mac mini makes a link: its address plus a one-time code (`newPairingLink`).
 * 2. On the MacBook you paste it; the MacBook's server calls the Mac mini (`connect`) with the code,
 *    its id, name and addresses, and a fresh token the Mac mini will use to call it back.
 * 3. The Mac mini checks the code (`acceptPairing`), saves the MacBook, and answers with a token for it.
 *
 * Both now hold a token for the other. The code lives only in memory: it works once, for 5 minutes.
 */

const CODE_TTL_MS = 5 * 60_000;
/** No look-alikes (0/O, 1/I/L): the code may be typed. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 12;
const PROTOCOL = 1;
const CALL_TIMEOUT_MS = 5000;

export class PairingError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 429 | 502 = 400,
  ) {
    super(message);
  }
}

let liveCode: { code: string; expiresAt: number } | null = null;

const normalizeCode = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, "");

/** A new link replaces the previous one. */
export function newPairingLink(): { link: string; expiresAt: number } {
  const address = addresses()[0]?.url;
  if (!reachable() || !address) {
    throw new PairingError("Other computers can't reach this device yet. Paste the other device's link here instead, or make this one reachable (see below).");
  }
  const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  liveCode = { code, expiresAt: Date.now() + CODE_TTL_MS };
  const shown = code.match(/.{4}/g)!.join("-");
  return { link: `${address}/pair#${shown}`, expiresAt: liveCode.expiresAt };
}

// Wrong codes are counted globally, like wrong sign-in tokens.
let failures = { count: 0, resetAt: 0 };
function lockedOut(): boolean {
  if (Date.now() > failures.resetAt) failures = { count: 0, resetAt: Date.now() + 60_000 };
  return failures.count >= 10;
}

/** The pairing request one device sends another. */
export interface PairRequest {
  protocol: number;
  code: string;
  device: { id: string; name: string; addresses: string[] };
  /** The token the receiving device will use to call the sender. */
  token: string;
}

export interface PairResponse {
  device: { id: string; name: string };
  /** The token the sender will use to call us. */
  token: string;
  /** We could reach the sender at one of its addresses, so pairing works both ways. */
  canReachYou: boolean;
}

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
};

/** Origin only: "http://100.101.4.2:5173/pair#…" → "http://100.101.4.2:5173". */
const originOf = (value: string) => new URL(value).origin;

async function call(url: string, init: RequestInit = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
}

/** Which TOT answers at an address (its /.well-known/tot), or null when none does. */
export async function whoIsAt(address: string, timeoutMs = CALL_TIMEOUT_MS): Promise<{ id: string; name: string; protocol: number } | null> {
  try {
    const res = await call(`${address}/.well-known/tot`, {}, timeoutMs);
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: unknown; name?: unknown; protocol?: unknown };
    return typeof body.id === "string" && typeof body.name === "string"
      ? { id: body.id, name: body.name, protocol: Number(body.protocol) }
      : null;
  } catch {
    return null;
  }
}

const cleanName = (name: string) => name.replace(/\s+/g, " ").trim().slice(0, 40);

/** Mac mini's side: someone pasted our link on their device. Open route; only a live code gets in. */
export async function acceptPairing(input: Partial<PairRequest> | null): Promise<PairResponse> {
  if (lockedOut()) throw new PairingError("Too many wrong codes. Wait a minute and try again.", 429);
  if (input?.protocol !== PROTOCOL) throw new PairingError("These two devices run different versions of TOT. Update both, then pair again.");
  const live = liveCode && liveCode.expiresAt > Date.now() ? liveCode : null;
  if (!live || typeof input.code !== "string" || normalizeCode(input.code) !== live.code) {
    failures.count++;
    throw new PairingError("That link has expired or was already used. Make a new one on the other device.", 403);
  }
  const device = input.device;
  const name = typeof device?.name === "string" ? cleanName(device.name) : "";
  if (!device || typeof device.id !== "string" || !/^[\w-]{8,64}$/.test(device.id) || !name) throw new PairingError("Expected the device's id and name.");
  if (device.id === deviceId()) throw new PairingError("That's this device's own link.");
  if (typeof input.token !== "string" || !input.token.startsWith("totd_") || input.token.length < 40) throw new PairingError("Expected a device token.");
  liveCode = null;

  // Find an address of theirs we can reach, so pairing works both ways (Tailscale ones come first).
  const offered = (Array.isArray(device.addresses) ? device.addresses : [])
    .filter((a): a is string => typeof a === "string" && isHttpUrl(a))
    .slice(0, 6)
    .map(originOf);
  const answers = await Promise.all(offered.map((candidate) => whoIsAt(candidate, 3000)));
  const address = offered.find((_, i) => answers[i]?.id === device.id) ?? "";

  const token = newDeviceToken();
  peers.save({ id: device.id, name, address }, { inbound: token, outbound: input.token });
  relay.start(device.id);
  appEvents.publish({ type: "device", device: relay.device(device.id)! });
  return { device: { id: deviceId(), name: deviceName() }, token, canReachYou: Boolean(address) };
}

/** MacBook's side: the user pasted the Mac mini's link. */
export async function connect(link: string): Promise<{ deviceId: string; canReachYou: boolean }> {
  const trimmed = link.trim();
  const hashAt = trimmed.indexOf("#");
  if (!isHttpUrl(trimmed) || hashAt < 0) throw new PairingError("Paste the whole link from the other device, e.g. http://100.101.4.2:5173/pair#K7QM-4RXP-2HWD.");
  const address = originOf(trimmed);
  const code = trimmed.slice(hashAt + 1);

  const other = await whoIsAt(address);
  if (!other) {
    throw new PairingError(`Couldn't reach TOT at ${address}. Is it running there, and are both devices on the same network or on Tailscale?`, 502);
  }
  if (other.id === deviceId()) throw new PairingError("That's this device's own link. Paste it on your other device.");
  if (other.protocol !== PROTOCOL) throw new PairingError(`${other.name} runs a different version of TOT. Update both, then pair again.`);

  const token = newDeviceToken();
  const request: PairRequest = {
    protocol: PROTOCOL,
    code,
    device: { id: deviceId(), name: deviceName(), addresses: addresses().map((a) => a.url) },
    token,
  };
  let res: Response;
  try {
    res = await call(`${address}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) }, 15_000);
  } catch {
    throw new PairingError(`${other.name} stopped answering. Try again.`, 502);
  }
  const body = (await res.json().catch(() => null)) as (PairResponse & { error?: string }) | null;
  if (!res.ok || !body?.token || body.device?.id !== other.id) {
    throw new PairingError(body?.error ?? `${other.name} didn't accept the pairing (${res.status}).`, res.status === 429 ? 429 : 400);
  }
  peers.save({ id: other.id, name: cleanName(body.device.name) || other.name, address }, { inbound: token, outbound: body.token });
  relay.start(other.id);
  appEvents.publish({ type: "device", device: relay.device(other.id)! });
  return { deviceId: other.id, canReachYou: body.canReachYou };
}

/** Forgets a device here, and tells it to forget us (best effort: it may be offline). */
export async function unpair(id: string) {
  const peer = peers.get(id);
  if (!peer) throw new PairingError("That device isn't paired.", 404);
  const token = peers.tokenFor(id);
  relay.stop(id);
  if (peer.address && token) {
    await call(`${peer.address}/api/devices/unpaired`, { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => {});
  }
  forget(id);
}

/** A paired device told us it unpaired. */
export function forget(id: string) {
  relay.stop(id);
  peers.remove(id);
  closeStreams(`device:${id}`);
  appEvents.publish({ type: "device-deleted", deviceId: id });
}

/** Points a paired device at a new address, after checking the same device answers there. */
export async function changeAddress(id: string, address: string) {
  const peer = peers.get(id);
  if (!peer) throw new PairingError("That device isn't paired.", 404);
  if (!isHttpUrl(address.trim())) throw new PairingError("Expected an address like http://100.101.4.2:5173.");
  const origin = originOf(address.trim());
  const found = await whoIsAt(origin);
  if (!found) throw new PairingError(`Nothing answers at ${origin}. Is TOT running there?`, 502);
  if (found.id !== id) throw new PairingError(`That's ${found.name}, not ${peer.name}.`);
  peers.update(id, { address: origin });
  relay.start(id);
  appEvents.publish({ type: "device", device: relay.device(id)! });
}
