// Minimal client for `codex app-server` (the JSON-RPC protocol behind the Codex IDE
// extension). Wire format: newline-delimited JSON, JSON-RPC 2.0 shapes without the
// "jsonrpc" field. Requests `{method,id,params}`, responses `{id,result|error}`,
// notifications `{method,params}`. The server also sends requests to the client
// (approvals, elicitations) which must always be answered or the turn stalls.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class CodexRpcError extends Error {
  constructor(
    readonly method: string,
    readonly rpc: RpcError,
  ) {
    super(rpc.message || `${method} failed (code ${rpc.code})`);
  }
}

/** The app-server process went away (crash, kill, or failed to start). */
export class CodexExitError extends Error {}

export type NotificationHandler = (method: string, params: any) => void;
/** Returns the result for a server->client request; throwing answers with an RPC error. */
export type ServerRequestHandler = (method: string, params: any) => Promise<unknown> | unknown;

type Pending = { method: string; resolve: (value: any) => void; reject: (err: Error) => void; timer?: NodeJS.Timeout };

const STDERR_TAIL_BYTES = 8_000;
const KILL_GRACE_MS = 2_000;

/** Every live app-server, so the process 'exit' hook can take them down with us. */
const live = new Set<CodexAppServer>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // 'exit' handlers must be synchronous; kill() only sends a signal, which is.
  process.once("exit", () => {
    for (const server of live) server.kill("SIGKILL");
  });
}

// ---------------------------------------------------------------------------
// Binary resolution: prefer the codex bundled with @openai/codex-sdk (its
// version matches the protocol this code was written against), then PATH.
// ---------------------------------------------------------------------------

const PLATFORM_PACKAGES: Record<string, string> = {
  "darwin-arm64": "@openai/codex-darwin-arm64",
  "darwin-x64": "@openai/codex-darwin-x64",
  "linux-arm64": "@openai/codex-linux-arm64",
  "linux-x64": "@openai/codex-linux-x64",
  "win32-arm64": "@openai/codex-win32-arm64",
  "win32-x64": "@openai/codex-win32-x64",
};
const TARGET_TRIPLES: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};

export interface CodexBinary {
  path: string;
  /** Extra PATH entries shipped with the bundled binary (ripgrep). */
  pathDirs: string[];
  source: "env" | "bundled" | "path";
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

let resolvedBinary: CodexBinary | null | undefined;

export function resolveCodexBinary(): CodexBinary | null {
  if (resolvedBinary !== undefined) return resolvedBinary;
  resolvedBinary = findBinary();
  return resolvedBinary;
}

function findBinary(): CodexBinary | null {
  const override = process.env.TOT_CODEX_PATH;
  if (override && isFile(override)) return { path: override, pathDirs: [], source: "env" };

  const key = `${process.platform}-${process.arch}`;
  const pkg = PLATFORM_PACKAGES[key];
  const triple = TARGET_TRIPLES[key];
  if (pkg && triple) {
    try {
      const require = createRequire(import.meta.url);
      const codexPkg = require.resolve("@openai/codex/package.json");
      const platformPkg = createRequire(codexPkg).resolve(`${pkg}/package.json`);
      const root = join(dirname(platformPkg), "vendor", triple);
      const exe = join(root, "bin", process.platform === "win32" ? "codex.exe" : "codex");
      if (isFile(exe)) {
        const extra = join(root, "codex-path");
        return { path: exe, pathDirs: existsSync(extra) ? [extra] : [], source: "bundled" };
      }
    } catch {
      // not installed with optional deps; fall through to PATH
    }
  }

  const exeName = process.platform === "win32" ? "codex.exe" : "codex";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && isFile(join(dir, exeName))) return { path: join(dir, exeName), pathDirs: [], source: "path" };
  }
  return null;
}

// ---------------------------------------------------------------------------

export interface SpawnOptions {
  /** `-c key=value` overrides (values are TOML literals). */
  config?: string[];
  /** Extra environment for the child (merged over process.env). */
  env?: Record<string, string>;
  /** A specific codex binary (an account's own CLI); the bundled one, else PATH, when absent. */
  binary?: CodexBinary;
  cwd?: string;
  /** Used in logs. */
  label?: string;
  clientName?: string;
  clientVersion?: string;
  experimentalApi?: boolean;
  /** Notification methods the server shouldn't send us at all. */
  optOutNotifications?: string[];
}

export class CodexAppServer {
  readonly label: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly exitHandlers = new Set<(err: CodexExitError) => void>();
  private requestHandler: ServerRequestHandler | null = null;
  private stderrTail = "";
  private exitError: CodexExitError | null = null;
  private ready: Promise<void> | null = null;
  /** Wall-clock ms of the last request/notification traffic (idle reaping). */
  lastActivity = Date.now();

  constructor(private readonly options: SpawnOptions = {}) {
    this.label = options.label ?? "codex";
  }

