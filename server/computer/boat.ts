import { BoatApi, Configuration, ResponseError, waitForDesktop, waitUntilReady, type CommandResponse } from "@boatdev/sdk";
import { getSecret } from "../config.ts";
import type { ComputerBackend, ComputerSize, DesktopControl, ExecResult } from "./types.ts";

/** boat.dev cloud VMs: Ubuntu with Docker, Node, Bun, Python, Chrome and a 60 fps desktop. */

const HOME = "/home/user";
/** Hard ceiling from each create/resume; TOT's idle reaper stops VMs much sooner. */
const TTL_SECONDS = 4 * 60 * 60;
const READY_TIMEOUT_MS = 4 * 60_000;
const MAX_TIMEOUT_SECONDS = 600;

const SIZE_LABELS: Record<ComputerSize, string> = {
  small: "2 vCPU / 4 GB",
  default: "4 vCPU / 8 GB",
  large: "8 vCPU / 16 GB",
};

function client(): BoatApi {
  const key = getSecret("boatApiKey");
  if (!key) throw new Error("No Boat API key. Add one in Settings → Computer (boat.dev/dashboard → API keys).");
  return new BoatApi(new Configuration({ basePath: process.env.BOAT_API_URL ?? "https://boat.dev/api/v1", accessToken: key }));
}

