import {
  query,
  type AccountInfo,
  type McpServerConfig,
  type ModelInfo,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ModelOption, ProviderAccount, ProviderStatus, TurnErrorKind, Usage } from "@tot/shared/types";
import { accountDir, accounts, binaryFor, tildePath } from "../../accounts/accounts.ts";
import { claudeAuthEnv, claudeMcpServers, claudePlugins, claudeSettingsEnv, mergeMcpServers } from "../../accounts/config.ts";
import { getSecret, paths } from "../../config.ts";
import { settings } from "../../data/settings.ts";
import { CHANGING_TOOLS, PLAN_REFUSAL, PLAN_WORKFLOW } from "../../chats/plan.ts";
import { CLAUDE_OPUS, CLAUDE_SONNET } from "../router.ts";
import type { AgentProvider, McpServerSpec, ProviderEvent, TurnInput } from "./types.ts";

const FABLE = "claude-fable-5-1";
const MAX_AGENT_TURNS = 80;
/** TOT's computer_exec may run for up to 10 minutes. */
const TOT_TOOL_TIMEOUT_MS = 11 * 60_000;
const STATUS_TTL_MS = 5 * 60_000;
const STATUS_RETRY_MS = 30_000;
const STATUS_PROBE_TIMEOUT_MS = 20_000;

const LOGIN_HINT = "Run `claude` in a terminal and use /login with your Claude subscription.";

/** How to sign in an account with its own folder: Claude Code started on that folder. */
export function loginCommand(account: Pick<ProviderAccount, "driver" | "configDir">): string {
  return `CLAUDE_CONFIG_DIR=${tildePath(accountDir(account))} claude`;
}

function loginHint(account: ProviderAccount): string {
  return account.builtIn ? LOGIN_HINT : `Run \`${loginCommand(account)}\` in a terminal and use /login.`;
}

// ---------------------------------------------------------------------------
// Environment for the Claude Code child process. `env` replaces the child's
// environment entirely, so start from process.env and drop what must not leak:
// session plumbing from any parent Claude Code session, and (in subscription
// mode) API credentials/proxies that would shadow the local login.
//
// An account with its own folder runs Claude Code on that folder
// (CLAUDE_CONFIG_DIR) with the `env` block of its settings.json on top: that's
// how a CCS-proxy account reaches its proxy, since TOT never lets Claude Code
// read settings files itself (settingSources: []).
// ---------------------------------------------------------------------------

const SESSION_VARS = /^(CLAUDECODE|CLAUDE_CODE_\w+|CLAUDE_PID|CLAUDE_AGENT_SDK_VERSION|CLAUDE_EFFORT|CLAUDE_CONFIG_DIR)$/;
const AUTH_VARS =
  /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_MODEL|ANTHROPIC_SMALL_FAST_MODEL|ANTHROPIC_DEFAULT_\w+_MODEL)$/;

export function buildEnv(account: ProviderAccount | null = accounts.get("claude")): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SESSION_VARS.test(key) && !AUTH_VARS.test(key)) env[key] = value;
  }
  if (account && !account.builtIn) {
    env.CLAUDE_CONFIG_DIR = accountDir(account);
    Object.assign(env, claudeSettingsEnv(account));
    return env;
  }
  if (process.env.TOT_CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.TOT_CLAUDE_CONFIG_DIR;
  if (settings.get().claude.authMode === "api-key") {
    const key = getSecret("anthropicApiKey");
    if (key) env.ANTHROPIC_API_KEY = key;
  }
  return env;
}

/** Options every TOT query shares: isolated from the user's personal Claude Code config. */
function baseOptions(controller: AbortController, account: ProviderAccount): Options {
  const executable = binaryFor(account);
  return {
    env: buildEnv(account),
    cwd: paths.agentHome,
    // Don't load the user's CLAUDE.md / settings / plugins: measured ~40x token cost otherwise.
    settingSources: [],
    abortController: controller,
    ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
  };
}

/**
 * The MCP servers and plugins a turn gets on an account: TOT's (always), plus with the account's tools on its own
 * MCP servers (TOT's win a name clash) and its enabled plugins, which the SDK loads from their install folders.
 */
