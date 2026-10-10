// ChatGPT provider: drives `codex app-server` (the JSON-RPC protocol behind the Codex
// IDE extension) with the user's own ChatGPT login.
//
// Process model: ONE app-server process per provider account serves every
// conversation, status check, title completion and login of that account (an
// account with its own folder runs with CODEX_HOME set to it; the built-in one
// uses the default ~/.codex). Each conversation is a Codex thread; its MCP
// servers (TOT's "tot" server + enabled plugins) and the connected-apps switch are
// passed as per-thread config over JSON-RPC (dotted keys, so they merge with the
// process-level lockdown flags and never appear in argv or rollout files). A loaded
// thread whose config changed is unsubscribed and resumed so the new config applies.
// Threads idle for 10 minutes are unloaded (stopping their stdio MCP servers); the
// process stops after 10 idle minutes and restarts lazily.
//
// Lockdown: the agent's computer is TOT's remote VM (via the tot MCP tools), never
// this Mac. Process flags remove the shell, unified exec, computer/browser use,
// plugins, hooks, sub-agents, image generation, memories and the user's own MCP
// servers (unless the account's tools are on: then its config.toml MCP servers
// stay, pre-approved); the sandbox is read-only with approval "never" (so Code
// Mode's nested apply_patch is rejected), and every approval request we still
// receive is declined.

import type { Effort, ModelOption, ProviderAccount, ProviderStatus, Usage } from "../../../shared/types.ts";
import { accountDir, accounts, binaryFor } from "../../accounts/accounts.ts";
import { VERSION, paths } from "../../config.ts";
import { settings as settingsStore } from "../../data/settings.ts";
import { CodexAppServer, CodexExitError, CodexRpcError, resolveCodexBinary } from "./codex-app-server.ts";
import type { AgentProvider, McpServerSpec, ProviderEvent, TurnInput } from "./types.ts";

const STATUS_TTL_MS = 5 * 60_000;
const STATUS_TTL_LOGGED_OUT_MS = 20_000;
const THREAD_IDLE_MS = 10 * 60_000;
const PROCESS_IDLE_MS = 10 * 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** After turn/interrupt, how long to wait for turn/completed before giving up quietly. */
const ABORT_GRACE_MS = 5_000;
const RPC_TIMEOUT_MS = 30_000;
/** computer_exec can run for 10 minutes; leave headroom. */
const TOT_TOOL_TIMEOUT_SEC = 620;
const PLUGIN_TOOL_TIMEOUT_SEC = 300;

const LOGIN_HINT = "Choose Sign in on its row in Settings → Models & accounts, or run `codex login` in a terminal.";

/**
 * Process-level `-c` overrides (TOML values). Everything that could execute on, or
 * control, this machine is off; prompt noise meant for a local coding agent is off.
 */
const LOCKDOWN_FLAGS = [
  'approval_policy="never"',
  'sandbox_mode="read-only"',
  'web_search="live"',
  "notify=[]",
  "features.shell_tool=false",
  "features.unified_exec=false",
  "features.computer_use=false",
  "features.browser_use=false",
  "features.browser_use_external=false",
  "features.in_app_browser=false",
  "features.multi_agent=false",
  "agents.enabled=false",
  "features.plugins=false",
  "features.hooks=false",
  "features.image_generation=false",
  "features.goals=false",
  "features.view_image=false",
  "features.tool_suggest=false",
  "features.memories=false",
  "features.skill_mcp_dependency_install=false",
  "skills.include_instructions=false",
  "include_environment_context=false",
  "include_permissions_instructions=false",
  "include_collaboration_mode_instructions=false",
  'history.persistence="none"',
  "check_for_update_on_startup=false",
  // Unsubscribed threads unload right away, which also stops their stdio MCP servers.
  "thread_unload_delay_secs=0",
];

/** Keys we can address with dotted per-thread config paths. */
const SAFE_KEY = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Protocol subset (see `codex app-server generate-ts` for the full schema)
// ---------------------------------------------------------------------------

interface CodexModel {
  id: string;
  model: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[];
  defaultReasoningEffort?: string;
  upgradeInfo?: { retirementAt?: number | null } | null;
}

type CodexAccount = { type: string; email?: string | null; planType?: string };

interface TurnError {
  message: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string | null;
}

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface RateLimitSnapshot {
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  rateLimitReachedType?: string | null;
}

type Notification = { method: string; params: any };
type ErrorEvent = Extract<ProviderEvent, { type: "error" }>;

// ---------------------------------------------------------------------------
// Runtime per account: one app-server, thread bookkeeping, idle reaping
// ---------------------------------------------------------------------------

interface LoadedThread {
  signature: string;
  lastUsed: number;
  busy: boolean;
}

class CodexRuntime {
  constructor(readonly accountId: string) {}

  private current: CodexAppServer | null = null;
  private starting: Promise<CodexAppServer> | null = null;
  private readonly sinks = new Map<string, (n: Notification) => void>();
  /** Per-thread handlers for MCP elicitations during a turn (approval cards). */
  readonly elicitors = new Map<string, NonNullable<TurnInput["elicit"]>>();
  private readonly globalSinks = new Set<(n: Notification) => void>();
  private reaper: NodeJS.Timeout | null = null;
  private pins = 0;
  private lastUsed = Date.now();
  readonly threads = new Map<string, LoadedThread>();
  /** MCP servers from the account's own config.toml; disabled on TOT threads unless the account's tools are on. */
  userMcpServers: string[] = [];
  models: CodexModel[] | null = null;
  rateLimits: RateLimitSnapshot | null = null;
  statusCache: { key: string; at: number; ttl: number; value: Promise<ProviderStatus> } | null = null;
  pendingLogin: { url: string } | null = null;

