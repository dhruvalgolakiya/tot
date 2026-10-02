import { networkInterfaces } from "node:os";

/** Host-header and address helpers for deciding who is local. */

/** "[::1]:5173" → "::1", "LocalHost:8787" → "localhost". */
export function hostnameOf(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) return value.slice(1, value.indexOf("]"));
  return value.split(":")[0];
}

export function isLoopbackName(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/** Whether a listen address ("127.0.0.1", "::1", "0.0.0.0"…) keeps the server on this machine. */
export function isLoopbackBind(address: string): boolean {
  return isLoopbackName(address.trim().toLowerCase().replace(/^\[|\]$/g, ""));
}

function ownAddresses(): Set<string> {
  const addresses = new Set<string>();
  for (const list of Object.values(networkInterfaces())) for (const entry of list ?? []) addresses.add(entry.address);
  return addresses;
}

/** Whether a connection's remote address is this machine (loopback or one of its own interfaces). */
export function isThisMachine(address: string | undefined): boolean {
  if (!address) return false;
  const plain = address.replace(/^::ffff:/, ""); // IPv4-mapped IPv6
  return isLoopbackName(plain) || ownAddresses().has(plain);
}

/**
 * The address of the device a request came from. Behind the dev web server (a proxy on
 * loopback), that's the last X-Forwarded-For entry, which the proxy itself appended. A
 * tunnel (e.g. ngrok) also connects from loopback but adds the visitor's address first,
 * so any entry that isn't this machine wins: forwarded values can make a request look
 * remote, never local.
 */
export function clientAddress(peer: string | undefined, forwardedFor: string | undefined): string | undefined {
  if (!peer || !isThisMachine(peer) || !forwardedFor) return peer;
  const hops = forwardedFor.split(",").map((hop) => hop.trim()).filter(Boolean);
  return hops.find((hop) => !isThisMachine(hop)) ?? hops.at(-1) ?? peer;
}

/** http://<address>:<port> for each LAN IPv4 interface, plus the Bonjour name when there is one. */
export function lanUrls(port: number, bonjourName?: string): string[] {
  const urls: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) {
        urls.push(`http://${entry.address}:${port}`);
      }
    }
  }
  if (bonjourName?.endsWith(".local")) urls.push(`http://${bonjourName}:${port}`);
  return urls;
}