export function accountTools(account: ProviderAccount, tot: McpServerSpec[]): { servers: McpServerSpec[]; plugins: { type: "local"; path: string }[] } {
  if (!account.useAccountTools) return { servers: tot, plugins: [] };
  return {
    servers: mergeMcpServers(tot, claudeMcpServers(account), true),
    plugins: claudePlugins(account).map((plugin) => ({ type: "local" as const, path: plugin.path })),
  };
}

/**
 * MCP servers for the SDK. The SDK hands these to Claude Code on its command line, which
 * other processes can read, so header values (bearer tokens) go into the child's environment
 * and the config only names them: Claude Code expands `${VAR}` in headers.
 */
function toSdkMcpServers(specs: McpServerSpec[]): { servers: Record<string, McpServerConfig>; env: Record<string, string> } {
  const env: Record<string, string> = {};
  const servers = Object.fromEntries(
    specs.map((spec, i): [string, McpServerConfig] => {
      if (spec.type !== "http") return [spec.name, { type: "stdio", command: spec.command, args: spec.args ?? [], env: spec.env }];
      const headers = Object.fromEntries(
        Object.entries(spec.headers ?? {}).map(([name, value], j) => {
          const variable = `TOT_MCP_HEADER_${i}_${j}`;
          env[variable] = value;
          return [name, `\${${variable}}`];
        }),
      );
      return [spec.name, { type: "http", url: spec.url, headers, ...(spec.name === "tot" ? { timeout: TOT_TOOL_TIMEOUT_MS } : {}) }];
    }),
  );
  return { servers, env };
}

/** mcp__tot__computer_exec → computer_exec, mcp__github__create_issue → github/create_issue. */
export function normalizeToolName(name: string): string {
  if (name === "WebSearch") return "web_search";
  if (name === "WebFetch") return "web_fetch";
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!match) return name;
  const [, server, tool] = match;
  return server === "tot" ? tool : `${server.replace(/^claude_ai_/, "")}/${tool}`;
}

type ToolResultContent = string | { type: string; text?: string }[] | undefined;

function toolResultText(content: ToolResultContent): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`)).join("\n");
}

type TurnFailure = { message: string; kind?: TurnErrorKind };

function friendlyError(code: string, model: string): TurnFailure {
  switch (code) {
    case "rate_limit":
      return { kind: "limit", message: "You've hit your Claude usage limit for now." };
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return { kind: "auth", message: `Claude isn't logged in. ${LOGIN_HINT}` };
    case "billing_error":
    case "account_on_hold":
      return { message: "Claude reported a billing problem with your account." };
    case "model_not_found":
      return { message: `Claude doesn't offer ${model} on this account.` };
    case "overloaded":
      return { message: "Claude is overloaded right now. Try again in a moment." };
    case "max_output_tokens":
      return { message: "The reply hit Claude's maximum output length." };
    default:
      return { message: `Claude request failed (${code}).` };
  }
}

/** Usage-limit text as the CLI reports it, e.g. "You've hit your weekly limit · resets 7:30am". */
const LIMIT_TEXT = /hit your .*limit|usage limit|rate.?limit|limit reached|limit · resets|out of (extra )?usage/i;
const AUTH_TEXT = /not logged in|please (run )?\/?login|invalid api key|authentication/i;

function classify(message: string): TurnFailure {
  if (LIMIT_TEXT.test(message)) return { kind: "limit", message };
  if (AUTH_TEXT.test(message)) return { kind: "auth", message: `${message} ${LOGIN_HINT}` };
  return { message };
}

/** Keeps the last few KB of the child's stderr for error messages. */
class Tail {
  private text = "";
  push(chunk: string) {
    this.text = (this.text + chunk).slice(-4096);
  }
  lastLine(): string {
    return this.text.trim().split("\n").pop()?.trim() ?? "";
  }
}

