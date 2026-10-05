import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DATA_DIR, EXECUTOR_PORT, PORT, WEB_PORT, paths } from "../config.ts";
import { githubAccessFor } from "../persona-github.ts";
import { verifyGrant } from "../projects/folders.ts";
import type { ComputerBackend, ExecResult, FolderGrant } from "./types.ts";

/**
 * A folder per agent on this machine. On macOS every command runs under a
 * Seatbelt profile (the mechanism Codex uses): writes only inside the
 * workspace and temp dirs, no reads of personal files, network allowed.
 * A command in a folder project (module 06) may also get a folder grant:
 * the user's folder becomes readable, and a task's own branch and worktree
 * in it writable (see grantRules).
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

/**
 * TOT's own server, Executor (apps), and in development the web server in front of TOT. Remote access
 * (listeners.ts) listens on the web port too, on this computer's own addresses: blocked on any address.
 */
const TOT_PORTS = [...new Set([PORT, EXECUTOR_PORT, WEB_PORT])];

/**
 * What a folder grant adds to the profile. Reading: the whole folder. Writing, for a task only: its
 * own checkout in .tot-worktrees, its worktree's git metadata, its one branch and that branch's
 * reflog, and new loose git objects. Everything else stays read-only, so the sandbox, not the prompt,
 * keeps the user's checked-out files, other branches, .git/config, hooks and info untouched: git
 * would run those for the user later, outside any sandbox. A chat in the project only reads.
 */
function grantRules(grant: FolderGrant | null | undefined): { read: string; write: string } {
  if (!grant) return { read: "", write: "" };
  const read = `\n  (subpath ${sbplString(grant.folder)})`;
  if (!grant.task) return { read, write: "" };
  const git = join(grant.folder, ".git");
  const { branch, worktree } = grant.task;
  const path = (...parts: string[]) => sbplString(join(...parts));
  return {
    read,
    write: `
; Folder grant for a task: its checkout, branch and worktree metadata in the user's repo.
(allow file-write*
  (subpath ${path(grant.folder, ".tot-worktrees", worktree)})
  (subpath ${path(git, "worktrees", worktree)})
  (literal ${path(git, "refs/heads", branch)})
  (literal ${path(git, "refs/heads", `${branch}.lock`)})
  (literal ${path(git, "logs/refs/heads", branch)})
  (literal ${path(git, "packed-refs.lock")}))
(deny file-write* (literal ${path(git, "worktrees", worktree, "config.worktree")}))
; New loose git objects only: existing ones can't be changed or removed, nor objects/info (alternates…)
; added. No new packs either: git reads packs first without re-hashing them, so a pack could pass
; other content off as one of the user's objects, for their own next checkout to write.
(allow file-write-create (subpath ${path(git, "objects")}))
(deny file-write-create (subpath ${path(git, "objects/info")}) (subpath ${path(git, "objects/pack")}))
(allow file-write-unlink (require-all (subpath ${path(git, "objects")}) (regex #"/tmp_[^/]*$")))
`,
  };
}

function profile(workspace: string, grant?: FolderGrant | null): string {
  const granted = grantRules(grant);
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
${granted.write}
; Reads: no file contents under the home folder or TOT's data dir (database, secrets, other
; chats' workspaces), except toolchains, this workspace and a granted folder. Metadata stays readable so paths resolve.
(deny file-read-data (subpath ${sbplString(HOME)}) (subpath ${sbplString(dataDir)}))
(allow file-read-data
  ${[...TOOLCHAIN_DIRS, nodeDir].map((dir) => `(subpath ${sbplString(dir)})`).join("\n  ")}
  (subpath ${sbplString(workspace)})${granted.read})

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

/**
 * A path's real location (symlinks resolved as far as it exists); relative paths start in the
 * workspace. `canonical` also takes the case the disk stores, as folder grants are kept.
 */
function realLocation(workspace: string, path: string, canonical = false): string {
  const target = isAbsolute(path) ? resolve(path) : resolve(workspace, path);
  let probe = target;
  while (!existsSync(probe)) probe = dirname(probe);
  return join(canonical ? realpathSync.native(probe) : realpathSync(probe), relative(probe, target));
}

const isIn = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/** Resolves a path inside the workspace, refusing anything (incl. symlinks) that escapes it. */
function inside(workspace: string, path: string): string {
  const real = realLocation(workspace, path);
  const rel = relative(workspace, real);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`"${path}" is outside this computer's workspace (${workspace}). Use paths inside it.`);
  }
  return real;
}

/** A path in the granted folder (checked again now), or null when it isn't in it. */
function inGrant(workspace: string, path: string, grant: FolderGrant | null | undefined): string | null {
  if (!grant) return null;
  if (!SANDBOXED) throw new Error("Folders on this Mac need the macOS sandbox, which this computer doesn't have.");
  verifyGrant(grant);
  const real = realLocation(workspace, path, true);
  return isIn(real, grant.folder) ? real : null;
}

/** A command's working directory: an existing folder in the granted folder, or one in the workspace (made if needed). */
function workingDir(workspace: string, cwd: string, grant: FolderGrant | null | undefined): string {
  const granted = inGrant(workspace, cwd, grant);
  if (granted) {
    if (!existsSync(granted) || !statSync(granted).isDirectory()) throw new Error(`There's no folder at ${cwd}.`);
    return granted;
  }
  const dir = inside(workspace, cwd);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A file operation in the granted folder, run under the same sandbox as commands (never by TOT
 * itself), so a symlink swapped in meanwhile can't send it anywhere the sandbox wouldn't allow.
 */
function sandboxedFile(workspace: string, grant: FolderGrant, script: string, path: string, input?: string): Promise<Buffer> {
  return new Promise((done, fail) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile(workspace, grant), "/bin/sh", "-c", script, "sh", path], {
      cwd: workspace,
      env: { HOME: workspace, PATH: "/usr/bin:/bin" },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    child.stdout!.on("data", (chunk: Buffer) => {
      if ((bytes += chunk.length) <= MAX_READ_BYTES + 64) out.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("error", (error) => (clearTimeout(timer), fail(error)));
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) done(Buffer.concat(out));
      else fail(new Error(Buffer.concat(err).toString("utf8").trim().split("\n").pop() || `exit code ${code}`));
    });
    if (input !== undefined) child.stdin!.end(input);
  });
}