  /** The account, looked up on each use so its settings (tools on or off, its name) are current. */
  account(): ProviderAccount {
    const found = accounts.get(this.accountId);
    if (!found) throw new Error("This ChatGPT account was removed. Pick another model.");
    return found;
  }

  async server(): Promise<CodexAppServer> {
    this.lastUsed = Date.now();
    if (this.current?.alive) return this.current;
    this.starting ??= this.spawn().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async spawn(): Promise<CodexAppServer> {
    const account = this.account();
    const binary = binaryFor(account);
    const server = new CodexAppServer({
      label: account.builtIn ? "codex" : `codex:${account.id}`,
      cwd: paths.agentHome,
      config: LOCKDOWN_FLAGS,
      // An account with its own folder signs in, keeps its threads and reads its config.toml there.
      env: account.builtIn ? undefined : { CODEX_HOME: accountDir(account) },
      ...(binary ? { binary: { path: binary, pathDirs: [], source: "env" as const } } : {}),
      clientName: "tot",
      clientVersion: VERSION,
    });
    server.setRequestHandler((method, params) => answerServerRequest(method, params, this.elicitors));
    server.onNotification((method, params) => this.dispatch({ method, params }));
    server.onExit((err) => {
      if (this.current === server) this.current = null;
      this.threads.clear();
      for (const sink of [...this.sinks.values()]) sink({ method: "tot/exit", params: { message: err.message } });
    });
    try {
      await server.start();
    } catch (err) {
      server.kill("SIGKILL");
      throw err;
    }
    try {
      const read = await server.request("config/read", {}, { timeoutMs: 10_000 });
      this.userMcpServers = Object.keys(read?.config?.mcp_servers ?? {});
    } catch {
      this.userMcpServers = [];
    }
    this.current = server;
    this.startReaper();
    return server;
  }

  private dispatch(n: Notification): void {
    if (n.method === "account/rateLimits/updated" && n.params?.rateLimits) {
      this.rateLimits = { ...this.rateLimits, ...stripNulls(n.params.rateLimits) };
    }
    const threadId: unknown = n.params?.threadId ?? n.params?.thread?.id;
    if (typeof threadId === "string") this.sinks.get(threadId)?.(n);
    for (const sink of this.globalSinks) sink(n);
  }

  /** Routes this thread's notifications to `sink` until the returned function is called. */
  subscribe(threadId: string, sink: (n: Notification) => void): () => void {
    this.sinks.set(threadId, sink);
    return () => {
      if (this.sinks.get(threadId) === sink) this.sinks.delete(threadId);
    };
  }

  onGlobal(sink: (n: Notification) => void): () => void {
    this.globalSinks.add(sink);
    return () => this.globalSinks.delete(sink);
  }

  /** Keeps the process alive (e.g. while a browser login is pending). */
  pin(): () => void {
    this.pins++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pins--;
      this.lastUsed = Date.now();
    };
  }

  touch(): void {
    this.lastUsed = Date.now();
  }

  private get idle(): boolean {
    return this.pins === 0 && this.sinks.size === 0 && [...this.threads.values()].every((t) => !t.busy);
  }

  async modelCatalog(server: CodexAppServer, refresh = false): Promise<CodexModel[]> {
    if (this.models && !refresh) return this.models;
    const all: CodexModel[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res: { data?: CodexModel[]; nextCursor?: string | null } = await server.request(
        "model/list",
        { cursor, limit: 100, includeHidden: false },
        { timeoutMs: RPC_TIMEOUT_MS },
      );
      all.push(...(res?.data ?? []));
      cursor = res?.nextCursor ?? null;
      if (!cursor) break;
    }
    this.models = all;
    return all;
  }

  private startReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => this.reap(), 60_000);
    this.reaper.unref();
  }

  private reap(): void {
    const server = this.current;
    if (!server?.alive) return;
    const now = Date.now();
    for (const [threadId, thread] of this.threads) {
      if (thread.busy || this.sinks.has(threadId) || now - thread.lastUsed < THREAD_IDLE_MS) continue;
      this.threads.delete(threadId);
      server.request("thread/unsubscribe", { threadId }, { timeoutMs: 10_000 }).catch(() => {});
    }
    if (this.threads.size === 0 && this.idle && now - this.lastUsed > PROCESS_IDLE_MS) void this.stop();
  }

  async stop(): Promise<void> {
    const server = this.current;
    this.current = null;
    this.threads.clear();
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
    await server?.stop();
  }

  /** Restart on the next use so a fresh process re-reads auth (e.g. after `codex login`). */
  async recycleIfIdle(): Promise<void> {
    if (this.current && this.idle && this.threads.size === 0) await this.stop();
  }
}

const runtimes = new Map<string, CodexRuntime>();

function runtimeFor(accountId: string): CodexRuntime {
  let runtime = runtimes.get(accountId);
  if (!runtime) runtimes.set(accountId, (runtime = new CodexRuntime(accountId)));
  return runtime;
}

/** Stops every account's app-server (tests, shutdown). Safe to call repeatedly. */
export async function stopCodex(): Promise<void> {
  await Promise.all([...runtimes.values()].map((runtime) => runtime.stop()));
}

/** Stops one account's app-server (its folder changed, or it was removed); the next use starts a fresh one. */
export async function stopCodexAccount(accountId: string): Promise<void> {
  const runtime = runtimes.get(accountId);
  runtimes.delete(accountId);
  await runtime?.stop();
}

// ---------------------------------------------------------------------------
// Server -> client requests: never leave one unanswered
// ---------------------------------------------------------------------------

const DECLINE_REASON = "TOT agents don't run commands or edit files on this machine; use the computer tools instead.";

