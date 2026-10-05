import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskPreview } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { computerManager } from "../computer/manager.ts";
import type { BackgroundProcess } from "../computer/types.ts";
import { DATA_DIR } from "../config.ts";
import { conversations } from "../data/conversations.ts";
import { redactGitHubTokens } from "../github.ts";
import { grantFor } from "../projects/checkout.ts";
import { isTask, taskStore } from "../tasks/store.ts";
import { homeRelative } from "../tasks/worktree.ts";
import { taskPorts } from "./ports.ts";

/**
 * Previews (module 09): a task's dev server, which TOT runs as a managed background process in the
 * task's worktree, with the same sandbox, folder grant and ports as the task's commands, its output in
 * a log under TOT's data dir. TaskInfo.preview says where it answers (the task's "Preview ↗"). It's
 * stopped by task_preview_stop, when the task is stopped, lands, is discarded, cleaned up or deleted,
 * when the process ends by itself, and when TOT shuts down. Local computers only: a Boat VM's ports
 * aren't on this Mac.
 */

export const PREVIEW_NEEDS_LOCAL =
  "Previews need a local computer: a Boat VM's ports aren't on the user's Mac, so TOT can't show them a preview from one. Run the server with computer_exec and tell the user how to reach it instead.";

const LOG_DIR = join(DATA_DIR, "previews");
const READY_TIMEOUT_MS = 45_000;
const POLL_MS = 300;
const TAIL_BYTES = 8_000;
const TAIL_LINES = 20;

interface Running {
  process: BackgroundProcess;
  preview: TaskPreview;
  log: string;
}

/** Task id → its preview, while one runs. */
const running = new Map<string, Running>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** The last lines of a log, without tokens. */
function tail(log: string): string {
  let fd: number | null = null;
  try {
    const size = statSync(log).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fd = openSync(log, "r");
    readSync(fd, buffer, 0, length, size - length);
    return redactGitHubTokens(buffer.toString("utf8")).trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
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

export const previews = {
  /**
   * Starts the task's preview (replacing a running one) and waits until its URL answers. Throws, with its
   * output, when the process ends before that.
   */
  async start(taskId: string, input: { command: string; port?: number; path?: string }): Promise<PreviewStart> {
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
    const preview: TaskPreview = { url: `http://localhost:${port}${path}`, port, command, startedAt: Date.now() };
    const entry: Running = { process: child, preview, log };
    running.set(taskId, entry);
    let ended = false;
    void child.exited.then(() => {
      ended = true;
      if (running.get(taskId) !== entry) return;
      // It ended by itself: whatever it left in its group goes too, and the link goes away.
      running.delete(taskId);
      void child.stop();
      if (taskStore.get(taskId)?.task.preview?.startedAt === preview.startedAt) taskStore.patch(taskId, { preview: null });
    });
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
  },

  /** Stops the task's preview, if one runs, and clears TaskInfo.preview; true when there was one. */
  async stop(taskId: string): Promise<boolean> {
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

  /** On startup: previews from before a restart aren't running anymore. */
  forgetStale(): void {
    for (const record of conversations.tasks()) {
      if (isTask(record) && record.task.preview && !running.has(record.id)) taskStore.patch(record.id, { preview: null });
    }
  },
};