/** A prompt stream that never sends anything: lets us ask the CLI questions without spending tokens. */
async function* silentPrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** The turn's opening user message: the user's images alongside their text. */
function openingMessage(input: TurnInput): SDKUserMessage {
  return {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        ...(input.images ?? []).map((image) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: image.mimeType as ImageType, data: readFileSync(image.path).toString("base64") },
        })),
        { type: "text" as const, text: input.prompt },
      ],
    },
  };
}

/** A one-message prompt stream carrying the user's images alongside their text. */
async function* withImages(input: TurnInput): AsyncGenerator<SDKUserMessage> {
  yield openingMessage(input);
}

/**
 * A prompt stream that stays open for the whole turn, so notes can be added while it runs
 * (steering): Claude Code folds a queued message into the running turn at its next step, or
 * runs it right after the turn when the turn ends first.
 */
class PromptStream implements AsyncIterable<SDKUserMessage> {
  private readonly queued: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(message: SDKUserMessage): void {
    this.queued.push(message);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const next = this.queued.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

/**
 * Which session a turn continues: its own, or for a fork's first turn a copy of another session
 * (forkSession), cut after the message `at` (resumeSessionAt) when given.
 */
export function resumeOptions(input: Pick<TurnInput, "sessionId" | "fork">): { resume?: string; forkSession?: boolean; resumeSessionAt?: string } {
  if (input.fork) return { resume: input.fork.sessionId, forkSession: true, ...(input.fork.at ? { resumeSessionAt: input.fork.at } : {}) };
  return { resume: input.sessionId };
}

/** After a turn ends with a steering note still queued, how long to wait for Claude Code to start on it. */
const QUEUED_NOTE_WAIT_MS = 5_000;

// total_cost_usd is cumulative per session, so remember the last total to report per-turn cost.
const lastSessionCost = new Map<string, number>();

// ---------------------------------------------------------------------------
// Status & models
// ---------------------------------------------------------------------------

function modelOptions(available: boolean, supported: ModelInfo[], account: ProviderAccount): ModelOption[] {
  const reason = available ? undefined : `${account.builtIn ? "Claude" : account.name} isn't connected`;
  const option = (model: string, label: string, description: string): ModelOption => ({
    id: `${account.id}:${model}`,
    provider: "claude",
    accountId: account.id,
    accountName: account.name,
    model,
    label,
    description,
    available,
    unavailableReason: reason,
  });
  const options = [
    option(CLAUDE_OPUS, "Claude Opus 5.5", "Deepest reasoning for complex work"),
    option(CLAUDE_SONNET, "Claude Sonnet 5.5", "Fast and capable for everyday tasks"),
  ];
  if (supported.some((m) => m.value === FABLE || m.resolvedModel === FABLE)) {
    options.push(option(FABLE, "Claude Fable 5.1", "Anthropic's most capable model — slower, uses more of your plan"));
  }
  return options;
}

async function loadStatus(account: ProviderAccount): Promise<ProviderStatus> {
  const base = { id: "claude" as const, accountId: account.id, label: account.builtIn ? "Claude" : account.name, installed: true };
  const hint = loginHint(account);
  const { proxy, hasAuth } = account.builtIn ? { proxy: false, hasAuth: false } : claudeAuthEnv(claudeSettingsEnv(account));

  if (account.builtIn && settings.get().claude.authMode === "api-key") {
    const hasKey = Boolean(getSecret("anthropicApiKey"));
    return {
      ...base,
      loggedIn: hasKey,
      authMethod: "API key",
      detail: hasKey ? undefined : "Add an Anthropic API key in Settings → Models & accounts, or switch back to your subscription.",
      models: modelOptions(hasKey, [], account),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_PROBE_TIMEOUT_MS);
  const probe = query({
    prompt: silentPrompt(controller.signal),
    // A status check needs no MCP servers: don't start any the folder's own config lists.
    options: { ...baseOptions(controller, account), tools: [], persistSession: false, strictMcpConfig: true },
  });
  try {
    const [info, supported] = await Promise.all([probe.accountInfo(), probe.supportedModels()]);
    // A proxy account (its env block sets a base URL and token) has no claude.ai login to report: the token is it.
    const loggedIn = Boolean(info.subscriptionType || info.email || hasAuth);
    return {
      ...base,
      loggedIn,
      authMethod: loggedIn ? (proxy && !info.subscriptionType ? "Through a proxy" : subscriptionLabel(info)) : undefined,
      account: info.email,
      detail: loggedIn ? undefined : hint,
      models: modelOptions(loggedIn, supported, account),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      installed: !/ENOENT|spawn/i.test(message),
      loggedIn: false,
      detail: controller.signal.aborted ? `Claude Code didn't respond. ${hint}` : `${message}. ${hint}`,
      models: modelOptions(false, [], account),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    probe.close();
  }
}

function subscriptionLabel(account: AccountInfo): string {
  if (account.subscriptionType) {
    const plan = account.subscriptionType.replace(/^claude\s+/i, "");
    return `Claude ${plan} subscription`;
  }
  return account.apiProvider && account.apiProvider !== "firstParty" ? `Claude via ${account.apiProvider}` : "Claude login";
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Claude Code on one provider account. The account is looked up on every use, so a rename or a tools toggle applies
 * to the next turn; its status is cached per folder and setting, so a changed folder is checked again.
 */
export function makeClaudeProvider(accountId: string): AgentProvider {
  let statusCache: { key: string; expiresAt: number; value: Promise<ProviderStatus> } | null = null;
  const account = (): ProviderAccount => {
    const found = accounts.get(accountId);
    if (!found) throw new Error("This Claude account was removed. Pick another model.");
    return found;
  };

  return {
    id: "claude",
    get label() {
      const found = accounts.get(accountId);
      return !found || found.builtIn ? "Claude" : found.name;
    },

    status() {
      const current = account();
      const key = JSON.stringify([current.configDir, current.binaryPath, current.name, current.builtIn && settings.get().claude.authMode]);
      if (!statusCache || statusCache.key !== key || Date.now() > statusCache.expiresAt) {
        const value = loadStatus(current);
        const entry = { key, expiresAt: Date.now() + STATUS_TTL_MS, value };
        statusCache = entry;
        // Don't pin a failed check for the full TTL.
        void value.then((status) => {
          if (!status.loggedIn && statusCache === entry) entry.expiresAt = Date.now() + STATUS_RETRY_MS;
        });
      }
      return statusCache.value;
    },

    async *runTurn(input: TurnInput): AsyncGenerator<ProviderEvent> {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (input.signal.aborted) return;
      input.signal.addEventListener("abort", abort, { once: true });

      const current = account();
      const stderr = new Tail();
      const tools = accountTools(current, input.mcpServers);
      const mcp = toSdkMcpServers(tools.servers);
      // Steerable turns keep their prompt stream open so notes can be added mid-turn.
      const stream = input.onSteerable ? new PromptStream() : null;
      stream?.push(openingMessage(input));
      const q = query({
        prompt: stream ?? (input.images?.length ? withImages(input) : input.prompt),
        options: {
          ...baseOptions(controller, current),
          env: { ...buildEnv(current), ...mcp.env },
          model: input.model,
          effort: input.effort,
          // Current models omit reasoning text by default; summaries let the UI show "Thinking".
          thinking: { type: "adaptive", display: "summarized" },
          systemPrompt: input.systemPrompt,
          // Only web tools stay built in; everything else goes through TOT's MCP tools on the remote computer.
          tools: ["WebSearch", "WebFetch"],
          mcpServers: mcp.servers,
          ...(tools.plugins.length ? { plugins: tools.plugins } : {}),
          // An added account with its tools off gets TOT's servers only, whatever its folder's config lists.
          ...(!current.builtIn && !current.useAccountTools ? { strictMcpConfig: true } : {}),
          ...(input.elicit
            ? {
                onElicitation: async (request, { signal }) => {
                  const answer = await input.elicit!(
                    {
                      source: request.serverName,
                      message: request.message,
                      mode: request.mode === "url" ? "url" : "form",
                      url: request.url,
                      schema: request.requestedSchema,
                    },
                    signal,
                  );
                  return answer.action === "accept" ? { action: "accept", content: answer.content ?? {} } : { action: answer.action };
                },
              }
            : {}),
          disallowedTools: tools.servers.flatMap((spec) =>
            spec.type === "http" ? (spec.disabledTools ?? []).map((tool) => `mcp__${spec.name}__${tool}`) : [],
          ),
          // Safe because the local tool surface is just web search/fetch. A plan turn runs in Claude Code's own plan
          // mode instead, with TOT's tools that change things turned away here too (and by TOT's server).
          ...(input.plan
            ? {
                permissionMode: "plan" as const,
                planModeInstructions: PLAN_WORKFLOW,
                canUseTool: async (tool: string, toolInput: Record<string, unknown>) =>
                  CHANGING_TOOLS.has(normalizeToolName(tool))
                    ? { behavior: "deny" as const, message: PLAN_REFUSAL }
                    : { behavior: "allow" as const, updatedInput: toolInput },
              }
            : { permissionMode: "bypassPermissions" as const, allowDangerouslySkipPermissions: true }),
          settings: { disableClaudeAiConnectors: !settings.get().claude.useConnectedApps },
          ...resumeOptions(input),
          includePartialMessages: true,
          maxTurns: input.maxSteps ?? MAX_AGENT_TURNS,
          stderr: (chunk) => stderr.push(chunk),
        },
      });

      let messageId = "m0";
      let sessionId = input.sessionId;
      let assistantError: TurnFailure | undefined;

      // Steering notes handed to Claude Code and not yet taken up, by uuid → how to answer the deliverer.
      const notes = new Map<string, (taken: boolean) => void>();
      const settleNotes = (taken: boolean, uuids: Iterable<string> = [...notes.keys()]) => {
        for (const uuid of uuids) {
          notes.get(uuid)?.(taken);
          notes.delete(uuid);
        }
      };
      let turnEnded = false;
      input.onSteerable?.((text) => {
        if (!stream || turnEnded || controller.signal.aborted) return Promise.resolve(false);
        const uuid = randomUUID();
        const taken = new Promise<boolean>((resolve) => notes.set(uuid, resolve));
        stream.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text }] }, priority: "next", uuid });
        return taken;
      });
      // A turn that ended with a note still queued: Claude Code runs the note as one more turn, which this turn includes.
      let awaitingNote = false;
      const totals = { inputTokens: 0, outputTokens: 0, durationMs: 0 };
      const iterator = (q as AsyncIterable<SDKMessage>)[Symbol.asyncIterator]();

      try {
        while (true) {
          const pending = iterator.next();
          // Closing the query rejects a read left waiting after the timeout below; nothing needs it then.
          pending.catch(() => {});
          const next = awaitingNote
            ? await Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), QUEUED_NOTE_WAIT_MS).unref())])
            : await pending;
          if (!next) {
            // Claude Code never started on the note: TOT delivers it another way.
            settleNotes(false);
            return;
          }
          if (next.done) break;
          const message = next.value;
          if (awaitingNote && (message.type === "assistant" || message.type === "stream_event")) {
            awaitingNote = false;
            settleNotes(true);
          }
          if ((message.type === "assistant" || message.type === "stream_event") && message.user_message_uuids?.length) {
            settleNotes(true, message.user_message_uuids.filter((uuid) => notes.has(uuid)));
          }
          switch (message.type) {
            case "system":
              if (message.subtype === "init") {
                sessionId = message.session_id;
                yield { type: "session", sessionId };
              }
              break;

            case "stream_event": {
              if (message.parent_tool_use_id) break;
              const event = message.event;
              if (event.type === "message_start") {
                messageId = event.message.id;
              } else if (event.type === "content_block_start") {
                const block = event.content_block;
                if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
                  yield { type: "tool-start", toolCallId: block.id, name: normalizeToolName(block.name) };
                }
              } else if (event.type === "content_block_delta") {
                const blockId = `${messageId}:${event.index}`;
                if (event.delta.type === "text_delta") {
                  yield { type: "text-delta", blockId, delta: event.delta.text };
                } else if (event.delta.type === "thinking_delta") {
                  yield { type: "reasoning-delta", blockId, delta: event.delta.thinking };
                }
              }
              break;
            }

            case "assistant":
              if (message.parent_tool_use_id) break;
              // The turn's latest point in the session: where a fork from this reply starts.
              yield { type: "ref", ref: message.uuid };
              if (message.error) assistantError = friendlyError(message.error, input.model);
              for (const block of message.message.content) {
                if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
                  yield { type: "tool-start", toolCallId: block.id, name: normalizeToolName(block.name), input: block.input };
                }
              }
              break;

            case "user": {
              if (message.parent_tool_use_id) break;
              const content = message.message.content;
              if (!Array.isArray(content)) break;
              for (const block of content) {
                if (block.type === "tool_result") {
                  yield {
                    type: "tool-end",
                    toolCallId: block.tool_use_id,
                    output: toolResultText(block.content as ToolResultContent),
                    isError: Boolean(block.is_error),
                  };
                }
              }
              break;
            }

            case "result": {
              const usage = message.usage;
              // A note run as an extra turn adds its own result: report the totals.
              totals.inputTokens += usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
              totals.outputTokens += usage.output_tokens;
              totals.durationMs += message.duration_ms;
              const turnUsage: Usage = { ...totals };
              if (sessionId) {
                const previous = lastSessionCost.get(sessionId);
                // After a server restart the earlier total is unknown; better no number than a wrong one.
                if (previous !== undefined || !input.sessionId) {
                  turnUsage.costUsd = Math.max(0, message.total_cost_usd - (previous ?? 0));
                }
                lastSessionCost.set(sessionId, message.total_cost_usd);
              }
              yield { type: "usage", usage: turnUsage };

              if (controller.signal.aborted) return;
              let failure: TurnFailure | undefined;
              if (message.subtype !== "success") {
                const detail = message.errors?.join("; ") || stderr.lastLine();
                failure =
                  assistantError ??
                  (message.subtype === "error_max_turns"
                    ? { message: 'TOT stopped after too many steps. Say "continue" to keep going.', kind: "turn" }
                    : classify(`Claude failed: ${detail || message.subtype}`));
              } else if (message.is_error) {
                // The result text carries details like the reset time, so prefer it for limits.
                const reported = message.result ? classify(message.result) : undefined;
                failure = reported?.kind === "limit" ? reported : (assistantError ?? reported ?? { message: "Claude returned an error." });
              }
              if (failure) {
                yield { type: "error", message: failure.message, kind: failure.kind };
                return;
              }
              if (notes.size) {
                awaitingNote = true;
                break;
              }
              return;
            }
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        const reason = err instanceof Error ? err.message : String(err);
        const tail = stderr.lastLine();
        const failure = assistantError ?? classify(`Claude Code crashed: ${reason}${tail && tail !== reason ? ` (${tail})` : ""}`);
        yield { type: "error", message: failure.message, kind: failure.kind };
      } finally {
        turnEnded = true;
        settleNotes(false);
        stream?.end();
        input.signal.removeEventListener("abort", abort);
        q.close();
      }
    },

    async complete(prompt, opts = {}) {
      const controller = new AbortController();
      opts.signal?.addEventListener("abort", () => controller.abort(), { once: true });
      const q = query({
        prompt,
        options: {
          ...baseOptions(controller, account()),
          model: opts.model ?? CLAUDE_SONNET,
          effort: "low",
          systemPrompt: opts.system ?? "You are a concise assistant.",
          tools: [],
          maxTurns: 1,
          persistSession: false,
          strictMcpConfig: true,
          settings: { disableClaudeAiConnectors: true },
        },
      });
      try {
        for await (const message of q as AsyncIterable<SDKMessage>) {
          if (message.type !== "result") continue;
          if (message.subtype === "success" && !message.is_error) return message.result.trim();
          throw new Error(message.subtype === "success" ? message.result : message.subtype);
        }
        throw new Error("Claude returned no result.");
      } finally {
        q.close();
      }
    },
  };
}

/** The built-in Claude account (the default ~/.claude login). */
export const claudeProvider: AgentProvider = makeClaudeProvider("claude");
