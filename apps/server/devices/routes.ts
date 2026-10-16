import { Hono, type Context } from "hono";
import type {
  ConnectDeviceRequest,
  DevicesStatus,
  RemoteAccess,
  RenameDeviceRequest,
  SetPasswordRequest,
  SignInLinkRequest,
  UpdateDeviceRequest,
  UpdateRemoteAccessRequest,
} from "@tot/shared/types";
import { AccessError, checkGuess, effectiveMode, newSignInCode, passwordSet, setBy, setMode, setPassword, signInReady } from "../access.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { appEvents } from "../app-events.ts";
import { ACCESS_TOKEN, callerOf, currentSessionId, onThisMachine } from "../auth.ts";
import { listeners } from "../listeners.ts";
import { tailscaleAddress } from "../net.ts";
import { addresses, deviceId, deviceName, reachable, renameDevice, selfDevice } from "./identity.ts";
import { deviceInfo } from "./info.ts";
import { acceptPairing, cancelPairingLink, changeAddress, connect, forget, newPairingLink, PairingError, unpair } from "./pairing.ts";
import { proxy } from "./proxy.ts";
import { relay } from "./relay.ts";
import { endOtherSessions, endSession, listSessions } from "./sessions.ts";

/** This device, the devices paired with it, and the browsers signed in to it (roadmap module 07). Mounted under /api. */
export const deviceRoutes = new Hono();

function accessStatus(c: Context): RemoteAccess {
  return {
    mode: effectiveMode(),
    setBy: setBy(),
    passwordSet: passwordSet(),
    envToken: Boolean(ACCESS_TOKEN),
    onThisMachine: onThisMachine(c),
    tailscaleAddress: tailscaleAddress(),
    addresses: addresses(),
    problem: listeners.problem(),
  };
}

function status(c: Context): DevicesStatus {
  return {
    self: selfDevice(),
    devices: relay.devices(),
    signIn: signInReady(),
    sessions: signInReady() ? listSessions(currentSessionId(c)) : [],
    access: accessStatus(c),
  };
}

/** AccessError → the same status and message over HTTP. */
async function guarded<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AccessError) throw new PairingError(err.message, err.status);
    throw err;
  }
}

async function json<T>(c: Context): Promise<T> {
  const value = (await c.req.json().catch(() => null)) as T | null;
  if (!value || typeof value !== "object") throw new HttpError(400, "Expected a JSON body.");
  return value;
}

deviceRoutes.get("/devices", (c) => c.json(status(c)));