export async function answerServerRequest(
  method: string,
  params: any,
  elicitors: Map<string, NonNullable<TurnInput["elicit"]>>,
): Promise<unknown> {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: { denied: { rejection: DECLINE_REASON } } };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput":
      return { answers: userInputAnswers(params) };
    case "mcpServer/elicitation/request": {
      // During a TOT turn, the user answers on a card in the chat.
      const elicit = typeof params?.threadId === "string" ? elicitors.get(params.threadId) : undefined;
      if (!elicit) return elicitationAnswer(params);
      const answer = await elicit({
        source: String(params.serverName ?? "an app"),
        message: String(params.message ?? ""),
        mode: params.mode === "url" ? "url" : "form",
        url: typeof params.url === "string" ? params.url : undefined,
        schema: params.requestedSchema,
      });
      return { action: answer.action, content: answer.action === "accept" ? (answer.content ?? {}) : null, _meta: null };
    }
    case "item/tool/call":
      return { contentItems: [{ type: "inputText", text: "This tool isn't available in TOT." }], success: false };
    case "currentTime/read":
      return { currentTimeAt: Math.floor(Date.now() / 1000) };
    default:
      throw Object.assign(new Error(`TOT doesn't handle ${method}.`), { code: -32601 });
  }
}

const ACCEPT_OPTION = /^(accept|allow|approve|yes|run|continue|confirm)\b/i;
const REJECT_OPTION = /^(decline|deny|cancel|reject|no)\b/i;

/**
 * App (connector) tool approvals arrive as request_user_input questions with
 * Accept/Decline options: accept those. Anything else is a question for the user,
 * which TOT can't relay mid-turn: answer nothing so the model continues on its own.
 */
export function userInputAnswers(params: any): Record<string, { answers: string[] }> {
  const answers: Record<string, { answers: string[] }> = {};
  for (const question of params?.questions ?? []) {
    const options: { label?: string }[] = question?.options ?? [];
    const accept = options.find((o) => ACCEPT_OPTION.test(o.label ?? ""));
    if (accept?.label && options.some((o) => REJECT_OPTION.test(o.label ?? ""))) {
      answers[question.id] = { answers: [accept.label] };
    }
  }
  return answers;
}

function elicitationAnswer(params: any): unknown {
  const mode = params?.mode;
  const required: unknown[] = Array.isArray(params?.requestedSchema?.required) ? params.requestedSchema.required : [];
  // Tool-call confirmations from MCP servers TOT attached (tot, plugins, apps) carry
  // no fields to fill in: confirm them. URL flows, verification and real forms are cancelled.
  if ((mode === "form" || mode === "openai/form" || mode === "openaiForm") && required.length === 0) {
    return { action: "accept", content: {}, _meta: null };
  }
  return { action: "cancel", content: null, _meta: null };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripNulls<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}

function useConnectedApps(): boolean {
  try {
    return settingsStore.get().chatgpt.useConnectedApps;
  } catch {
    return true;
  }
}

/**
 * Per-thread config (dotted keys merge with the process lockdown flags). The account's own config.toml MCP servers
 * are switched off, or with its tools on kept and pre-approved (approval "never" would reject them otherwise).
 */
export function threadConfig(
  mcpServers: McpServerSpec[],
  apps: boolean,
  account: { userMcpServers: string[]; useAccountTools: boolean } = { userMcpServers: [], useAccountTools: false },
): Record<string, unknown> {
  const config: Record<string, unknown> = { "features.apps": apps };
  // Codex Code Mode hides MCP tools behind one JS `exec` tool (the model first searches
  // ALL_TOOLS, then calls). TOT's own tools and plugins are few and core: expose them as
  // direct function tools, which saves a model round-trip per call. Connected apps
  // (200+ tools) stay behind Code Mode.
  const direct = new Set<string>();
  for (const spec of mcpServers) {
    direct.add(`mcp__${spec.name}`);
    direct.add(`mcp__${spec.name.replace(/[^A-Za-z0-9_]/g, "_")}`);
  }
  if (direct.size) config["features.code_mode.direct_only_tool_namespaces"] = [...direct];
  const ours = new Set(mcpServers.map((s) => s.name));
  for (const name of account.userMcpServers) {
    if (!SAFE_KEY.test(name) || ours.has(name)) continue;
    if (account.useAccountTools) config[`mcp_servers.${name}.default_tools_approval_mode`] = "approve";
    else config[`mcp_servers.${name}.enabled`] = false;
  }
  for (const spec of mcpServers) {
    if (!SAFE_KEY.test(spec.name)) {
      console.warn(`[chatgpt] skipping MCP server with unsupported name: ${spec.name}`);
      continue;
    }
    const key = `mcp_servers.${spec.name}`;
    config[`${key}.enabled`] = true;
    if (spec.type === "http") {
      config[`${key}.url`] = spec.url;
      if (spec.headers && Object.keys(spec.headers).length) config[`${key}.http_headers`] = spec.headers;
      if (spec.disabledTools?.length) config[`${key}.disabled_tools`] = spec.disabledTools;
    } else {
      config[`${key}.command`] = spec.command;
      config[`${key}.args`] = spec.args ?? [];
      if (spec.env && Object.keys(spec.env).length) config[`${key}.env`] = spec.env;
    }
    const isTot = spec.name === "tot";
    config[`${key}.startup_timeout_sec`] = isTot ? 20 : 30;
    config[`${key}.tool_timeout_sec`] = isTot ? TOT_TOOL_TIMEOUT_SEC : PLUGIN_TOOL_TIMEOUT_SEC;
    // TOT has no approval UI and runs with approval_policy "never", under which Codex rejects any
    // tool that still needs approval. TOT's own tools only touch the chat's sandboxed computer and
    // memory, and plugins are ones the user added, so they're pre-approved (as on the Claude side).
    config[`${key}.default_tools_approval_mode`] = "approve";
  }
  return config;
}

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** TOT effort -> a reasoning effort the model supports (never "ultra": that spawns sub-agents). */
export function codexEffort(effort: Effort | string, supported?: string[]): string {
  const options = (supported ?? []).filter((e) => EFFORT_ORDER.includes(e));
  if (!options.length || options.includes(effort)) return effort;
  const at = EFFORT_ORDER.indexOf(effort);
  for (let i = at; i >= 0; i--) if (options.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
  for (let i = at + 1; i < EFFORT_ORDER.length; i++) if (options.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
  return options[0];
}

function supportedEfforts(runtime: CodexRuntime, model: string): string[] | undefined {
  return runtime.models
    ?.find((m) => m.id === model || m.model === model)
    ?.supportedReasoningEfforts?.map((e) => e.reasoningEffort);
}

/** "GPT-6.1-Sol" -> "GPT-6.1 Sol". */
export function modelLabel(model: { id: string; displayName?: string }): string {
  const name = model.displayName?.trim() || model.id;
  return name.replace(/^(GPT-\d+(?:\.\d+)*)-(?=[A-Za-z])/i, "$1 ");
}

const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  promax: "Pro Max",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

function authMethod(account: CodexAccount): string {
  if (account.type === "chatgpt") {
    const plan = String(account.planType ?? "");
    const label =
      PLAN_LABELS[plan] ?? (plan && plan !== "unknown" ? plan.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "");
    return label ? `ChatGPT ${label} plan` : "ChatGPT plan";
  }
  if (account.type === "apiKey") return "OpenAI API key";
  if (account.type === "amazonBedrock") return "Amazon Bedrock";
  return String(account.type);
}

function isRetired(model: CodexModel): boolean {
  const at = model.upgradeInfo?.retirementAt;
  return typeof at === "number" && at * 1000 <= Date.now();
}

function toModelOptions(models: CodexModel[], loggedIn: boolean, account: ProviderAccount): ModelOption[] {
  const visible = models.filter((m) => !m.hidden && !isRetired(m));
  // Default model first: TOT Auto uses models[0] for quick asks.
  visible.sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)));
  return visible.map((m) => {
    const retiring = m.upgradeInfo?.retirementAt;
    const note =
      typeof retiring === "number"
        ? ` Retires ${new Date(retiring * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}.`
        : "";
    return {
      id: `${account.id}:${m.id}`,
      provider: "chatgpt",
      accountId: account.id,
      accountName: account.name,
      model: m.id,
      label: modelLabel(m),
      description: `${(m.description ?? "").trim()}${note}`.trim() || undefined,
      available: loggedIn,
      unavailableReason: loggedIn ? undefined : `Connect ${account.builtIn ? "ChatGPT" : account.name} first`,
    };
  });
}

