import type { Effort, ProviderId, ProviderStatus, Usage } from "../../../shared/types.ts";

/** An MCP server attached to a turn. TOT's built-in server is always named "tot". */
export type McpServerSpec =
  | {
      name: string;
      type: "http";
      url: string;
      headers?: Record<string, string>;
      /** Tools of this server the agent must not have (e.g. merging pull requests). */
      disabledTools?: string[];
    }
  | { name: string; type: "stdio"; command: string; args?: string[]; env?: Record<string, string> };

export interface TurnInput {
  conversationId: string;
  /** The user's message for this turn (may carry a seeded transcript after a provider switch). */
  prompt: string;
  /** Images the user attached, to show the model directly (png, jpeg, gif or webp; ≤ 5 MB each). */
  images?: { path: string; mimeType: string }[];
  /** Provider-native model id, e.g. "claude-opus-5-5" or "gpt-5.5". */
  model: string;
  effort: Effort;
  /** Provider session/thread id to resume; undefined starts a fresh session. */
  sessionId?: string;
  /**
   * TOT system prompt (persona, custom instructions, memory, computer guidance).
   * Frozen per conversation so provider-side prompt caches stay warm.
   */
  systemPrompt: string;
  /** Built-in "tot" server (computer + memory tools) first, then enabled plugins. */
  mcpServers: McpServerSpec[];
  /** Stable harness cwd on this machine. The agent's real workspace is its remote computer. */
  workDir: string;
  signal: AbortSignal;
  /** Asks the user on behalf of an MCP server (elicitation); resolves with their answer. */
  elicit?: (request: ElicitRequest, signal?: AbortSignal) => Promise<ElicitAnswer>;
  /** Most model/tool steps this turn may take, for long jobs; providers without a cap ignore it. */
  maxSteps?: number;
}

/** An MCP server asking the user something mid-turn (MCP `elicitation/create`). */
export interface ElicitRequest {
  /** The MCP server's name as attached to the turn, e.g. "apps" or "github". */
  source: string;
  message: string;
  mode: "form" | "url";
  url?: string;
  /** Form mode: MCP's requestedSchema (flat object of primitive fields). */
  schema?: unknown;
}

export interface ElicitAnswer {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean>;
}

/**
 * Normalized stream a provider yields for one turn.
 *
 * Tool names must be normalized before emitting:
 *   - tools of the "tot" MCP server  -> bare tool name ("computer_exec", "memory_save")
 *   - tools of any other MCP server  -> "<server>/<tool>"
 *   - built-in web search / fetch    -> "web_search" / "web_fetch"
 *   - anything else                  -> the provider's own name
 *
 * `blockId`s group deltas into one text/reasoning part; start a new id whenever
 * the provider starts a new content block. `toolCallId`s must be unique per turn.
 */
export type ProviderEvent =
  /** Emit as soon as the session/thread id is known so it can be resumed next turn. */
  | { type: "session"; sessionId: string }
  | { type: "text-delta"; blockId: string; delta: string }
  | { type: "reasoning-delta"; blockId: string; delta: string }
  | { type: "tool-start"; toolCallId: string; name: string; input?: unknown }
  | { type: "tool-end"; toolCallId: string; output?: string; isError?: boolean }
  /** Running totals for this turn; the latest event wins. */
  | { type: "usage"; usage: Usage }
  /**
   * A fatal turn error. The provider should stop yielding after it.
   * kind "limit" = usage/rate limit reached (TOT Auto may retry on another provider);
   * kind "auth" = not logged in.
   */
  | { type: "error"; message: string; kind?: "limit" | "auth" };

export interface AgentProvider {
  id: ProviderId;
  label: string;
  /**
   * Is the harness installed and logged in, and which models can be picked
   * (ModelOption ids are "<provider>:<model>")? Called often; cache internally.
   */
  status(): Promise<ProviderStatus>;
  /** Runs one agent turn, streaming normalized events. Must honor input.signal. */
  runTurn(input: TurnInput): AsyncIterable<ProviderEvent>;
  /** Tool-less one-shot completion for light tasks (chat titles). */
  complete(prompt: string, opts?: { model?: string; system?: string; signal?: AbortSignal }): Promise<string>;
  /**
   * Starts an interactive login when the harness supports it (Codex: ChatGPT
   * OAuth in the browser). Resolves with the URL the user should open.
   */
  login?(): Promise<{ url: string }>;
}