  get alive(): boolean {
    return this.child !== null && this.exitError === null;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Spawns the process and performs the initialize/initialized handshake (idempotent). */
  start(timeoutMs = 20_000): Promise<void> {
    this.ready ??= this.spawnAndInitialize(timeoutMs);
    return this.ready;
  }

  private async spawnAndInitialize(timeoutMs: number): Promise<void> {
    const binary = this.options.binary ?? resolveCodexBinary();
    if (!binary) throw new CodexExitError("Codex CLI not found. Install it with `npm i -g @openai/codex` or `brew install codex`.");

    const args: string[] = [];
    for (const override of this.options.config ?? []) args.push("-c", override);
    args.push("app-server");

    const env: Record<string, string | undefined> = { ...process.env, ...this.options.env };
    if (binary.pathDirs.length) env.PATH = [...binary.pathDirs, env.PATH ?? ""].filter(Boolean).join(delimiter);
    env.RUST_LOG ??= "error";

    const child = spawn(binary.path, args, { cwd: this.options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    live.add(this);
    installExitHook();

    child.stdin.on("error", () => {}); // EPIPE after a crash surfaces through 'exit'
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.onLine(line));

    child.once("error", (err) => this.handleExit(`failed to start: ${err.message}`));
    child.once("exit", (code, signal) => this.handleExit(signal ? `killed by ${signal}` : `exited with code ${code}`));

    await this.request(
      "initialize",
      {
        clientInfo: { name: this.options.clientName ?? "tot", title: "TOT", version: this.options.clientVersion ?? "0.1.0" },
        capabilities: {
          experimentalApi: this.options.experimentalApi ?? false,
          requestAttestation: false,
          optOutNotificationMethods: this.options.optOutNotifications ?? null,
        },
      },
      { timeoutMs },
    );
    this.notify("initialized", {});
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /** Runs once when the process exits for any reason (immediately if it already has). */
  onExit(handler: (err: CodexExitError) => void): () => void {
    if (this.exitError) {
      handler(this.exitError);
      return () => {};
    }
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  private handleExit(reason: string): void {
    if (this.exitError) return;
    const tail = this.stderrTail.trim().split("\n").slice(-6).join("\n");
    this.exitError = new CodexExitError(`Codex app-server ${reason}${tail ? `: ${tail}` : ""}`);
    live.delete(this);
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(this.exitError);
    }
    this.pending.clear();
    for (const handler of this.exitHandlers) handler(this.exitError);
  }

  setRequestHandler(handler: ServerRequestHandler): void {
    this.requestHandler = handler;
  }

  /** Last lines the process wrote to stderr (diagnostics). */
  get stderr(): string {
    return this.stderrTail;
  }

  request<T = any>(method: string, params?: unknown, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (this.exitError) return Promise.reject(this.exitError);
    if (!this.child) return Promise.reject(new CodexExitError("Codex app-server isn't running."));
    const id = this.nextId++;
    this.lastActivity = Date.now();
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = { method, resolve, reject };
      if (opts.timeoutMs) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Codex didn't answer ${method} within ${Math.round(opts.timeoutMs! / 1000)}s.`));
        }, opts.timeoutMs);
      }
      if (opts.signal) {
        const onAbort = () => {
          if (!this.pending.delete(id)) return;
          clearTimeout(pending.timer);
          reject(opts.signal!.reason instanceof Error ? opts.signal!.reason : new Error("Aborted"));
        };
        if (opts.signal.aborted) return onAbort();
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, pending);
      this.write({ method, id, params: params ?? {} });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  private write(message: unknown): void {
    if (!this.child || this.exitError) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not protocol output
    }
    if (!msg || typeof msg !== "object") return;
    this.lastActivity = Date.now();

    if (typeof msg.method === "string" && msg.id !== undefined && msg.id !== null) {
      void this.answer(msg.id, msg.method, msg.params);
      return;
    }
    if (typeof msg.method === "string") {
      for (const handler of this.notificationHandlers) {
        try {
          handler(msg.method, msg.params ?? {});
        } catch (err) {
          console.error(`[${this.label}] notification handler failed:`, err);
        }
      }
      return;
    }
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new CodexRpcError(pending.method, msg.error));
      else pending.resolve(msg.result);
    }
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      if (!this.requestHandler) throw Object.assign(new Error(`Unsupported request: ${method}`), { code: -32601 });
      const result = await this.requestHandler(method, params);
      this.write({ id, result: result ?? {} });
    } catch (err) {
      const code = typeof (err as { code?: unknown })?.code === "number" ? (err as { code: number }).code : -32603;
      this.write({ id, error: { code, message: err instanceof Error ? err.message : String(err) } });
    }
  }

  /** Graceful stop: close stdin (app-server exits on EOF), then SIGTERM, then SIGKILL. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || this.exitError) return;
    const exited = new Promise<void>((resolve) => this.onExit(() => resolve()));
    child.stdin.end();
    const term = setTimeout(() => this.kill("SIGTERM"), 500);
    const hard = setTimeout(() => this.kill("SIGKILL"), 500 + KILL_GRACE_MS);
    await exited;
    clearTimeout(term);
    clearTimeout(hard);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    try {
      this.child.kill(signal);
    } catch {
      // already gone
    }
  }
}
