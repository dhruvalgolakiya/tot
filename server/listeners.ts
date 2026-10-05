import { createAdaptorServer, type ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import type { RemoteAccessMode } from "../shared/types.ts";
import { effectiveMode, onAccessChange, signInReady } from "./access.ts";
import { ENV_REMOTE, RAW_HOST_EXPOSED, WEB_PORT } from "./config.ts";
import { isTailscaleAddress } from "./net.ts";

/**
 * Remote access on the network (roadmap module 07). TOT's main listener stays on loopback; while remote
 * access is on, this opens one more listener per address other devices use: the Tailscale address, or the
 * home network's. Each binds one specific address on the web port (5173 in development, where the API
 * serves the app through dev-web.ts; the API port in production), so the same address keeps working.
 * Never 0.0.0.0, a public address or IPv6. Checked again every 30 s, as Wi-Fi and Tailscale come and go.
 */

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

const RECHECK_MS = 30_000;
const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

/** The addresses to listen on. Legacy TOT_LAN=1 also served Tailscale, so it still does. */
export function wantedAddresses(mode: RemoteAccessMode, ready: boolean, interfaces: Interfaces, legacyLan = false): string[] {
  if (!ready || mode === "off") return [];
  const ipv4 = Object.values(interfaces)
    .flatMap((list) => list ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  const tailscale = ipv4.filter(isTailscaleAddress);
  const lan = ipv4.filter(isPrivate);
  if (mode === "tailscale") return tailscale.slice(0, 1);
  return legacyLan ? [...lan, ...tailscale] : lan;
}

const servers = new Map<string, ServerType>();
const failures = new Map<string, string>();
const subscribers = new Set<() => void>();
let app: Hono | null = null;
let port = WEB_PORT;
let wanted: (mode: RemoteAccessMode, ready: boolean) => string[] = (mode, ready) =>
  wantedAddresses(mode, ready, networkInterfaces(), ENV_REMOTE?.mode === "lan");
let timer: NodeJS.Timeout | null = null;
let retry: NodeJS.Timeout | null = null;
let queue: Promise<unknown> = Promise.resolve();
let unsubscribe: (() => void) | null = null;

function open(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createAdaptorServer({ fetch: app!.fetch });
    // Read the peer's address as each connection opens, so a request never finds it gone (auth.ts trusts it).
    server.on("connection", (socket) => void socket.remoteAddress);
    server.once("error", (err: NodeJS.ErrnoException) => {
      failures.set(address, err.code === "EADDRINUSE" ? `Port ${port} is busy on ${address}.` : `TOT couldn't listen on ${address}.`);
      resolve(false);
    });
    server.listen(port, address, () => {
      failures.delete(address);
      servers.set(address, server);
      server.on("error", () => {});
      resolve(true);
    });
  });
}

function close(server: ServerType): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  });
}

async function reconcile() {
  if (!app) return;
  const want = new Set(RAW_HOST_EXPOSED ? [] : wanted(effectiveMode(), signInReady()));
  let changed = false;
  for (const [address, server] of servers) {
    if (want.has(address)) continue;
    servers.delete(address);
    await close(server);
    changed = true;
  }
  for (const address of failures.keys()) if (!want.has(address)) failures.delete(address);
  for (const address of want) if (!servers.has(address) && (await open(address))) changed = true;
  // A port can still be held for a moment by the process a restart replaced: try once more shortly.
  if (failures.size && !retry) {
    retry = setTimeout(() => {
      retry = null;
      void listeners.reconcile();
    }, 2000);
    retry.unref();
  }
  if (changed) for (const run of subscribers) run();
}

export const listeners = {
  /** `options` are for tests: another port, and which addresses a mode wants (instead of this computer's own). */
  start(appInstance: Hono, options: { port?: number; wanted?: (mode: RemoteAccessMode, ready: boolean) => string[] } = {}) {
    app = appInstance;
    port = options.port ?? WEB_PORT;
    if (options.wanted) wanted = options.wanted;
    unsubscribe?.();
    // A moment later: turning remote access off from another device closes the listener its own answer goes out on.
    unsubscribe = onAccessChange(() => void setTimeout(() => void listeners.reconcile(), 250));
    if (timer) clearInterval(timer);
    timer = setInterval(() => void listeners.reconcile(), RECHECK_MS);
    timer.unref();
    return listeners.reconcile();
  },

  /** Opens and closes listeners to match the mode and the network, one pass at a time. */
  reconcile(): Promise<void> {
    const pass = queue.then(reconcile);
    queue = pass.catch(() => {});
    return pass;
  },

  bound(): { address: string; network: "tailscale" | "lan" }[] {
    return [...servers.keys()]
      .map((address) => ({ address, network: isTailscaleAddress(address) ? ("tailscale" as const) : ("lan" as const) }))
      .sort((a, b) => Number(b.network === "tailscale") - Number(a.network === "tailscale"));
  },

  /** Why remote access isn't working right now, in words for the Devices page. */
  problem(): string | null {
    const mode = effectiveMode();
    if (mode === "off" || RAW_HOST_EXPOSED) return null;
    if (!signInReady()) return `${ENV_REMOTE?.variable ?? "Remote access"} is on, but there's no password yet. Set one here.`;
    const failure = failures.values().next().value;
    if (failure) return failure;
    if (servers.size) return null;
    return mode === "tailscale"
      ? "Tailscale isn't running on this computer. Open Tailscale and sign in, then check again."
      : "This computer isn't on a network right now.";
  },

  onChange(run: () => void): () => void {
    subscribers.add(run);
    return () => subscribers.delete(run);
  },

  async stop() {
    if (timer) clearInterval(timer);
    if (retry) clearTimeout(retry);
    timer = retry = null;
    unsubscribe?.();
    unsubscribe = null;
    app = null;
    const open = [...servers.values()];
    servers.clear();
    failures.clear();
    await Promise.all(open.map(close));
  },
};
