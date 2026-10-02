import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DATA_DIR, EXECUTOR_PORT, IS_PROD, PORT, paths } from "../config.ts";
import { githubAccessFor } from "../persona-github.ts";
import type { ComputerBackend, ExecResult } from "./types.ts";

/**
 * A folder per agent on this machine. On macOS every command runs under a
 * Seatbelt profile (the mechanism Codex uses): writes only inside the
 * workspace and temp dirs, no reads of personal files, network allowed.
 */

const SANDBOXED = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 200 * 1024;
/** After bash exits, give straggling output this long to arrive (background jobs may hold the pipes). */
const EXIT_DRAIN_MS = 150;

const HOME = realpathSync(homedir());

/** Toolchains that commonly live in the home folder and must stay readable. */
const TOOLCHAIN_DIRS = [
  ".nvm", ".bun", ".cargo", ".rustup", ".pyenv", ".rbenv", ".volta", ".asdf", ".deno", ".local", "go",
  ".npm-global", "Library/pnpm", ".sdkman",
].map((dir) => join(HOME, dir));

const workspaceOf = (externalId: string) => join(paths.computers, externalId);

const sbplString = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** TOT's own server, Executor (apps), and in development the web server in front of TOT. */
const TOT_PORTS = [...new Set([PORT, EXECUTOR_PORT, ...(IS_PROD ? [] : [5173])])];

function profile(workspace: string): string {
  const dataDir = realpathSync(DATA_DIR);
  const nodeDir = dirname(realpathSync(process.execPath));
  // Seatbelt gives rules on a specific operation (file-read-data) precedence over wildcard
  // ones (file-read*), whatever their order — so every deny/allow pair names the same operation.
  return `(version 1)
(allow default)

; Writes: only the workspace, temp dirs and devices.
(deny file-write*)
(allow file-write*
  (subpath ${sbplString(workspace)})
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (subpath "/dev"))

; Reads: no file contents under the home folder or TOT's data dir (database, secrets, other
; chats' workspaces), except toolchains and this workspace. Metadata stays readable so paths resolve.
(deny file-read-data (subpath ${sbplString(HOME)}) (subpath ${sbplString(dataDir)}))
(allow file-read-data
  ${[...TOOLCHAIN_DIRS, nodeDir].map((dir) => `(subpath ${sbplString(dir)})`).join("\n  ")}
  (subpath ${sbplString(workspace)}))

; getcwd() and Node's startup list each parent of the working directory: allow listing just
; those folders (names only — their other contents stay unreadable).
(allow file-read-data
  ${ancestors(workspace).map((dir) => `(literal ${sbplString(dir)})`).join("\n  ")})

; Network is open, except TOT itself: an agent must not drive TOT's own API (settings, plugins…).
(deny network-outbound
  ${TOT_PORTS.map((port) => `(remote ip "*:${port}")`).join("\n  ")})
`;
}

function ancestors(path: string): string[] {
  const dirs: string[] = [];
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) dirs.push(dir);
  return [...dirs, "/"];
}

/** Process groups started per workspace, so stop/destroy can end background servers. */
const groups = new Map<string, Set<number>>();

function killGroups(externalId: string): void {
  for (const pgid of groups.get(externalId) ?? []) {
    try {
      process.kill(-pgid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          // already gone
        }
      }, 1000).unref();
    } catch {
      // already gone
    }
  }
  groups.delete(externalId);
}

/** Resolves a path inside the workspace, refusing anything (incl. symlinks) that escapes it. */
function inside(workspace: string, path: string): string {
  const target = isAbsolute(path) ? resolve(path) : resolve(workspace, path);
  let probe = target;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = join(realpathSync(probe), relative(probe, target));
  const rel = relative(workspace, real);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`"${path}" is outside this computer's workspace (${workspace}). Use paths inside it.`);
  }
  return real;
}

/** A local computer's id is its agent's (see create). */
function environment(workspace: string, agentId: string): Record<string, string> {
  const github = githubAccessFor(agentId);
  const path = [
    dirname(process.execPath),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return {
    HOME: workspace,
    PATH: [...new Set(path)].join(":"),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: "xterm-256color",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    npm_config_cache: join(workspace, ".npm"),
    // gh is logged in only while agents may write (see github-login.ts); the env var is its most reliable route.
    ...(github?.allowWrites ? { GH_TOKEN: github.token } : {}),
  };
}

export const localBackend: ComputerBackend = {
  kind: "local",

  async check() {
    return { ok: true };
  },

  async create({ agentId }) {
    const workspace = workspaceOf(agentId);
    mkdirSync(workspace, { recursive: true });
    return {
      externalId: agentId,
      label: SANDBOXED ? "Local workspace (sandboxed)" : "Local workspace (not sandboxed)",
      workspacePath: realpathSync(workspace),
    };
  },

  async resume(externalId) {
    mkdirSync(workspaceOf(externalId), { recursive: true });
  },

  async stop(externalId) {
    killGroups(externalId);
  },

  async destroy(externalId) {
    killGroups(externalId);
    rmSync(workspaceOf(externalId), { recursive: true, force: true });
  },

  home(externalId) {
    return workspaceOf(externalId);
  },

  exec(externalId, command, { cwd, timeoutMs }) {
    const workspace = realpathSync(workspaceOf(externalId));
    const dir = cwd ? inside(workspace, cwd) : workspace;
    mkdirSync(dir, { recursive: true });
    const [file, args] = SANDBOXED
      ? ["/usr/bin/sandbox-exec", ["-p", profile(workspace), "/bin/bash", "-c", command]]
      : ["/bin/bash", ["-c", command]];

    return new Promise<ExecResult>((done) => {
      const started = Date.now();
      const child = spawn(file, args, { cwd: dir, env: environment(workspace, externalId), detached: true, stdio: ["ignore", "pipe", "pipe"] });
      if (child.pid) {
        const set = groups.get(externalId) ?? new Set<number>();
        set.add(child.pid);
        groups.set(externalId, set);
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        if ((outBytes += chunk.length) <= MAX_CAPTURE_BYTES) out.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if ((errBytes += chunk.length) <= MAX_CAPTURE_BYTES) err.push(chunk);
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, timeoutMs);

      let settled = false;
      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Background jobs (`server &`) may keep our pipes open; don't wait for them.
        child.stdout.destroy();
        child.stderr.destroy();
        done({
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8") + (timedOut ? `\n[timed out after ${Math.round(timeoutMs / 1000)}s]` : ""),
          exitCode,
          durationMs: Date.now() - started,
          timedOut,
        });
      };
      child.once("exit", (code, signal) => setTimeout(() => finish(code ?? (signal ? 128 : 1)), EXIT_DRAIN_MS));
      child.once("error", (error) => {
        err.push(Buffer.from(error.message));
        finish(127);
      });
    });
  },

  async readFile(externalId, path) {
    const file = inside(realpathSync(workspaceOf(externalId)), path);
    const size = statSync(file).size;
    const buffer = readFileSync(file).subarray(0, MAX_READ_BYTES);
    if (buffer.includes(0)) return `[binary file, ${size} bytes]`;
    const text = buffer.toString("utf8");
    return size > MAX_READ_BYTES ? `${text}\n… (${size - MAX_READ_BYTES} more bytes not shown)` : text;
  },

  async writeFile(externalId, path, content) {
    const file = inside(realpathSync(workspaceOf(externalId)), path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  },

  async upload(externalId, path, data) {
    const file = inside(realpathSync(workspaceOf(externalId)), path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  },

  async exposePort(_externalId, port) {
    return `http://localhost:${port}`;
  },
};

export const localSandboxed = SANDBOXED;
