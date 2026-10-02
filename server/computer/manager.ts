import type { ComputerKind, ComputerSummary } from "../../shared/types.ts";
import { appEvents } from "../app-events.ts";
import { agents } from "../data/agents.ts";
import { computers, toSummary, type ComputerRecord } from "../data/computers.ts";
import { settings } from "../data/settings.ts";
import { bus } from "../events.ts";
import { boatBackend } from "./boat.ts";
import { forgetGitHubLogin, syncGitHubLogin } from "./github-login.ts";
import { localBackend } from "./local.ts";
import { forgetPersonaIdentity, syncPersonaIdentity } from "./persona-identity.ts";
import { deleteScreenshots, saveScreenshot } from "./screens.ts";
import type { ComputerBackend, DesktopControl } from "./types.ts";

/**
 * One computer per agent, shared by all of its chats: created lazily on the
 * first tool call, stopped after the idle timeout, resumed on the next call.
 * Every state change is published so the agent's live runs can show it.
 */

const backends: Record<ComputerKind, ComputerBackend> = { boat: boatBackend, local: localBackend };
const REAP_INTERVAL_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 8_000;
/** Screenshots are scaled to this width: plenty for a model to read, cheap to send. */
const SHOT_WIDTH = 1280;
/** Let the screen settle after an action before looking at it. */
const SETTLE_MS = 800;

export interface Screenshot {
  png: Buffer;
  url: string;
  /** Size of the image the agent sees; clicks use these coordinates. */
  width: number;
  height: number;
  event?: ActiveComputer["event"];
}

/** Real screen pixels per screenshot pixel, per agent (from its latest screenshot). */
const scales = new Map<string, number>();

export interface ActiveComputer {
  backend: ComputerBackend;
  externalId: string;
  summary: ComputerSummary;
  /** Set when this call started or resumed the computer (worth telling the agent). */
  event?: "created" | "resumed";
}

const inflight = new Map<string, Promise<ActiveComputer>>();