function formatReset(resetsAt: number | null | undefined): string | null {
  if (!resetsAt) return null;
  const ms = resetsAt * 1000 - Date.now();
  if (ms <= 0) return null;
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} h ${minutes % 60} min`;
  return `on ${new Date(resetsAt * 1000).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

function limitMessage(detail: string | undefined, limits: RateLimitSnapshot | null): string {
  const windows = [limits?.primary, limits?.secondary].filter((w): w is RateLimitWindow => Boolean(w));
  const hit = windows.filter((w) => w.usedPercent >= 100).sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0];
  const when = formatReset(hit?.resetsAt);
  if (when) return `You've hit your ChatGPT plan limit for now. It resets ${when}.`;
  return `You've hit your ChatGPT plan limit for now.${detail ? ` ${detail}` : " Try again later."}`;
}

function errorCode(info: unknown): { code?: string; httpStatus?: number } {
  if (typeof info === "string") return { code: info };
  if (info && typeof info === "object") {
    const [code, value] = Object.entries(info as Record<string, unknown>)[0] ?? [];
    const httpStatus = (value as { httpStatusCode?: unknown } | undefined)?.httpStatusCode;
    return { code, httpStatus: typeof httpStatus === "number" ? httpStatus : undefined };
  }
  return {};
}

/** A Codex turn error -> TOT's fatal error event (friendly limit/auth messages; `limits` says when a limit resets). */
export function turnErrorEvent(error: TurnError | null | undefined, limits: RateLimitSnapshot | null = null): ErrorEvent {
  const message = error?.message?.trim() || "ChatGPT couldn't finish this reply.";
  const { code, httpStatus } = errorCode(error?.codexErrorInfo);
  if (
    code === "usageLimitExceeded" ||
    code === "rateLimitExceeded" ||
    code === "sessionBudgetExceeded" ||
    httpStatus === 429 ||
    /usage limit|rate limit|too many requests|quota/i.test(message)
  ) {
    return { type: "error", message: limitMessage(message, limits), kind: "limit" };
  }
  if (
    code === "unauthorized" ||
    httpStatus === 401 ||
    /\b401\b|unauthori[sz]ed|not logged in|log ?in again|sign in again/i.test(message)
  ) {
    return { type: "error", message: `ChatGPT isn't connected or the login expired. ${LOGIN_HINT}`, kind: "auth" };
  }
  if (code === "contextWindowExceeded") {
    return { type: "error", message: "This chat is too long for the model's context window. Start a new chat to continue.", kind: "turn" };
  }
  return { type: "error", message: error?.additionalDetails ? `${message} (${error.additionalDetails})` : message };
}

function failure(err: unknown, limits: RateLimitSnapshot | null = null): ErrorEvent {
  if (err instanceof CodexRpcError) return turnErrorEvent({ message: err.message }, limits);
  if (err instanceof CodexExitError) return { type: "error", message: `ChatGPT (Codex) stopped unexpectedly. ${err.message}` };
  return { type: "error", message: err instanceof Error ? err.message : String(err) };
}

