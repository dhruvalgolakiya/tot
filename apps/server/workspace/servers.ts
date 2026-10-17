import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { promisify } from "node:util";
import type { WorkspaceServer } from "@tot/shared/workspace";
import { EXECUTOR_PORT, PORT, WEB_PORT } from "../config.ts";
import { taskPorts } from "../worktrees/ports.ts";
import type { ChatSpace } from "./root.ts";
import { terminals } from "./terminal.ts";

/**
 * The Browser tab's dev servers: what's listening on this Mac from a process working in the chat's folder (the
 * agent's, a terminal's, or one the user started elsewhere), and the localhost addresses the chat's terminals
 * printed that something answers on. TOT's own ports never count, even when the folder is TOT's own code.
 */

const run = promisify(execFile);
const LSOF = "/usr/sbin/lsof";
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\b/g;

const isIn = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/** lsof's -F output: one record per process, its fields by their letter ("p", "c", "n"). */
function records(out: string): { pid: number; command: string; names: string[] }[] {
  const found: { pid: number; command: string; names: string[] }[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) found.push({ pid: Number(line.slice(1)), command: "", names: [] });
    else if (line.startsWith("c") && found.length) found.at(-1)!.command = line.slice(1);
    else if (line.startsWith("n") && found.length) found.at(-1)!.names.push(line.slice(1));
  }
  return found;
}

async function lsof(args: string[]): Promise<string> {
  try {
    return (await run(LSOF, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch (err) {
    // lsof exits 1 when it finds nothing (or can't see some processes); what it printed still counts.
    return (err as { stdout?: string }).stdout ?? "";
  }
}

export const workspaceServers = {
  async list(space: ChatSpace): Promise<WorkspaceServer[]> {
    const own = new Set([PORT, WEB_PORT, EXECUTOR_PORT]);
    const found = new Map<number, WorkspaceServer>();
    if (existsSync(LSOF)) {
      const listening = records(await lsof(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"])).filter((record) => record.pid !== process.pid);
      const pids = [...new Set(listening.map((record) => record.pid))];
      const cwds = new Map<number, string>();
      if (pids.length) {
        for (const record of records(await lsof(["-a", "-d", "cwd", "-p", pids.join(","), "-F", "pn"]))) {
          const cwd = record.names[0];
          if (!cwd) continue;
          try {
            cwds.set(record.pid, realpathSync.native(cwd));
          } catch {
            cwds.set(record.pid, cwd);
          }
        }
      }
      for (const record of listening) {
        const cwd = cwds.get(record.pid);
        if (!cwd || !isIn(cwd, space.root)) continue;
        for (const name of record.names) {
          const port = Number(/:(\d+)$/.exec(name)?.[1]);
          if (!port || own.has(port) || found.has(port)) continue;
          found.set(port, { port, url: `http://localhost:${port}`, command: record.command, pid: record.pid, source: "process" });
        }
      }
    }
    // Addresses the chat's terminals printed, that something answers on now.
    const printed = new Set<number>();
    for (const terminal of terminals.list(space.chat.id)) {
      for (const match of terminals.get(terminal.id).scrollback.matchAll(LOCAL_URL)) printed.add(Number(match[1]));
    }
    for (const port of printed) {
      if (found.has(port) || own.has(port) || port > 65_535) continue;
      if (await taskPorts.answering(port)) found.set(port, { port, url: `http://localhost:${port}`, command: "", pid: null, source: "terminal" });
    }
    return [...found.values()].sort((a, b) => a.port - b.port);
  },
};