function publish(record: ComputerRecord | null): ComputerRecord | null {
  if (record) {
    const computer = toSummary(record);
    bus.publish(record.agentId, { type: "computer", computer });
    appEvents.publish({ type: "computer", agentId: record.agentId, computer });
  }
  return record;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// A crash mid-transition leaves states that no longer mean anything.
for (const record of computers.list()) {
  if (record.state === "starting" && record.externalId) computers.update(record.agentId, { state: "stopped" });
  if (record.state === "starting" && !record.externalId) {
    computers.update(record.agentId, { state: "error", error: "Interrupted while starting." });
  }
  if (record.state === "stopping") computers.update(record.agentId, { state: "stopped" });
}

async function bringUp(agentId: string): Promise<ActiveComputer> {
  let record = computers.getByAgent(agentId);

  if (record?.externalId && record.state === "running") {
    const externalId = record.externalId;
    record = computers.update(agentId, { lastUsedAt: Date.now() })!;
    return { backend: backends[record.kind], externalId, summary: toSummary(record) };
  }

  if (record?.externalId && (record.state === "stopped" || record.state === "error")) {
    const backend = backends[record.kind];
    const externalId = record.externalId;
    publish(computers.update(agentId, { state: "starting", error: undefined }));
    try {
      await backend.resume(externalId);
    } catch (err) {
      publish(computers.update(agentId, { state: "error", error: errorText(err) }));
      throw err;
    }
    record = publish(computers.update(agentId, { state: "running", lastUsedAt: Date.now() }))!;
    return { backend, externalId, summary: toSummary(record), event: "resumed" };
  }

  const { mode, size } = settings.get().computer;
  if (mode === "off") throw new Error("The computer is turned off. The user can enable it in Settings → Computer.");
  const backend = backends[mode];
  const check = await backend.check();
  if (!check.ok) throw new Error(check.reason ?? "The computer isn't available.");

  record = record
    ? computers.update(agentId, { kind: mode, state: "starting", label: "Starting…", error: undefined })
    : computers.create({ agentId, kind: mode, state: "starting", label: "Starting…" });
  publish(record);
  try {
    const name = `TOT · ${agents.get(agentId)?.name ?? "agent"}`;
    const created = await backend.create({ name, agentId, size });
    record = computers.update(agentId, {
      externalId: created.externalId,
      label: created.label,
      workspacePath: created.workspacePath,
      // Boat desktop links expire in minutes, so the UI goes through a redirect that mints a fresh one.
      desktopUrl: backend.desktopUrl ? `/api/agents/${agentId}/computer/desktop` : undefined,
      state: "running",
      error: undefined,
      lastUsedAt: Date.now(),
    })!;
  } catch (err) {
    publish(computers.update(agentId, { state: "error", error: errorText(err) }));
    throw err;
  }
  publish(record);
  return { backend, externalId: record.externalId!, summary: toSummary(record), event: "created" };
}

async function stopRecord(record: ComputerRecord): Promise<ComputerRecord | null> {
  if (!record.externalId || record.state === "stopped") return record;
  publish(computers.update(record.agentId, { state: "stopping" }));
  try {
    await backends[record.kind].stop(record.externalId);
    return publish(computers.update(record.agentId, { state: "stopped" }));
  } catch (err) {
    return publish(computers.update(record.agentId, { state: "error", error: errorText(err) }));
  }
}

function requireDesktop(active: ActiveComputer): DesktopControl {
  if (!active.backend.desktop) {
    throw new Error("This computer has no desktop to control. Desktop tools need a Boat VM (Settings → Computer).");
  }
  return active.backend.desktop;
}

let reaper: NodeJS.Timeout | null = null;

export const computerManager = {
  get(agentId: string): ComputerSummary | null {
    const record = computers.getByAgent(agentId);
    return record ? toSummary(record) : null;
  },

  /** Starts (or resumes) the chat's computer and brings its GitHub login and git author up to date. Concurrent callers share one attempt. */
  ensure(agentId: string): Promise<ActiveComputer> {
    let pending = inflight.get(agentId);
    if (!pending) {
      pending = bringUp(agentId)
        .then(async (active) => {
          try {
            await syncGitHubLogin(agentId, active);
          } catch (err) {
            // The computer still works without GitHub; the agent finds out when git asks for a login.
            console.warn("[tot] GitHub login on the agent's computer failed:", errorText(err));
          }
          // After the GitHub step, so a persona's name and address win as the commit author.
          try {
            await syncPersonaIdentity(agentId, active);
          } catch (err) {
            console.warn("[tot] setting the persona's git author failed:", errorText(err));
          }
          return active;
        })
        .finally(() => inflight.delete(agentId));
      inflight.set(agentId, pending);
    }
    return pending;
  },

  touch(agentId: string): void {
    computers.update(agentId, { lastUsedAt: Date.now() });
  },

  async exposePort(agentId: string, port: number): Promise<string> {
    const { backend, externalId } = await computerManager.ensure(agentId);
    const url = await backend.exposePort(externalId, port);
    const record = computers.getByAgent(agentId);
    if (record) {
      const exposedUrls = [...record.exposedUrls.filter((entry) => entry.port !== port), { port, url }];
      publish(computers.update(agentId, { exposedUrls, lastUsedAt: Date.now() }));
    }
    return url;
  },

  /** Kind the agent's computer has, or will get on first use (null when computers are off). */
  kindFor(agentId: string): ComputerKind | null {
    const record = computers.getByAgent(agentId);
    if (record) return record.kind;
    const { mode } = settings.get().computer;
    return mode === "off" ? null : mode;
  },

  /** Whether the agent can see and control a desktop (Boat VMs). */
  hasDesktop(agentId: string): boolean {
    const kind = computerManager.kindFor(agentId);
    return kind ? Boolean(backends[kind].desktop) : false;
  },

  async screenshot(agentId: string): Promise<Screenshot> {
    const active = await computerManager.ensure(agentId);
    const desktop = requireDesktop(active);
    const shot = await desktop.screenshot(active.externalId, SHOT_WIDTH);
    const width = Math.min(SHOT_WIDTH, shot.screenWidth);
    const height = Math.round((shot.screenHeight * width) / shot.screenWidth);
    scales.set(agentId, shot.screenWidth / width);
    const url = saveScreenshot(agentId, shot.png);
    publish(computers.update(agentId, { screenshotUrl: url, lastUsedAt: Date.now() }));
    return { png: shot.png, url, width, height, event: active.event };
  },

  /**
   * Runs a desktop action with coordinates in screenshot pixels (scaled to the
   * real screen), then returns a fresh screenshot so the agent sees the result.
   */
  async act(
    agentId: string,
    action: (desktop: DesktopControl, externalId: string, toScreen: (value: number) => number) => Promise<void>,
  ): Promise<Screenshot> {
    const active = await computerManager.ensure(agentId);
    const desktop = requireDesktop(active);
    if (!scales.has(agentId)) await computerManager.screenshot(agentId);
    const scale = scales.get(agentId) ?? 1;
    await action(desktop, active.externalId, (value) => Math.round(value * scale));
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    return computerManager.screenshot(agentId);
  },

  async desktopUrl(agentId: string): Promise<string> {
    const { backend, externalId } = await computerManager.ensure(agentId);
    if (!backend.desktopUrl) throw new Error("This computer has no virtual desktop (only Boat VMs do).");
    return backend.desktopUrl(externalId);
  },

  async stop(agentId: string): Promise<ComputerSummary | null> {
    const record = computers.getByAgent(agentId);
    if (!record) return null;
    const stopped = await stopRecord(record);
    return stopped ? toSummary(stopped) : null;
  },

  async destroy(agentId: string): Promise<void> {
    const record = computers.getByAgent(agentId);
    if (!record) return;
    if (record.externalId) {
      await backends[record.kind].destroy(record.externalId);
      forgetGitHubLogin(record.externalId);
      forgetPersonaIdentity(record.externalId);
    }
    computers.delete(agentId);
    deleteScreenshots(agentId);
  },

  /** Stops computers that sat idle longer than the configured timeout (Boat bills while running). */
  startIdleReaper(): void {
    if (reaper) return;
    reaper = setInterval(() => {
      const idleMs = settings.get().computer.idleStopMinutes * 60_000;
      for (const record of computers.list()) {
        if (record.state !== "running" || inflight.has(record.agentId)) continue;
        if (Date.now() - (record.lastUsedAt ?? record.createdAt) > idleMs) void stopRecord(record);
      }
    }, REAP_INTERVAL_MS);
    reaper.unref();
  },

  /** Best-effort stop of running computers so cloud VMs don't keep billing after TOT exits. */
  async shutdown(): Promise<void> {
    if (reaper) clearInterval(reaper);
    const running = computers.list().filter((record) => record.state === "running");
    await Promise.race([
      Promise.allSettled(running.map(stopRecord)),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);
  },
};