/** In a project folder, only a task's own worktree is writable: say so when a write is refused. */
const writeRefused = (path: string, grant: FolderGrant) =>
  new Error(
    `Can't write ${path}: ${grant.task ? "in the project's folder, only your own task folder (worktree) is writable" : "the project's folder is read-only in a chat; start a task to change it"}.`,
  );

/**
 * Git config for commands in a granted folder: git's background upkeep (gc, maintenance, the
 * fsmonitor daemon) belongs to the user, and in the sandbox it would only fail or leave locks behind.
 */
const GRANTED_GIT = {
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
  GIT_CONFIG_KEY_2: "core.fsmonitor",
  GIT_CONFIG_VALUE_2: "false",
};

/**
 * What `exec` and `background` run: bash under the sandbox profile, in its working directory, with the
 * computer's environment plus `extra` (a task's ports). Throws when the grant or the cwd can't be used.
 */
function commandLine(
  externalId: string,
  command: string,
  { cwd, grant, extra }: { cwd?: string; grant?: FolderGrant | null; extra?: Record<string, string> },
): { file: string; args: string[]; dir: string; env: Record<string, string> } {
  const workspace = realpathSync(workspaceOf(externalId));
  if (grant) {
    if (!SANDBOXED) throw new Error("Folders on this Mac need the macOS sandbox, which this computer doesn't have.");
    verifyGrant(grant);
  }
  const dir = cwd ? workingDir(workspace, cwd, grant) : workspace;
  const [file, args] = SANDBOXED
    ? ["/usr/bin/sandbox-exec", ["-p", profile(workspace, grant), "/bin/bash", "-c", command]]
    : ["/bin/bash", ["-c", command]];
  return { file, args, dir, env: { ...environment(workspace, externalId), ...(grant ? GRANTED_GIT : {}), ...extra } };
}

/** Signals a whole process group; quiet when it's already gone. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
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

  exec(externalId, command, { cwd, timeoutMs, grant, env: extra }) {
    let line: ReturnType<typeof commandLine>;
    try {
      line = commandLine(externalId, command, { cwd, grant, extra });
    } catch (err) {
      return Promise.reject(err);
    }
    const { file, args, dir, env } = line;

    return new Promise<ExecResult>((done) => {
      const started = Date.now();
      const child = spawn(file, args, { cwd: dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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

  async background(externalId, command, { cwd, grant, env: extra, log }) {
    const { file, args, dir, env } = commandLine(externalId, command, { cwd, grant, extra });
    mkdirSync(dirname(log), { recursive: true });
    // TOT opens the log, outside the sandbox: the command writes to it without being able to open anything there.
    const fd = openSync(log, "a", 0o600);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { cwd: dir, env, detached: true, stdio: ["ignore", fd, fd] });
    } finally {
      closeSync(fd);
    }
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.once("error", () => resolve(127));
    });
    const pid = child.pid;
    if (!pid) {
      await exited;
      throw new Error("The command couldn't be started.");
    }
    child.unref();
    return {
      pid,
      exited,
      async stop() {
        signalGroup(pid, "SIGTERM");
        const kill = setTimeout(() => signalGroup(pid, "SIGKILL"), 2000);
        await exited;
        clearTimeout(kill);
        // Whatever it left running in its group goes too.
        signalGroup(pid, "SIGKILL");
      },
    };
  },

  async readFile(externalId, path, { grant } = {}) {
    const workspace = realpathSync(workspaceOf(externalId));
    const granted = inGrant(workspace, path, grant);
    if (granted) {
      // The size on the first line, then at most MAX_READ_BYTES of the file.
      const out = await sandboxedFile(workspace, grant!, `wc -c < "$1" && head -c ${MAX_READ_BYTES} "$1"`, granted);
      const newline = out.indexOf(10);
      const size = Number(out.subarray(0, newline).toString().trim());
      const buffer = out.subarray(newline + 1);
      if (buffer.includes(0)) return `[binary file, ${size} bytes]`;
      const text = buffer.toString("utf8");
      return size > MAX_READ_BYTES ? `${text}\n… (${size - MAX_READ_BYTES} more bytes not shown)` : text;
    }
    const file = inside(workspace, path);
    const size = statSync(file).size;
    const buffer = readFileSync(file).subarray(0, MAX_READ_BYTES);
    if (buffer.includes(0)) return `[binary file, ${size} bytes]`;
    const text = buffer.toString("utf8");
    return size > MAX_READ_BYTES ? `${text}\n… (${size - MAX_READ_BYTES} more bytes not shown)` : text;
  },

  async writeFile(externalId, path, content, { grant } = {}) {
    const workspace = realpathSync(workspaceOf(externalId));
    const granted = inGrant(workspace, path, grant);
    if (granted) {
      await sandboxedFile(workspace, grant!, `mkdir -p "$(dirname "$1")" && cat > "$1"`, granted, content).catch(() => {
        throw writeRefused(path, grant!);
      });
      return;
    }
    const file = inside(workspace, path);
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