/** MCP tool name as TOT shows it: bare for "tot", "<app>/<tool>" for apps, "<server>/<tool>" otherwise. */
export function mcpToolName(item: { server: string; tool: string; appContext?: { appName?: string | null } | null }): string {
  const { server, tool } = item;
  if (server === "tot") return tool;
  if (server === "codex_apps") {
    const dot = tool.indexOf(".");
    if (dot > 0) return `${tool.slice(0, dot)}/${tool.slice(dot + 1)}`;
    const appName = item.appContext?.appName?.trim();
    if (appName) {
      const app = appName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      const bare = tool.startsWith(`${app}_`) ? tool.slice(app.length + 1) : tool;
      return `${app}/${bare}`;
    }
    return `apps/${tool}`;
  }
  return `${server}/${tool}`;
}

/** Joins an MCP result's text blocks into the tool card output. */
export function mcpOutput(item: any): { output?: string; isError: boolean } {
  if (item?.error?.message) return { output: String(item.error.message), isError: true };
  const blocks: any[] = Array.isArray(item?.result?.content) ? item.result.content : [];
  const text = blocks
    .map((block) => {
      if (block?.type === "text") return String(block.text ?? "");
      if (block?.type === "image") return "[image]";
      if (block?.type === "audio") return "[audio]";
      if (block?.type === "resource") return String(block.resource?.text ?? block.resource?.uri ?? "[resource]");
      if (block?.type === "resource_link") return String(block.uri ?? "[resource]");
      return JSON.stringify(block);
    })
    .join("\n");
  const output = text || (item?.result?.structuredContent != null ? JSON.stringify(item.result.structuredContent) : undefined);
  return { output, isError: item?.status === "failed" || item?.result?.isError === true };
}

function webSearchTool(item: any): { name: string; input: Record<string, unknown> } {
  const action = item?.action ?? null;
  if (action?.type === "open_page" || action?.type === "find_in_page") {
    return { name: "web_fetch", input: stripNulls({ url: action.url, pattern: action.pattern }) };
  }
  const queries: string[] | undefined = action?.queries;
  const query = item?.query || action?.query || queries?.[0] || undefined;
  return { name: "web_search", input: stripNulls({ query, queries: queries && queries.length > 1 ? queries : undefined }) };
}

function webSearchOutput(item: any): string | undefined {
  const results: any[] = Array.isArray(item?.results) ? item.results : [];
  const lines = results
    .map((r) => [r?.title, r?.url].filter(Boolean).join(" — "))
    .filter(Boolean)
    .slice(0, 10);
  return lines.length ? lines.join("\n") : undefined;
}

// ---------------------------------------------------------------------------
// Turn event mapping
// ---------------------------------------------------------------------------

type TurnOutcome = { done: false } | { done: true; error?: ErrorEvent };

export class TurnMapper {
  private readonly streamed = new Map<string, number>();
  private readonly summarized = new Set<string>();
  private readonly toolsOpen = new Set<string>();
  private baseline: { input: number; output: number } | null = null;
  private lastError: TurnError | null = null;
  usage: Usage = {};

  constructor(
    private readonly startedAt: number,
    private readonly limits: () => RateLimitSnapshot | null = () => null,
  ) {}

  map(n: Notification, out: ProviderEvent[]): TurnOutcome {
    const p = n.params ?? {};
    switch (n.method) {
      case "item/agentMessage/delta": {
        if (!p.delta) break;
        this.streamed.set(p.itemId, (this.streamed.get(p.itemId) ?? 0) + p.delta.length);
        out.push({ type: "text-delta", blockId: p.itemId, delta: p.delta });
        break;
      }
      case "item/reasoning/summaryTextDelta": {
        if (!p.delta) break;
        this.summarized.add(p.itemId);
        out.push({ type: "reasoning-delta", blockId: `${p.itemId}:${p.summaryIndex ?? 0}`, delta: p.delta });
        break;
      }
      case "item/started":
        this.itemStarted(p.item, out);
        break;
      case "item/completed":
        this.itemCompleted(p.item, out);
        break;
      case "thread/tokenUsage/updated": {
        const total = p.tokenUsage?.total;
        const last = p.tokenUsage?.last;
        if (!total) break;
        // `total` is cumulative for the thread; report this turn's share.
        this.baseline ??= {
          input: total.inputTokens - (last?.inputTokens ?? 0),
          output: total.outputTokens - (last?.outputTokens ?? 0),
        };
        this.usage = {
          inputTokens: Math.max(0, total.inputTokens - this.baseline.input),
          outputTokens: Math.max(0, total.outputTokens - this.baseline.output),
        };
        out.push({ type: "usage", usage: { ...this.usage } });
        break;
      }
      case "error": {
        if (!p.willRetry && p.error) this.lastError = p.error;
        break;
      }
      case "turn/completed": {
        const turn = p.turn ?? {};
        const durationMs = typeof turn.durationMs === "number" ? turn.durationMs : Date.now() - this.startedAt;
        this.usage = { ...this.usage, durationMs };
        out.push({ type: "usage", usage: { ...this.usage } });
        this.closeTools(out, turn.status === "interrupted" ? "Stopped." : undefined);
        if (turn.status === "failed") return { done: true, error: turnErrorEvent(turn.error ?? this.lastError, this.limits()) };
        return { done: true };
      }
      case "tot/exit":
        return { done: true, error: { type: "error", message: `ChatGPT (Codex) stopped unexpectedly. ${p.message ?? ""}`.trim() } };
    }
    return { done: false };
  }

  private itemStarted(item: any, out: ProviderEvent[]): void {
    if (!item?.id) return;
    const tool = toolStart(item);
    if (!tool) return;
    this.toolsOpen.add(item.id);
    out.push({ type: "tool-start", toolCallId: item.id, name: tool.name, input: tool.input });
  }

