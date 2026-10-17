import { normalizeToolName } from "../agent/providers/claude.ts";

/**
 * What a session file says, the same for Claude Code's and Codex's formats (sessions/claude.ts, sessions/codex.ts):
 * the session's own facts, the user's prompts, and the replies' text, reasoning and tool calls in order. Both the
 * list (a summary) and the import (TOT messages, sessions/transcript.ts) are read from it.
 */
export type SessionEvent =
  | { type: "meta"; sessionId?: string; cwd?: string; branch?: string; model?: string; subagent?: boolean }
  /** The session's own name: rank 3 one the user gave it, 2 one the CLI made, 1 an older summary line. The highest, then the latest, wins. */
  | { type: "title"; text: string; rank: number }
  | { type: "prompt"; text: string; images: SessionImage[]; at: number }
  /** `block` groups text that arrived as one reply block (Claude Code writes each block as its own record). */
  | { type: "text"; text: string; block: string; at: number }
  | { type: "reasoning"; text: string; block: string; at: number; durationMs?: number }
  | { type: "tool-start"; id: string; name: string; input: unknown; title?: string; at: number }
  | { type: "tool-end"; id: string; output: string; isError: boolean }
  | { type: "notice"; text: string; at: number };

export interface SessionImage {
  mimeType: string;
  /** Base64. */
  data: string;
}

export const COMPACTED = "The CLI summarized the conversation up to here to free up context.";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function short(value: string, max = 72): string {
  const line = value.split("\n")[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function fileName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** The files an apply_patch patch touches, for its title. */
function patchedFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) => fileName(match[1]!.trim()));
}

function edited(paths: string[]): string {
  if (!paths.length) return "Edited files";
  return paths.length === 1 ? `Edited \`${paths[0]}\`` : `Edited ${paths.length} files`;
}

/** A shell command as one string ("bash -lc 'x'" arrays as x). */
function commandLine(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts = value.filter((part): part is string => typeof part === "string");
  if (parts.length === 3 && /(^|\/)(ba|z)?sh$/.test(parts[0]!) && /^-l?c$/.test(parts[1]!)) return parts[2]!;
  return parts.join(" ");
}

/** A tool call as a part holds it. Tools TOT's UI knows get no title: it labels them itself (shortened paths, commands as code). */
type Tool = { name: string; input: unknown; title?: string };

/**
 * A Claude Code tool call as TOT shows one: its command, file and web tools under TOT's names for the same thing (so
 * they read "Ran …", "Read …"), MCP tools as "<server>/<tool>", and the rest under their own names with a title.
 * `cwd` is the folder the session was in at the time.
 */
export function claudeTool(name: string, rawInput: unknown, cwd?: string): Tool {
  const input = record(rawInput);
  const full = text(input.file_path) || text(input.notebook_path) || text(input.path);
  // A file in the folder the session ran in reads relative to it, as the user knows it.
  const path = cwd && full.startsWith(`${cwd}/`) ? full.slice(cwd.length + 1) : full;
  switch (name) {
    case "Bash":
      return { name: "computer_exec", input: { command: text(input.command), ...(input.description ? { description: input.description } : {}) } };
    case "Read":
      return { name: "computer_read_file", input: { path } };
    case "Write":
      return { name: "computer_write_file", input: { path, content: text(input.content) } };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { name, input: rawInput, title: edited(path ? [fileName(path)] : []) };
    case "Glob":
      return { name, input: rawInput, title: `Found files matching \`${short(text(input.pattern), 56)}\`` };
    case "Grep":
      return { name, input: rawInput, title: `Searched for “${short(text(input.pattern), 56)}”` };
    case "WebSearch":
      return { name: "web_search", input: { query: text(input.query) } };
    case "WebFetch":
      return { name: "web_fetch", input: { url: text(input.url), ...(input.prompt ? { prompt: input.prompt } : {}) } };
    case "Task":
    case "Agent":
      return { name, input: rawInput, title: input.description ? `Ran a subagent: ${short(text(input.description), 60)}` : "Ran a subagent" };
    case "TodoWrite":
      return { name, input: rawInput, title: "Updated the to-do list" };
    case "Skill":
      return { name, input: rawInput, title: input.skill || input.command ? `Used the ${short(text(input.skill) || text(input.command), 40)} skill` : "Used a skill" };
    case "ExitPlanMode":
      return { name, input: rawInput, title: "Proposed a plan" };
    case "AskUserQuestion":
      return { name, input: rawInput, title: "Asked you a question" };
    case "BashOutput":
    case "KillShell":
    case "KillBash":
      return { name, input: rawInput, title: "Checked a background command" };
  }
  return name.startsWith("mcp__") ? { name: normalizeToolName(name), input: rawInput } : { name, input: rawInput };
}

/** "mcp__codex_apps__slack" + "_slack_send_message" → "slack/send_message"; "mcp__tot" + "computer_exec" → "computer_exec". */
function codexToolName(namespace: string, name: string): string {
  if (!namespace.startsWith("mcp__")) return `${namespace}/${name}`;
  const server = namespace.slice(5).replace(/_+$/, "").split("__").pop() || namespace;
  if (server === "tot") return name;
  const tool = name.replace(/^_+/, "");
  return `${server}/${tool.startsWith(`${server}_`) ? tool.slice(server.length + 1) : tool}`;
}

/** A Codex tool call (function or custom tool) as TOT shows one, the same way as Claude Code's. */
export function codexTool(name: string, namespace: string, rawInput: unknown): Tool {
  const input = record(rawInput);
  if (!namespace) {
    switch (name) {
      case "exec_command":
        return { name: "computer_exec", input: { command: text(input.cmd) || commandLine(input.command) } };
      case "shell":
      case "shell_command":
      case "local_shell":
        return { name: "computer_exec", input: { command: commandLine(input.command) } };
      case "exec":
        return { name: "computer_exec", input: { command: typeof rawInput === "string" ? rawInput : text(input.code) || text(input.command) } };
      case "apply_patch": {
        const patch = typeof rawInput === "string" ? rawInput : text(input.input) || text(input.patch);
        return { name, input: { patch }, title: edited(patchedFiles(patch)) };
      }
      case "update_plan":
        return { name, input: rawInput, title: "Updated the plan" };
      case "view_image":
        return { name, input: rawInput, title: input.path ? `Looked at \`${fileName(text(input.path))}\`` : "Looked at an image" };
      case "write_stdin":
        return { name, input: rawInput, title: "Sent input to a running command" };
    }
  }
  if (namespace) return { name: codexToolName(namespace, name), input: rawInput };
  return name.startsWith("mcp__") ? { name: normalizeToolName(name), input: rawInput } : { name, input: rawInput };
}

/** A Codex web_search_call's action as a tool call (it has no output of its own). */
export function codexWebSearch(action: unknown): Tool {
  const value = record(action);
  const url = text(value.url);
  if (value.type === "search") {
    const queries = Array.isArray(value.queries) ? value.queries.filter((q): q is string => typeof q === "string") : [];
    return { name: "web_search", input: { query: text(value.query) || queries[0] || "" } };
  }
  if (value.type === "find_in_page") return { name: "web_fetch", input: { url }, title: `Searched a page for “${short(text(value.pattern), 48)}”` };
  return { name: "web_fetch", input: { url } };
}
