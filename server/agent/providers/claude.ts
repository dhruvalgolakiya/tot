import {
  query,
  type AccountInfo,
  type McpServerConfig,
  type ModelInfo,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import type { ModelOption, ProviderStatus, Usage } from "../../../shared/types.ts";
import { getSecret, paths } from "../../config.ts";
import { settings } from "../../data/settings.ts";
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

// ---------------------------------------------------------------------------
// Environment for the Claude Code child process. `env` replaces the child's
// environment entirely, so start from process.env and drop what must not leak:
// session plumbing from any parent Claude Code session, and (in subscription
// mode) API credentials/proxies that would shadow the local login.
// ---------------------------------------------------------------------------

const SESSION_VARS = /^(CLAUDECODE|CLAUDE_CODE_\w+|CLAUDE_PID|CLAUDE_AGENT_SDK_VERSION|CLAUDE_EFFORT|CLAUDE_CONFIG_DIR)$/;
const AUTH_VARS =
  /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_MODEL|ANTHROPIC_SMALL_FAST_MODEL|ANTHROPIC_DEFAULT_\w+_MODEL)$/;

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SESSION_VARS.test(key) && !AUTH_VARS.test(key)) env[key] = value;
  }
  if (process.env.TOT_CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.TOT_CLAUDE_CONFIG_DIR;
  if (settings.get().claude.authMode === "api-key") {
    const key = getSecret("anthropicApiKey");
    if (key) env.ANTHROPIC_API_KEY = key;
  }
  return env;
}

/** Options every TOT query shares: isolated from the user's personal Claude Code config. */
function baseOptions(controller: AbortController): Options {
  return {
    env: buildEnv(),
    cwd: paths.agentHome,
    // Don't load the user's CLAUDE.md / settings / plugins: measured ~40x token cost otherwise.
    settingSources: [],
    abortController: controller,
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

type TurnFailure = { message: string; kind?: "limit" | "auth" };

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

/** A one-message prompt stream carrying the user's images alongside their text. */
async function* withImages(input: TurnInput): AsyncGenerator<SDKUserMessage> {
  yield {
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

// total_cost_usd is cumulative per session, so remember the last total to report per-turn cost.
const lastSessionCost = new Map<string, number>();

// ---------------------------------------------------------------------------
// Status & models
// ---------------------------------------------------------------------------

function modelOptions(available: boolean, supported: ModelInfo[]): ModelOption[] {
  const reason = available ? undefined : "Claude isn't connected";
  const option = (model: string, label: string, description: string): ModelOption => ({
    id: `claude:${model}`,
    provider: "claude",
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

async function loadStatus(): Promise<ProviderStatus> {
  const base = { id: "claude" as const, label: "Claude", installed: true };

  if (settings.get().claude.authMode === "api-key") {
    const hasKey = Boolean(getSecret("anthropicApiKey"));
    return {
      ...base,
      loggedIn: hasKey,
      authMethod: "API key",
      detail: hasKey ? undefined : "Add an Anthropic API key in Settings → Models, or switch back to your subscription.",
      models: modelOptions(hasKey, []),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_PROBE_TIMEOUT_MS);
  const probe = query({
    prompt: silentPrompt(controller.signal),
    options: { ...baseOptions(controller), tools: [], persistSession: false },
  });
  try {
    const [account, supported] = await Promise.all([probe.accountInfo(), probe.supportedModels()]);
    const loggedIn = Boolean(account.subscriptionType || account.email);
    return {
      ...base,
      loggedIn,
      authMethod: loggedIn ? subscriptionLabel(account) : undefined,
      account: account.email,
      detail: loggedIn ? undefined : LOGIN_HINT,
      models: modelOptions(loggedIn, supported),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      installed: !/ENOENT|spawn/i.test(message),
      loggedIn: false,
      detail: controller.signal.aborted ? `Claude Code didn't respond. ${LOGIN_HINT}` : `${message}. ${LOGIN_HINT}`,
      models: modelOptions(false, []),
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

let statusCache: { expiresAt: number; value: Promise<ProviderStatus> } | null = null;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const claudeProvider: AgentProvider = {
  id: "claude",
  label: "Claude",

  status() {
    if (!statusCache || Date.now() > statusCache.expiresAt) {
      const value = loadStatus();
      statusCache = { expiresAt: Date.now() + STATUS_TTL_MS, value };
      // Don't pin a failed check for the full TTL.
      void value.then((status) => {
        if (!status.loggedIn && statusCache?.value === value) statusCache.expiresAt = Date.now() + STATUS_RETRY_MS;
      });
    }
    return statusCache.value;
  },

  async *runTurn(input: TurnInput): AsyncGenerator<ProviderEvent> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (input.signal.aborted) return;
    input.signal.addEventListener("abort", abort, { once: true });

    const stderr = new Tail();
    const mcp = toSdkMcpServers(input.mcpServers);
    const q = query({
      prompt: input.images?.length ? withImages(input) : input.prompt,
      options: {
        ...baseOptions(controller),
        env: { ...buildEnv(), ...mcp.env },
        model: input.model,
        effort: input.effort,
        // Current models omit reasoning text by default; summaries let the UI show "Thinking".
        thinking: { type: "adaptive", display: "summarized" },
        systemPrompt: input.systemPrompt,
        // Only web tools stay built in; everything else goes through TOT's MCP tools on the remote computer.
        tools: ["WebSearch", "WebFetch"],
        mcpServers: mcp.servers,
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
        disallowedTools: input.mcpServers.flatMap((spec) =>
          spec.type === "http" ? (spec.disabledTools ?? []).map((tool) => `mcp__${spec.name}__${tool}`) : [],
        ),
        // Safe because the local tool surface is just web search/fetch.
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settings: { disableClaudeAiConnectors: !settings.get().claude.useConnectedApps },
        resume: input.sessionId,
        includePartialMessages: true,
        maxTurns: MAX_AGENT_TURNS,
        stderr: (chunk) => stderr.push(chunk),
      },
    });

    let messageId = "m0";
    let sessionId = input.sessionId;
    let assistantError: TurnFailure | undefined;

    try {
      for await (const message of q as AsyncIterable<SDKMessage>) {
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
            const turnUsage: Usage = {
              inputTokens:
                usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
              outputTokens: usage.output_tokens,
              durationMs: message.duration_ms,
            };
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
                  ? { message: 'TOT stopped after too many steps. Say "continue" to keep going.' }
                  : classify(`Claude failed: ${detail || message.subtype}`));
            } else if (message.is_error) {
              // The result text carries details like the reset time, so prefer it for limits.
              const reported = message.result ? classify(message.result) : undefined;
              failure = reported?.kind === "limit" ? reported : (assistantError ?? reported ?? { message: "Claude returned an error." });
            }
            if (failure) yield { type: "error", message: failure.message, kind: failure.kind };
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
        ...baseOptions(controller),
        model: opts.model ?? CLAUDE_SONNET,
        effort: "low",
        systemPrompt: opts.system ?? "You are a concise assistant.",
        tools: [],
        maxTurns: 1,
        persistSession: false,
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