  private itemCompleted(item: any, out: ProviderEvent[]): void {
    if (!item?.id) return;
    if (item.type === "agentMessage") {
      // Deltas are the fast path; emit whatever they missed (or everything, if none came).
      const text: string = item.text ?? "";
      const sent = this.streamed.get(item.id) ?? 0;
      if (text.length > sent) out.push({ type: "text-delta", blockId: item.id, delta: text.slice(sent) });
      return;
    }
    if (item.type === "reasoning") {
      if (this.summarized.has(item.id)) return;
      (item.summary ?? []).forEach((part: string, index: number) => {
        if (part) out.push({ type: "reasoning-delta", blockId: `${item.id}:${index}`, delta: part });
      });
      return;
    }
    const tool = toolStart(item);
    if (!tool) return;
    // Re-emit the start: web search queries and final arguments are only complete now.
    out.push({ type: "tool-start", toolCallId: item.id, name: tool.name, input: tool.input });
    out.push({ type: "tool-end", toolCallId: item.id, ...toolEnd(item) });
    this.toolsOpen.delete(item.id);
  }

  private closeTools(out: ProviderEvent[], output?: string): void {
    for (const id of this.toolsOpen) out.push({ type: "tool-end", toolCallId: id, output: output ?? "Did not finish.", isError: true });
    this.toolsOpen.clear();
  }
}

function toolStart(item: any): { name: string; input?: unknown } | null {
  switch (item?.type) {
    case "mcpToolCall":
      return { name: mcpToolName(item), input: item.arguments ?? undefined };
    case "webSearch":
      return webSearchTool(item);
    case "dynamicToolCall":
      return { name: item.namespace ? `${item.namespace}/${item.tool}` : item.tool, input: item.arguments ?? undefined };
    // Locked down, so these shouldn't happen; surface them rather than hide them.
    case "commandExecution":
      return { name: "shell", input: { command: item.command, cwd: item.cwd } };
    case "fileChange":
      return {
        name: "apply_patch",
        input: { changes: (item.changes ?? []).map((c: any) => ({ path: c.path, kind: c.kind?.type ?? c.kind })) },
      };
    case "collabAgentToolCall":
      return { name: `agents/${item.tool}`, input: item.prompt ? { prompt: item.prompt } : undefined };
    case "imageGeneration":
      return { name: "image_generation", input: undefined };
    default:
      return null;
  }
}

function toolEnd(item: any): { output?: string; isError?: boolean } {
  switch (item?.type) {
    case "mcpToolCall":
      return mcpOutput(item);
    case "webSearch":
      return { output: webSearchOutput(item), isError: false };
    case "dynamicToolCall": {
      const text = (item.contentItems ?? []).map((c: any) => c?.text ?? "").filter(Boolean).join("\n");
      return { output: text || undefined, isError: item.success === false || item.status === "failed" };
    }
    case "commandExecution":
      return {
        output: item.aggregatedOutput ?? (item.status === "declined" ? "Blocked: commands can't run on this machine." : undefined),
        isError: item.status !== "completed" || (item.exitCode ?? 0) !== 0,
      };
    case "fileChange":
      return {
        output: item.status === "completed" ? "Applied." : "Blocked: files on this machine are read-only.",
        isError: item.status !== "completed",
      };
    default:
      return { isError: item?.status === "failed" };
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

async function loadStatus(runtime: CodexRuntime): Promise<ProviderStatus> {
  const owner = runtime.account();
  const base = { id: "chatgpt" as const, accountId: owner.id, label: owner.builtIn ? "ChatGPT" : owner.name };
  if (!binaryFor(owner) && !resolveCodexBinary()) {
    return {
      ...base,
      installed: false,
      loggedIn: false,
      detail: "Codex CLI not found. Install it with `npm i -g @openai/codex` (or `brew install codex`), then run `codex login`.",
      models: [],
    };
  }
  let server: CodexAppServer;
  try {
    server = await runtime.server();
  } catch (err) {
    return {
      ...base,
      installed: false,
      loggedIn: false,
      detail: `Couldn't start Codex: ${err instanceof Error ? err.message : String(err)}`,
      models: [],
    };
  }
  const [accountRes, models] = await Promise.all([
    server.request<{ account: CodexAccount | null }>("account/read", { refreshToken: false }, { timeoutMs: RPC_TIMEOUT_MS }),
    runtime.modelCatalog(server, true).catch(() => [] as CodexModel[]),
  ]);
  const account = accountRes?.account ?? null;
  const loggedIn = Boolean(account);
  if (!loggedIn) void runtime.recycleIfIdle();
  return {
    ...base,
    installed: true,
    loggedIn,
    authMethod: account ? authMethod(account) : undefined,
    account: account?.type === "chatgpt" ? (account.email ?? undefined) : undefined,
    detail: loggedIn ? undefined : `${base.label} isn't connected. ${owner.builtIn ? LOGIN_HINT : "Use Sign in on its row in Settings → Models & accounts."}`,
    models: toModelOptions(models, loggedIn, owner),
  };
}

async function startLogin(runtime: CodexRuntime): Promise<{ url: string }> {
  if (runtime.pendingLogin) return { url: runtime.pendingLogin.url };
  const server = await runtime.server();
  const release = runtime.pin();
  let res: { loginId: string; authUrl: string };
  try {
    res = await server.request("account/login/start", { type: "chatgpt" }, { timeoutMs: RPC_TIMEOUT_MS });
  } catch (err) {
    release();
    throw err;
  }
  // The app-server hosts the OAuth callback: keep it alive until the login finishes.
  let timer: NodeJS.Timeout | undefined;
  const finish = () => {
    clearTimeout(timer);
    offGlobal();
    offExit();
    release();
    runtime.pendingLogin = null;
    runtime.statusCache = null;
  };
  const offGlobal = runtime.onGlobal((n) => {
    if (n.method === "account/login/completed" && (!n.params?.loginId || n.params.loginId === res.loginId)) finish();
  });
  const offExit = server.onExit(finish);
  timer = setTimeout(() => {
    server.request("account/login/cancel", { loginId: res.loginId }, { timeoutMs: 5_000 }).catch(() => {});
    finish();
  }, LOGIN_TIMEOUT_MS);
  timer.unref();
  runtime.pendingLogin = { url: res.authUrl };
  return { url: res.authUrl };
}

async function openThread(
  runtime: CodexRuntime,
  server: CodexAppServer,
  input: TurnInput,
  config: Record<string, unknown>,
  signature: string,
): Promise<string> {
  const common = {
    model: input.model,
    cwd: input.workDir,
    approvalPolicy: "never",
    sandbox: "read-only",
    baseInstructions: input.systemPrompt,
    config,
  };
  if (input.sessionId) {
    const threadId = input.sessionId;
    const loaded = runtime.threads.get(threadId);
    if (loaded?.busy) throw new Error("ChatGPT is still working on the previous reply in this chat.");
    if (loaded && loaded.signature === signature) return threadId;
    if (loaded) {
      // Config (plugins, connected apps) changed: unload so the resume applies it.
      runtime.threads.delete(threadId);
      await server.request("thread/unsubscribe", { threadId }, { timeoutMs: RPC_TIMEOUT_MS }).catch(() => {});
    }
    try {
      await server.request("thread/resume", { threadId, ...common, excludeTurns: true }, { timeoutMs: RPC_TIMEOUT_MS });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Couldn't resume the ChatGPT conversation (${reason}).`);
    }
    runtime.threads.set(threadId, { signature, lastUsed: Date.now(), busy: false });
    return threadId;
  }
  const { method, params } = newThreadRequest(input, common);
  const started = await server.request<{ thread: { id: string } }>(method, params, { timeoutMs: RPC_TIMEOUT_MS });
  const threadId = started.thread.id;
  runtime.threads.set(threadId, { signature, lastUsed: Date.now(), busy: false });
  return threadId;
}

/** A turn without a thread to resume: a new thread, or for a fork's first turn a fork of another thread through turn `at`. */
export function newThreadRequest(
  input: Pick<TurnInput, "fork">,
  common: Record<string, unknown>,
): { method: "thread/start" | "thread/fork"; params: Record<string, unknown> } {
  if (input.fork) {
    return { method: "thread/fork", params: { threadId: input.fork.sessionId, ...(input.fork.at ? { lastTurnId: input.fork.at } : {}), ...common, excludeTurns: true } };
  }
  return { method: "thread/start", params: { ...common, serviceName: "tot" } };
}

/** Buffers notifications so the async generator can pull them in order. */
class NotificationQueue {
  private readonly items: Notification[] = [];
  private waiter: ((n: Notification) => void) | null = null;

  push(n: Notification): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter(n);
    } else {
      this.items.push(n);
    }
  }

  next(): Promise<Notification> {
    const item = this.items.shift();
    if (item) return Promise.resolve(item);
    return new Promise((resolve) => (this.waiter = resolve));
  }
}

