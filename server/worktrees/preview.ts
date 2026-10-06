import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskPreview } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { computerManager } from "../computer/manager.ts";
import type { BackgroundProcess } from "../computer/types.ts";
import { DATA_DIR } from "../config.ts";
import { conversations } from "../data/conversations.ts";
import { grantFor } from "../projects/checkout.ts";
import { isTask, taskStore } from "../tasks/store.ts";
import { homeRelative } from "../tasks/worktree.ts";
import { scrub } from "../trust/shell.ts";
import { taskPorts } from "./ports.ts";

/**
 * Previews (module 09): a task's dev server, which TOT runs as a managed background process in the
 * task's worktree, with the same sandbox, folder grant and ports as the task's commands, its output in
 * a log under TOT's data dir. TaskInfo.preview says where it answers (the task's "Preview ↗"). It's
 * stopped by task_preview_stop, when the task is stopped, lands, is discarded, cleaned up or deleted,
 * when the process ends by itself, when its computer is stopped, and when TOT shuts down. Each one's
 * process group is also recorded on disk, so one that a TOT that crashed left running is stopped when
 * TOT starts again. Local computers only: a Boat VM's ports aren't on this Mac.
 */

export const PREVIEW_NEEDS_LOCAL =
  "Previews need a local computer: a Boat VM's ports aren't on the user's Mac, so TOT can't show them a preview from one. Run the server with computer_exec and tell the user how to reach it instead.";

const LOG_DIR = join(DATA_DIR, "previews");
/** The previews running now, by task: { pid, started } of each one's process group leader. */
const RECORD = join(LOG_DIR, "running.json");
const READY_TIMEOUT_MS = 45_000;
const POLL_MS = 300;
const TAIL_BYTES = 8_000;
const TAIL_LINES = 20;
/** How often a running preview marks its computer as in use: the idle stop would end it under the user. */
const KEEP_ALIVE_MS = 60_000;

interface Running {
  process: BackgroundProcess;
  preview: TaskPreview;
  log: string;
}

/** Task id → its preview, while one runs. */
const running = new Map<string, Running>();
/** Task id → its latest start: two task_preview_start calls at once run one after the other. */
const starting = new Map<string, Promise<unknown>>();
/** Task id → how many times its preview was stopped: a start that was stopped meanwhile doesn't keep what it started. */
const stops = new Map<string, number>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A preview's process group as recorded on disk: its leader's pid, and when that process started (with the pid, who it is). */
interface Recorded {
  pid: number;
  started: string;
}

/** When a process started and its process group, as `ps` says; null when there's no such process. */
function processInfo(pid: number): { started: string; group: number } | null {
  try {
    const out = execFileSync("ps", ["-o", "pgid=,lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const found = /^\s*(\d+)\s+(.+?)\s*$/.exec(out);
    return found ? { group: Number(found[1]), started: found[2]!.replace(/\s+/g, " ") } : null;
  } catch {
    return null;
  }
}

function readRecords(): Record<string, Recorded> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(RECORD, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, Recorded>) : {};
  } catch {
    return {};
  }
}

function writeRecords(records: Record<string, Recorded>): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(RECORD, JSON.stringify(records), { mode: 0o600 });
  } catch (err) {
    console.warn("[tot] couldn't record the running previews:", err instanceof Error ? err.message : err);
  }
}

/** Notes a task's preview on disk, or (null) forgets it, when it's still that process. */
function remember(taskId: string, entry: Recorded | null, pid = entry?.pid): void {
  const records = readRecords();
  if (entry) records[taskId] = entry;
  else if (records[taskId]?.pid === pid) delete records[taskId];
  else return;
  writeRecords(records);
}

/** Signals a whole process group; quiet when it's already gone. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

/**
 * On startup: previews that a TOT that crashed left running are stopped, each only when its pid is
 * still the process TOT started (the same start time, leading its own group): a pid reused since by
 * something else is never signalled. Then the record is cleared.
 */
function reapOrphans(): void {
  const records = readRecords();
  if (!Object.keys(records).length) return;
  for (const [taskId, { pid, started }] of Object.entries(records)) {
    if (running.get(taskId)?.process.pid === pid) continue;
    delete records[taskId];
    if (!Number.isInteger(pid) || pid <= 1) continue;
    const now = processInfo(pid);
    if (!now || now.group !== pid || now.started !== started) continue;
    console.log(`[tot] stopping a preview left running before TOT restarted (task ${taskId})`);
    signalGroup(pid, "SIGTERM");
    setTimeout(() => {
      const later = processInfo(pid);
      if (!later || later.started === started) signalGroup(pid, "SIGKILL");
    }, 2000).unref();
  }
  writeRecords(records);
}

/** Whether the server answers HTTP at the path, on either loopback address (any status counts). */
async function answers(port: number, path: string): Promise<boolean> {
  for (const host of ["127.0.0.1", "[::1]"]) {
    try {
      await fetch(`http://${host}:${port}${path}`, { signal: AbortSignal.timeout(1500), redirect: "manual" });
      return true;
    } catch {
      // not (yet) on this address
    }
  }
  return false;
}

