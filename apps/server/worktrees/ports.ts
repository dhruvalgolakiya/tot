import { connect } from "node:net";
import type { TaskPorts } from "../../shared/types.ts";
import { EXECUTOR_PORT, PORT, WEB_PORT } from "../config.ts";
import { conversations } from "../data/conversations.ts";
import { taskStore } from "../tasks/store.ts";

/**
 * Port blocks (module 09): every task with a worktree gets ten ports of its own, so tasks' dev servers
 * never fight over 3000. Blocks start at 41000 (TOT_TASK_PORT_BASE moves that, for tests), are unique
 * among the tasks that hold one, never include TOT's own ports, and skip ports something on this Mac
 * already answers on. A task's commands get PORT (the block's first) and TOT_PORTS ("41000-41009").
 * A block is released when its task lands, is discarded or cleaned up; a deleted task's goes with it.
 */

export const BLOCK_SIZE = 10;
const FIRST = Number(process.env.TOT_TASK_PORT_BASE) || 41_000;
const LAST = 65_535;

/** The blocks other tasks hold. */
function held(exceptTaskId: string): TaskPorts[] {
  return conversations.tasks().flatMap((task) => (task.id !== exceptTaskId && task.task?.ports ? [task.task.ports] : []));
}

const overlaps = (block: TaskPorts, base: number) => block.base < base + BLOCK_SIZE && base < block.base + block.count;

/** Whether something on this Mac answers on the port (IPv4 or IPv6 loopback). */
function answering(port: number): Promise<boolean> {
  const probe = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = connect({ port, host });
      const done = (yes: boolean) => {
        socket.destroy();
        resolve(yes);
      };
      socket.setTimeout(300, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  return Promise.all([probe("127.0.0.1"), probe("::1")]).then((found) => found.some(Boolean));
}

async function anyAnswering(base: number): Promise<boolean> {
  const found = await Promise.all(Array.from({ length: BLOCK_SIZE }, (_, i) => answering(base + i)));
  return found.some(Boolean);
}

/** One allocation at a time: two tasks set up together mustn't get the same block. */
let pending: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const next = pending.catch(() => {}).then(work);
  pending = next;
  return next;
}

export const taskPorts = {
  /** The task's block, given one now when it has none. */
  ensure(taskId: string): Promise<TaskPorts> {
    return oneAtATime(async () => {
      const task = taskStore.require(taskId);
      if (task.task.ports) return task.task.ports;
      const taken = held(taskId);
      const own = [PORT, WEB_PORT, EXECUTOR_PORT];
      for (let base = FIRST; base + BLOCK_SIZE - 1 <= LAST; base += BLOCK_SIZE) {
        if (taken.some((block) => overlaps(block, base))) continue;
        if (own.some((port) => port >= base && port < base + BLOCK_SIZE)) continue;
        if (await anyAnswering(base)) continue;
        const ports: TaskPorts = { base, count: BLOCK_SIZE };
        taskStore.patch(taskId, { ports });
        return ports;
      }
      throw new Error("There are no free ports left for this task.");
    });
  },

  /** Gives the task's block back (landed, discarded, cleaned up). */
  release(taskId: string): void {
    if (taskStore.get(taskId)?.task.ports) taskStore.patch(taskId, { ports: null });
  },

  /** PORT and TOT_PORTS for a command; `port` overrides PORT (a preview on another port of the block). */
  env(ports: TaskPorts | null | undefined, port?: number): Record<string, string> {
    if (!ports) return {};
    return { PORT: String(port ?? ports.base), TOT_PORTS: `${ports.base}-${ports.base + ports.count - 1}` };
  },

  /** The environment a conversation's commands get: a coding task's ports, nothing for anything else. */
  envFor(conversationId: string): Record<string, string> {
    const task = taskStore.get(conversationId);
    return task?.task.repo ? taskPorts.env(task.task.ports) : {};
  },

  answering,
};