async function* runTurn(runtime: CodexRuntime, input: TurnInput): AsyncGenerator<ProviderEvent> {
  if (input.signal.aborted) return;
  let server: CodexAppServer;
  let account: ProviderAccount;
  try {
    account = runtime.account();
    server = await runtime.server();
    if (!runtime.models) await runtime.modelCatalog(server).catch(() => {});
  } catch (err) {
    yield failure(err);
    return;
  }

  const config = threadConfig(input.mcpServers, useConnectedApps(), { userMcpServers: runtime.userMcpServers, useAccountTools: account.useAccountTools });
  const signature = JSON.stringify({ config, system: input.systemPrompt });
  let threadId: string;
  try {
    threadId = await openThread(runtime, server, input, config, signature);
  } catch (err) {
    yield failure(err, runtime.rateLimits);
    return;
  }
  yield { type: "session", sessionId: threadId };
  if (input.signal.aborted) return;

  const thread = runtime.threads.get(threadId);
  if (thread) thread.busy = true;
  const queue = new NotificationQueue();
  const unsubscribeNotifications = runtime.subscribe(threadId, (n) => queue.push(n));
  if (input.elicit) runtime.elicitors.set(threadId, input.elicit);
  const unsubscribe = () => {
    unsubscribeNotifications();
    if (runtime.elicitors.get(threadId) === input.elicit) runtime.elicitors.delete(threadId);
  };
  const mapper = new TurnMapper(Date.now(), () => runtime.rateLimits);
  let turnId: string | null = null;
  let finished = false;
  let abortTimer: NodeJS.Timeout | undefined;

  const interrupt = () => {
    if (!turnId || finished) return;
    server.request("turn/interrupt", { threadId, turnId }, { timeoutMs: ABORT_GRACE_MS }).catch(() => {});
    abortTimer ??= setTimeout(() => queue.push({ method: "tot/abort-timeout", params: { threadId } }), ABORT_GRACE_MS);
  };
  input.signal.addEventListener("abort", interrupt, { once: true });

  try {
    try {
      const res = await server.request<{ turn: { id: string } }>(
        "turn/start",
        {
          threadId,
          input: [
            { type: "text", text: input.prompt, text_elements: [] },
            ...(input.images ?? []).map((image) => ({ type: "localImage", path: image.path })),
          ],
          model: input.model,
          effort: codexEffort(input.effort, supportedEfforts(runtime, input.model)),
          summary: "auto",
          cwd: input.workDir,
        },
        { timeoutMs: RPC_TIMEOUT_MS },
      );
      turnId = res.turn.id;
      // Where a fork from this reply would stop (thread/fork's lastTurnId).
      yield { type: "ref", ref: turnId };
    } catch (err) {
      finished = true;
      if (!input.signal.aborted) yield failure(err, runtime.rateLimits);
      return;
    }
    if (input.signal.aborted) interrupt();
    // Steering: Codex takes more input for the turn in flight (turn/steer); it fails once the turn is over.
    input.onSteerable?.(async (text) => {
      if (!turnId || finished || input.signal.aborted) return false;
      try {
        await server.request(
          "turn/steer",
          { threadId, expectedTurnId: turnId, input: [{ type: "text", text, text_elements: [] }] },
          { timeoutMs: RPC_TIMEOUT_MS },
        );
        return true;
      } catch {
        return false;
      }
    });

    const out: ProviderEvent[] = [];
    while (true) {
      const n = await queue.next();
      if (n.method === "tot/abort-timeout") return;
      const nTurn = n.params?.turnId ?? n.params?.turn?.id;
      if (nTurn && nTurn !== turnId) continue; // a stale event from an earlier turn
      const outcome = mapper.map(n, out);
      for (const event of out.splice(0)) yield event;
      if (outcome.done) {
        finished = true;
        if (outcome.error && !input.signal.aborted) yield outcome.error;
        return;
      }
    }
  } finally {
    input.signal.removeEventListener("abort", interrupt);
    clearTimeout(abortTimer);
    if (!finished && turnId) {
      // The consumer stopped early: don't leave the turn running on the plan.
      server.request("turn/interrupt", { threadId, turnId }, { timeoutMs: ABORT_GRACE_MS }).catch(() => {});
    }
    unsubscribe();
    const loaded = runtime.threads.get(threadId);
    if (loaded) {
      loaded.busy = false;
      loaded.lastUsed = Date.now();
    }
    runtime.touch();
  }
}