deviceRoutes.patch("/devices/self", async (c) => {
  const input = await json<RenameDeviceRequest>(c);
  if (typeof input.name !== "string") throw new HttpError(400, "Expected { name }.");
  try {
    renameDevice(input.name);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  // Screens here, and paired devices (through their relay), pick up the new name.
  appEvents.publish({ type: "device", device: selfDevice() });
  return c.json(status(c));
});

deviceRoutes.post("/devices/pairing-link", (c) => c.json(newPairingLink()));

// ---------------------------------------------------------------------------
// Remote access: the switch, the password, and sign-in links for phones
// ---------------------------------------------------------------------------

deviceRoutes.patch("/access", async (c) => {
  const input = await json<UpdateRemoteAccessRequest>(c);
  if (input.mode !== "off" && input.mode !== "tailscale" && input.mode !== "lan") throw new HttpError(400, 'Expected { mode: "off" | "tailscale" | "lan" }.');
  await guarded(() => setMode(input.mode));
  if (input.mode === "off") cancelPairingLink();
  // Listeners follow by themselves (listeners.ts); turning on, wait for them so the answer has the address.
  if (input.mode !== "off") await listeners.reconcile();
  return c.json(status(c));
});

deviceRoutes.post("/access/password", async (c) => {
  const input = await json<SetPasswordRequest>(c);
  if (typeof input.password !== "string") throw new HttpError(400, "Expected { password }.");
  // This computer may set a new one without the old (that's how a forgotten password is reset); anyone else needs it.
  if (passwordSet() && !onThisMachine(c)) {
    const guess = await checkGuess(input.current);
    // 403, not 401: the app takes a 401 to mean its own sign-in ended.
    if (guess === "locked") throw new PairingError("Too many wrong tries. Wait a minute.", 429);
    if (guess === "wrong") throw new PairingError("Your current password didn't match.", 403);
  }
  await guarded(() => setPassword(input.password));
  endOtherSessions(currentSessionId(c));
  await listeners.reconcile();
  return c.json(status(c));
});

deviceRoutes.post("/access/sign-in-link", async (c) => {
  const input = (await c.req.json().catch(() => ({}))) as SignInLinkRequest;
  const offered = addresses();
  if (!reachable() || !offered.length) throw new PairingError("Turn on remote access first, so your phone can reach this computer.");
  const address = offered.find((a) => a.url === input.address)?.url ?? offered[0].url;
  const { code, expiresAt } = newSignInCode();
  return c.json({ url: `${address}/login#code=${code}`, expiresAt });
});

deviceRoutes.post("/access/check", async (c) => {
  await listeners.reconcile();
  return c.json(status(c));
});

deviceRoutes.post("/devices/connect", async (c) => {
  const input = await json<ConnectDeviceRequest>(c);
  if (typeof input.link !== "string") throw new HttpError(400, "Expected { link }.");
  const result = await connect(input.link);
  return c.json({ ...status(c), ...result });
});

deviceRoutes.patch("/devices/:id", async (c) => {
  const input = await json<UpdateDeviceRequest>(c);
  if (typeof input.address === "string") await changeAddress(c.req.param("id"), input.address);
  else relay.retry(c.req.param("id"));
  return c.json(status(c));
});

deviceRoutes.delete("/devices/:id", async (c) => {
  await unpair(c.req.param("id"));
  return c.json(status(c));
});

/** A paired device unpaired us: the only device-management call a paired device may make. */
deviceRoutes.post("/devices/unpaired", (c) => {
  const caller = callerOf(c);
  if (caller.kind !== "device") throw new HttpError(403, "Only a paired device can say it unpaired.");
  forget(caller.id);
  return c.json({ ok: true });
});

deviceRoutes.all("/d/:deviceId/*", (c) => proxy(c, c.req.param("deviceId")));

/** Which Slack bot and mailboxes run here, so a paired device can warn when both run the same one. */
deviceRoutes.get("/device-info", (c) => c.json(deviceInfo()));

deviceRoutes.get("/sessions/current", (c) => c.json({ id: currentSessionId(c) }));

deviceRoutes.delete("/sessions/:id", (c) => {
  endSession(c.req.param("id"));
  return c.json(status(c));
});

deviceRoutes.post("/sessions/sign-out-others", (c) => {
  endOtherSessions(currentSessionId(c));
  return c.json(status(c));
});

/**
 * Open, without sign-in: which TOT this is (so another device can check it reached the right one), the
 * pairing call itself (only a live one-time code gets in), and the page a pairing link opens.
 */
export const openDeviceRoutes = new Hono();

openDeviceRoutes.get("/.well-known/tot", (c) => c.json({ id: deviceId(), name: deviceName(), protocol: 1 }));

openDeviceRoutes.post("/api/pair", async (c) => {
  try {
    return c.json(await acceptPairing(await c.req.json().catch(() => null)));
  } catch (err) {
    if (err instanceof PairingError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

openDeviceRoutes.get("/pair", (c) => c.html(pairPage(deviceName())));

function pairPage(name: string): string {
  const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair with ${escape(name)} · TOT</title><link rel="icon" href="/tot.svg">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
    background: light-dark(#f1f1f3, #111114); color: light-dark(#18181b, #fafafa); }
  main { width: min(440px, 88vw); padding: 32px; border-radius: 16px; border: 1px solid light-dark(rgb(9 9 11 / 0.12), rgb(255 255 255 / 0.1));
    background: light-dark(#fff, #16161a); }
  h1 { margin: 0 0 8px; font-size: 20px; letter-spacing: -0.015em; }
  p { margin: 0 0 12px; color: light-dark(#52525b, #a1a1aa); font-size: 14px; }
  code { display: block; padding: 10px 12px; border-radius: 8px; background: light-dark(#f4f4f5, #232327); font-size: 12px; word-break: break-all; }
</style></head>
<body><main>
  <h1>Pair with ${escape(name)}</h1>
  <p>Open TOT on your other device, go to <strong>Settings → Devices → Pair a device</strong>, and paste this whole link there:</p>
  <code id="link"></code>
  <p style="margin-top: 12px">It works once, for 5 minutes.</p>
</main>
<script>document.getElementById("link").textContent = location.href;</script>
</body></html>`;
}