/** Boat errors come back as { code, message }; surface them instead of "Response returned an error code". */
async function describe(err: unknown): Promise<Error> {
  if (err instanceof ResponseError) {
    const status = err.response.status;
    try {
      const body = (await err.response.json()) as { code?: string; message?: string; error?: { message?: string } };
      const message = body.message ?? body.error?.message ?? err.response.statusText;
      return Object.assign(new Error(`Boat: ${message}${body.code ? ` (${body.code})` : ""}`), { status, code: body.code });
    } catch {
      return Object.assign(new Error(`Boat request failed (HTTP ${status}).`), { status });
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw await describe(err);
  }
}

/** Relative paths resolve against /home/user (Boat only allows /home/user and /tmp). */
const absolute = (path: string) => (path.startsWith("/") ? path : `${HOME}/${path.replace(/^\.\//, "")}`);

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

async function ready(api: BoatApi, sandboxId: string): Promise<void> {
  await call(() => waitUntilReady(api, sandboxId, { timeoutMs: READY_TIMEOUT_MS, intervalMs: 2000 }));
}

// ---------------------------------------------------------------------------
// Desktop control: xdotool + ImageMagick against the VM's desktop (Xorg :0,
// 1920×1080, owned by `user`), run through the command API. Screenshots come
// back via the file download API — stdout is truncated for large outputs.
// ---------------------------------------------------------------------------

/** Finds the desktop's X display and auth, whichever user runs it. */
const X_ENV = [
  'export DISPLAY="${DISPLAY:-$(ls /tmp/.X11-unix 2>/dev/null | sed -n \'s/^X\\([0-9]*\\)$/:\\1/p\' | head -1)}"',
  'export DISPLAY="${DISPLAY:-:0}"',
  'export XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"',
].join("; ");

const TOOLS_READY = new Set<string>();

async function run(sandboxId: string, command: string, timeoutSeconds = 30): Promise<string> {
  const result = (await call(() => client().command({ sandboxId, command, timeoutSeconds }))) as CommandResponse;
  if (result.exitCode !== 0) {
    throw new Error(`Desktop command failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(-400)}`);
  }
  return result.stdout;
}

/** Installs the desktop tools on first use (Ubuntu images may not ship them). */
async function desktopCommand(sandboxId: string, command: string, timeoutSeconds = 30): Promise<string> {
  if (!TOOLS_READY.has(sandboxId)) {
    await run(
      sandboxId,
      "command -v xdotool >/dev/null && command -v import >/dev/null || " +
        "(sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -qq && " +
        "sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xdotool imagemagick x11-utils wmctrl >/dev/null)",
      240,
    );
    TOOLS_READY.add(sandboxId);
  }
  return run(sandboxId, `${X_ENV}; ${command}`, timeoutSeconds);
}

const BUTTONS = { left: 1, middle: 2, right: 3 } as const;
const WHEEL = { up: 4, down: 5, left: 6, right: 7 } as const;

const desktop: DesktopControl = {
  async screenshot(sandboxId, maxWidth) {
    const size = await desktopCommand(
      sandboxId,
      "mkdir -p /tmp/tot && import -window root /tmp/tot/full.png && " +
        `convert /tmp/tot/full.png -resize '${maxWidth}x>' /tmp/tot/shot.png && identify -format '%w %h' /tmp/tot/full.png`,
      60,
    );
    const [screenWidth, screenHeight] = size.trim().split(/\s+/).map(Number);
    const blob = await call(() => client().artifact({ sandboxId, path: "/tmp/tot/shot.png" }));
    return { png: Buffer.from(await blob.arrayBuffer()), screenWidth: screenWidth || 1920, screenHeight: screenHeight || 1080 };
  },

  async click(sandboxId, x, y, { button, double }) {
    const repeat = double ? "--repeat 2 --delay 90 " : "";
    await desktopCommand(sandboxId, `xdotool mousemove --sync ${x} ${y} click ${repeat}${BUTTONS[button]}`);
  },

  async type(sandboxId, text) {
    await desktopCommand(sandboxId, `xdotool type --delay 12 -- ${quote(text)}`, 120);
  },

  async key(sandboxId, keys) {
    const combos = keys.split(/\s+/).filter(Boolean).map(quote).join(" ");
    await desktopCommand(sandboxId, `xdotool key --delay 60 -- ${combos}`);
  },

  async scroll(sandboxId, x, y, direction, amount) {
    await desktopCommand(sandboxId, `xdotool mousemove --sync ${x} ${y} click --repeat ${amount} --delay 40 ${WHEEL[direction]}`);
  },

  // Boat's documented recipe: launch desktop Chrome, then raise its window.
  async openUrl(sandboxId, url) {
    const browser =
      "B=$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser || echo xdg-open)";
    await desktopCommand(
      sandboxId,
      `${browser}; (nohup "$B" --new-window ${quote(url)} >/dev/null 2>&1 &) ; sleep 2; wmctrl -a Chrome 2>/dev/null || true`,
    );
  },
};

export const boatBackend: ComputerBackend = {
  kind: "boat",

  async check() {
    return getSecret("boatApiKey")
      ? { ok: true }
      : { ok: false, reason: "Boat isn't set up. Add a Boat API key in Settings → Computer, or switch the computer to Local." };
  },

  async create({ name, size }) {
    const api = client();
    // noEnv: never inject the user's Boat account secrets into an agent's VM.
    const created = await call(() => api.create({ type: size, ttlSeconds: TTL_SECONDS, noEnv: true }));
    const sandboxId = created.sandbox.id;
    await call(() => api.update({ sandboxId, name })).catch(() => {});
    await ready(api, sandboxId);
    return { externalId: sandboxId, label: `Boat VM · ${SIZE_LABELS[size]}` };
  },

  async resume(sandboxId) {
    const api = client();
    const info = await call(() => api.get({ sandboxId }));
    if (["archived", "archiving", "cancelled"].includes(info.sandbox.state)) {
      await call(() => api.resume({ sandboxId, ttlSeconds: TTL_SECONDS }));
    }
    await ready(api, sandboxId);
  },

  async stop(sandboxId) {
    await call(() => client().stop({ sandboxId }));
  },

  async destroy(sandboxId) {
    await call(() => client().deleteSandbox({ sandboxId, xAsciiConfirmDelete: sandboxId }));
  },

  home() {
    return HOME;
  },

  desktop,

  async exec(sandboxId, command, { cwd, timeoutMs }): Promise<ExecResult> {
    const api = client();
    const timeoutSeconds = Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Math.round(timeoutMs / 1000)));
    const dir = cwd ? absolute(cwd) : undefined;
    const started = Date.now();
    // Right after a resume Boat may answer 409 boat_starting; it's safe to retry because the command never ran.
    for (let attempt = 0; ; attempt++) {
      try {
        const result = (await api.command({
          sandboxId,
          command,
          cwd: dir?.startsWith(`${HOME}/`) ? dir.slice(HOME.length + 1) : dir,
          timeoutSeconds,
        })) as CommandResponse;
        return {
          stdout: result.stdout + (result.stdoutTruncated ? "\n… (output truncated by Boat)" : ""),
          stderr: result.stderr + (result.oomKilled ? "\n[killed: out of memory]" : ""),
          exitCode: result.exitCode ?? (result.timedOut ? 124 : 1),
          durationMs: Date.now() - started,
          timedOut: Boolean(result.timedOut),
        };
      } catch (err) {
        const error = await describe(err);
        if ((error as { code?: string }).code === "boat_starting" && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
        }
        throw error;
      }
    }
  },

  async readFile(sandboxId, path) {
    const file = await call(() => client().readFile({ sandboxId, path: absolute(path), encoding: "utf8" }));
    return file.content;
  },

  async writeFile(sandboxId, path, content) {
    const api = client();
    const file = absolute(path);
    const dir = file.slice(0, file.lastIndexOf("/"));
    if (dir) await call(() => api.command({ sandboxId, command: `mkdir -p ${quote(dir)}`, timeoutSeconds: 30 }));
    await call(() => api.writeFile({ sandboxId, path: file, content, encoding: "utf8" }));
  },

  async upload(sandboxId, path, data) {
    const api = client();
    const file = absolute(path);
    const dir = file.slice(0, file.lastIndexOf("/"));
    if (dir) await call(() => api.command({ sandboxId, command: `mkdir -p ${quote(dir)}`, timeoutSeconds: 30 }));
    await call(() => api.writeFile({ sandboxId, path: file, content: data.toString("base64"), encoding: "base64" }));
  },

  async exposePort(sandboxId, port) {
    const hosted = await call(() => client().hostPort({ sandboxId, port, title: `TOT port ${port}` }));
    if (!hosted.url) throw new Error(`Boat didn't return a URL for port ${port}.`);
    return hosted.url;
  },

  async desktopUrl(sandboxId) {
    const desktop = await call(() => waitForDesktop(client(), sandboxId, { timeoutMs: 90_000, intervalMs: 2000 }));
    if (!desktop.desktopUrl) throw new Error(desktop.message ?? "Boat didn't return a desktop URL.");
    return desktop.desktopUrl;
  },
};