/** Fast model for light tasks: the newest "luna" model, else the default. */
function lightModel(runtime: CodexRuntime): string | undefined {
  const models = (runtime.models ?? []).filter((m) => !m.hidden && !isRetired(m));
  return (models.find((m) => /luna/i.test(m.id)) ?? models.find((m) => m.isDefault) ?? models[0])?.id;
}

async function complete(runtime: CodexRuntime, prompt: string, opts: { model?: string; system?: string; signal?: AbortSignal } = {}): Promise<string> {
  const server = await runtime.server();
  if (!runtime.models) await runtime.modelCatalog(server).catch(() => {});
  const model = opts.model ?? lightModel(runtime);
  const config = { ...threadConfig([], false), web_search: "disabled" };
  const started = await server.request<{ thread: { id: string } }>(
    "thread/start",
    {
      model,
      cwd: paths.agentHome,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions:
        opts.system ?? "You are a helpful assistant. Follow the instructions exactly and reply with only what is asked for.",
      config,
      serviceName: "tot",
    },
    { timeoutMs: RPC_TIMEOUT_MS, signal: opts.signal },
  );
  const threadId = started.thread.id;
  const queue = new NotificationQueue();
  const unsubscribe = runtime.subscribe(threadId, (n) => queue.push(n));
  let turnId: string | null = null;
  const onAbort = () => {
    if (turnId) server.request("turn/interrupt", { threadId, turnId }, { timeoutMs: 5_000 }).catch(() => {});
    queue.push({ method: "tot/aborted", params: {} });
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await server.request<{ turn: { id: string } }>(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        model,
        effort: codexEffort("low", model ? supportedEfforts(runtime, model) : undefined),
        summary: "none",
      },
      { timeoutMs: RPC_TIMEOUT_MS, signal: opts.signal },
    );
    turnId = res.turn.id;
    if (opts.signal?.aborted) onAbort();
    const messages = new Map<string, { text: string; final: boolean }>();
    while (true) {
      const n = await queue.next();
      if (n.method === "tot/aborted") throw opts.signal?.reason instanceof Error ? opts.signal.reason : new Error("Aborted");
      if (n.method === "tot/exit") throw new CodexExitError(n.params?.message ?? "Codex stopped.");
      if (n.method === "item/completed" && n.params?.item?.type === "agentMessage") {
        messages.set(n.params.item.id, { text: n.params.item.text ?? "", final: n.params.item.phase === "final_answer" });
      }
      if (n.method === "turn/completed" && (n.params?.turn?.id ?? turnId) === turnId) {
        const turn = n.params.turn;
        if (turn.status === "failed") throw new Error(turnErrorEvent(turn.error).message);
        const all = [...messages.values()];
        const finals = all.filter((m) => m.final);
        return (finals.length ? finals : all).map((m) => m.text).join("\n").trim();
      }
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    server.request("thread/unsubscribe", { threadId }, { timeoutMs: 5_000 }).catch(() => {});
    runtime.touch();
  }
}

/** Codex on one provider account: its own app-server, sign-in and status. */
export function makeChatgptProvider(accountId: string): AgentProvider {
  const runtime = runtimeFor(accountId);
  return {
    id: "chatgpt",
    get label() {
      const found = accounts.get(accountId);
      return !found || found.builtIn ? "ChatGPT" : found.name;
    },

    status() {
      const now = Date.now();
      const account = runtime.account();
      const key = JSON.stringify([account.configDir, account.binaryPath, account.name]);
      const cached = runtime.statusCache;
      if (cached && cached.key === key && now - cached.at < cached.ttl) return cached.value;
      const entry = { key, at: now, ttl: STATUS_TTL_MS, value: loadStatus(runtime) };
      runtime.statusCache = entry;
      entry.value.then(
        (status) => {
          if (!status.loggedIn) entry.ttl = STATUS_TTL_LOGGED_OUT_MS;
        },
        () => {
          if (runtime.statusCache === entry) runtime.statusCache = null;
        },
      );
      return entry.value;
    },

    runTurn: (input) => runTurn(runtime, input),
    complete: (prompt, opts) => complete(runtime, prompt, opts),

    login() {
      return startLogin(runtime);
    },
  };
}

/** The built-in ChatGPT account (the default ~/.codex login). */
export const chatgptProvider: AgentProvider = makeChatgptProvider("chatgpt");
