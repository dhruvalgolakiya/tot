import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, statSync, truncateSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { probeTot } from "./probe.ts";

/**
 * The TOT server the Mac app runs (roadmap module 08): Electron's own Node (ELECTRON_RUN_AS_NODE) running
 * dist-app/server.mjs, the same server as `npm start`. It gets a process group of its own, so quitting can take
 * down everything it started (codex, Executor, Claude Code) even if it hangs, and its output goes straight into
 * the log file, which keeps filling even if the app itself crashes.
 */

const LOG_LIMIT_BYTES = 10 * 1024 * 1024;
const STOP_GRACE_MS = 5000;
const READY_TIMEOUT_MS = 60_000;

/** Empties the log at launch once it has grown past `limit`. Returns whether it did. */
export function trimLog(file: string, limit = LOG_LIMIT_BYTES): boolean {
  try {
    if (statSync(file).size <= limit) return false;
    truncateSync(file, 0);
    return true;
  } catch {
    return false;
  }
}

/** A line from the app itself, between the server's own. */
export function logLine(file: string, line: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} [app] ${line}\n`);
  } catch {
    // Logging must never take the app down.
  }
}

export interface ServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Signals a whole process group; it may well be gone already. */
function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {
    // Nobody left in it.
  }
}

export class ServerProcess {
  private child: ChildProcess | null = null;
  private stopping = false;

  /** `onExit` hears about the server stopping by itself (not through stop()), after what it left behind is ended. */
  constructor(
    private readonly options: { execPath: string; entry: string; cwd: string; port: number; logFile: string },
    private readonly onExit: (exit: ServerExit) => void,
  ) {}

  get running(): boolean {
    return this.child !== null;
  }

  start(): void {
    const { execPath, entry, cwd, port, logFile } = this.options;
    mkdirSync(dirname(logFile), { recursive: true });
    const log = openSync(logFile, "a");
    this.stopping = false;
    const child = spawn(execPath, [entry], {
      cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: "production",
        TOT_PORT: String(port),
        // As `npm start`: node:sqlite still prints an experimental warning.
        NODE_OPTIONS: [process.env.NODE_OPTIONS, "--disable-warning=ExperimentalWarning"].filter(Boolean).join(" "),
      },
      stdio: ["ignore", log, log],
      // Its own process group: stop() can end the server and everything it started in one go.
      detached: true,
    });
    closeSync(log);
    this.child = child;
    const exited = (exit: ServerExit) => {
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      // It died without shutting down: end what it left running (Executor, a Claude Code process) first.
      void this.sweep(child.pid).then(() => this.onExit(exit));
    };
    child.once("exit", (code, signal) => exited({ code, signal }));
    child.once("error", () => {
      if (child.pid === undefined) exited({ code: null, signal: null });
    });
  }

  /** Until the server answers as TOT: "ready", "exited" (it stopped while starting), or "timeout". */
  async waitReady(timeoutMs = READY_TIMEOUT_MS): Promise<"ready" | "exited" | "timeout"> {
    const child = this.child;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!child || this.child !== child) return "exited";
      if ((await probeTot(this.options.port, 1000)).kind === "tot") return this.child === child ? "ready" : "exited";
      await sleep(250);
    }
    return "timeout";
  }

  /** SIGTERM: the server stops its runs, codex, Executor and the rest. After 5 s, SIGKILL whatever is left of its group. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    this.stopping = true;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(STOP_GRACE_MS)]);
    }
    signalGroup(child.pid, "SIGKILL");
    await Promise.race([exited, sleep(1000)]);
    this.child = null;
  }

  private async sweep(pid: number | undefined): Promise<void> {
    if (!pid) return;
    signalGroup(pid, "SIGTERM");
    await sleep(1000);
    signalGroup(pid, "SIGKILL");
  }
}