/** The last lines of a log, without secrets (they go to the agent and the user). */
function tail(log: string): string {
  let fd: number | null = null;
  try {
    const size = statSync(log).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fd = openSync(log, "r");
    readSync(fd, buffer, 0, length, size - length);
    return scrub(buffer.toString("utf8")).trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** "/", "/dashboard?tab=1": where the preview opens. */
function cleanPath(path: string | undefined): string {
  const text = (path ?? "").trim() || "/";
  if (!text.startsWith("/") || /[\s\x00-\x1f\x7f]/.test(text) || text.startsWith("//")) {
    throw new HttpError(400, `The preview's path should look like "/" or "/dashboard".`);
  }
  return text;
}

export interface PreviewStart {
  preview: TaskPreview;
  /** It answered at its URL; false when it's running but didn't answer in time. */
  ready: boolean;
  /** The last lines of its output so far. */
  output: string;
}

/** previews.start, once the task's earlier starts are done. */
async function startNow(taskId: string, input: { command: string; port?: number; path?: string }): Promise<PreviewStart> {
  const task = taskStore.require(taskId);
  const repo = task.task.repo;
  if (!repo?.headSha) throw new HttpError(409, "The task's worktree isn't set up yet.");
  const command = input.command.trim();
  if (!command) throw new HttpError(400, "Say which command runs the dev server.");
  const path = cleanPath(input.path);
  if (computerManager.kindFor(task.agentId) !== "local") throw new HttpError(400, PREVIEW_NEEDS_LOCAL);
  const active = await computerManager.ensure(task.agentId);
  if (!active.backend.background) throw new HttpError(400, PREVIEW_NEEDS_LOCAL);
  const ports = await taskPorts.ensure(taskId);
  const last = ports.base + ports.count - 1;
  const port = input.port ?? ports.base;
  if (port < ports.base || port > last) throw new HttpError(400, `Use one of your task's ports, ${ports.base}–${last} (PORT is ${ports.base}).`);

  await previews.stop(taskId);
  const stopsBefore = stops.get(taskId) ?? 0;
  if (await taskPorts.answering(port)) {
    throw new HttpError(409, `Something is already listening on port ${port}. Stop it first, or use another of your ports (${ports.base}–${last}).`);
  }
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  const log = join(LOG_DIR, `${taskId}.log`);
  writeFileSync(log, "", { mode: 0o600 });
  const child = await active.backend.background(active.externalId, command, {
    cwd: homeRelative(repo.worktree),
    grant: grantFor(task),
    env: taskPorts.env(ports, port),
    log,
  });
  // On disk too: if TOT crashes, the next start stops it (reapOrphans).
  const started = processInfo(child.pid)?.started;
  if (started) remember(taskId, { pid: child.pid, started });
  // A running preview keeps its computer in use.
  const keepAlive = setInterval(() => computerManager.touch(task.agentId), KEEP_ALIVE_MS);
  keepAlive.unref();
  const preview: TaskPreview = { url: `http://localhost:${port}${path}`, port, command, startedAt: Date.now() };
  const entry: Running = { process: child, preview, log };
  let ended = false;
  void child.exited.then(() => {
    ended = true;
    clearInterval(keepAlive);
    remember(taskId, null, child.pid);
    if (running.get(taskId) !== entry) return;
    // It ended by itself (or its computer stopped): whatever it left in its group goes too, and the link goes away.
    running.delete(taskId);
    void child.stop();
    if (taskStore.get(taskId)?.task.preview?.startedAt === preview.startedAt) taskStore.patch(taskId, { preview: null });
  });
  // Stopped while it was starting (the task landed, was discarded or deleted): it doesn't stay.
  if ((stops.get(taskId) ?? 0) !== stopsBefore || !taskStore.get(taskId)) {
    await child.stop();
    throw new HttpError(409, "The preview was stopped while it was starting.");
  }
  running.set(taskId, entry);
  taskStore.patch(taskId, { preview });

  const until = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < until && !ended) {
    if (await answers(port, path)) return { preview, ready: true, output: tail(log) };
    await sleep(POLL_MS);
  }
  if (ended) {
    const output = tail(log);
    throw new HttpError(400, `The preview stopped before it answered on port ${port}.${output ? `\nIts last output:\n${output}` : " It printed nothing."}`);
  }
  return { preview, ready: false, output: tail(log) };
}

export const previews = {
  /**
   * Starts the task's preview (replacing a running one) and waits until its URL answers. Throws, with its
   * output, when the process ends before that. One start at a time per task: two at once leave one running.
   */
  start(taskId: string, input: { command: string; port?: number; path?: string }): Promise<PreviewStart> {
    const next = (starting.get(taskId) ?? Promise.resolve()).catch(() => {}).then(() => startNow(taskId, input));
    starting.set(taskId, next);
    void next
      .finally(() => {
        if (starting.get(taskId) === next) starting.delete(taskId);
      })
      .catch(() => {});
    return next;
  },

  /** Stops the task's preview, if one runs (or is starting), and clears TaskInfo.preview; true when there was one. */
  async stop(taskId: string): Promise<boolean> {
    stops.set(taskId, (stops.get(taskId) ?? 0) + 1);
    const entry = running.get(taskId);
    if (entry) {
      running.delete(taskId);
      await entry.process.stop();
    }
    if (taskStore.get(taskId)?.task.preview) taskStore.patch(taskId, { preview: null });
    return Boolean(entry);
  },

  isRunning(taskId: string): boolean {
    return running.has(taskId);
  },

  /** The last lines of the task's preview output (its latest run's). */
  output(taskId: string): string {
    return tail(join(LOG_DIR, `${taskId}.log`));
  },

  /** TOT is stopping: every preview ends with it. */
  async stopAll(): Promise<void> {
    const ids = [...running.keys()];
    await Promise.allSettled(ids.map((id) => previews.stop(id)));
  },

  /** On startup: previews a crashed TOT left running are stopped, and links from before a restart are forgotten. */
  forgetStale(): void {
    reapOrphans();
    for (const record of conversations.tasks()) {
      if (isTask(record) && record.task.preview && !running.has(record.id)) taskStore.patch(record.id, { preview: null });
    }
  },
};
