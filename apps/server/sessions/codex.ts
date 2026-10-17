import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPACTED, codexTool, codexWebSearch, type SessionEvent, type SessionImage } from "./events.ts";
import { records, timeOf, type SessionRecord } from "./jsonl.ts";

/**
 * Codex's sessions ("rollouts"): <Codex home>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl (and
 * archived_sessions/), one record per line: session_meta first (the thread id, the folder it ran in, its git branch),
 * then the model's history as response_item records, with event_msg records for the UI alongside (left out here:
 * they repeat the history). Thread names are in <home>/session_index.jsonl. TOT only ever reads these files.
 */

export function isCodexSessionFile(name: string): boolean {
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

/** A thread a subagent ran (another thread's helper): not a session of the user's own. */
function isSubagent(meta: SessionRecord): boolean {
  const source = meta.source;
  if (source && typeof source === "object" && "subagent" in source) return true;
  return Boolean(meta.parent_thread_id) || meta.thread_source === "subagent" || meta.thread_source === "guardian_review";
}

/** Context Codex puts in a user message itself (the environment, AGENTS.md, plugin hints): one tagged block, or AGENTS.md's heading. */
const INJECTED = /^\s*(?:<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>\s*$|# AGENTS\.md instructions)/i;

function dataImage(url: unknown): SessionImage | null {
  const match = typeof url === "string" ? /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(url) : null;
  return match ? { mimeType: match[1]!, data: match[2]! } : null;
}

/** A tool's output as text: a string, an array of content items, or an older {output, metadata} object as JSON. */
function outputOf(raw: unknown): { output: string; isError: boolean } {
  if (Array.isArray(raw)) {
    const output = raw.map((item) => (item?.type === "input_text" || item?.type === "output_text" ? String(item.text ?? "") : `[${item?.type === "input_image" ? "image" : (item?.type ?? "content")}]`)).join("\n");
    return { output, isError: false };
  }
  if (typeof raw !== "string") return { output: raw === undefined ? "" : JSON.stringify(raw), isError: false };
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.output === "string") {
        const code = parsed.metadata?.exit_code;
        return { output: parsed.output, isError: typeof code === "number" && code !== 0 };
      }
    } catch {
      // Plain text that happens to start with a brace.
    }
  }
  const code = /^Process exited with code (\d+)/m.exec(raw)?.[1];
  return { output: raw, isError: code !== undefined && code !== "0" };
}

function argumentsOf(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** A Codex rollout as SessionEvents; `light` skips tool inputs, outputs and images, for listing. */
export async function* codexEvents(path: string, { light = false } = {}): AsyncGenerator<SessionEvent> {
  let searches = 0;
  for await (const record of records(path)) {
    const at = timeOf(record);
    const payload = record.payload;
    if (!payload || typeof payload !== "object") continue;
    if (record.type === "session_meta") {
      const sessionId = typeof payload.id === "string" ? payload.id : typeof payload.session_id === "string" ? payload.session_id : undefined;
      const branch = typeof payload.git?.branch === "string" && payload.git.branch ? payload.git.branch : undefined;
      yield { type: "meta", sessionId, cwd: typeof payload.cwd === "string" ? payload.cwd : undefined, branch, subagent: isSubagent(payload) };
      continue;
    }
    if (record.type === "turn_context") {
      if (typeof payload.model === "string" && payload.model) yield { type: "meta", model: payload.model };
      continue;
    }
    if (record.type === "compacted") {
      yield { type: "notice", text: COMPACTED, at };
      continue;
    }
    if (record.type !== "response_item") continue;
    switch (payload.type) {
      case "message": {
        const content = Array.isArray(payload.content) ? payload.content : [];
        if (payload.role === "user") {
          const texts: string[] = [];
          const images: SessionImage[] = [];
          let hadImage = false;
          for (const item of content) {
            if (item?.type === "input_text" && typeof item.text === "string" && item.text.trim() && !INJECTED.test(item.text)) texts.push(item.text.trim());
            if (item?.type === "input_image") {
              hadImage = true;
              const image = light ? null : dataImage(item.image_url);
              if (image) images.push(image);
            }
          }
          if (texts.length || hadImage) yield { type: "prompt", text: texts.join("\n\n"), images, at };
        } else if (payload.role === "assistant") {
          const block = String(payload.id ?? `${at}:${record.ordinal ?? ""}`);
          for (const item of content) {
            if (item?.type === "output_text" && typeof item.text === "string" && item.text.trim()) yield { type: "text", text: item.text, block, at };
          }
        }
        break;
      }
      case "reasoning": {
        const summary = Array.isArray(payload.summary) ? payload.summary : [];
        const text = summary.map((item: SessionRecord) => (typeof item?.text === "string" ? item.text : "")).filter(Boolean).join("\n\n");
        if (text.trim()) yield { type: "reasoning", text, block: String(payload.id ?? at), at };
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        if (typeof payload.call_id !== "string") break;
        const name = String(payload.name ?? "tool");
        const namespace = typeof payload.namespace === "string" ? payload.namespace : "";
        const tool = light ? { name, input: undefined } : codexTool(name, namespace, payload.type === "function_call" ? argumentsOf(payload.arguments) : payload.input);
        yield { type: "tool-start", id: payload.call_id, ...tool, at };
        break;
      }
      case "local_shell_call": {
        if (typeof payload.call_id !== "string") break;
        const tool = light ? { name: "computer_exec", input: undefined } : codexTool("local_shell", "", { command: payload.action?.command });
        yield { type: "tool-start", id: payload.call_id, ...tool, at };
        break;
      }
      case "web_search_call": {
        const id = String(payload.id ?? `web_search_${++searches}`);
        yield { type: "tool-start", id, ...(light ? { name: "web_search", input: undefined } : codexWebSearch(payload.action)), at };
        yield { type: "tool-end", id, output: "", isError: payload.status === "failed" };
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output":
        if (!light && typeof payload.call_id === "string") yield { type: "tool-end", id: payload.call_id, ...outputOf(payload.output) };
        break;
    }
  }
}

const titleCache = new Map<string, { stamp: number; titles: Map<string, string> }>();

/** Thread names a Codex home keeps (session_index.jsonl; the latest line for a thread wins), read again when it changes. */
export function codexThreadNames(home: string, mtimeOf: (path: string) => number | null): Map<string, string> {
  const path = join(home, "session_index.jsonl");
  const stamp = mtimeOf(path);
  if (stamp === null) return new Map();
  const cached = titleCache.get(path);
  if (cached?.stamp === stamp) return cached.titles;
  const titles = new Map<string, string>();
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry?.id === "string" && typeof entry.thread_name === "string" && entry.thread_name.trim()) titles.set(entry.id, entry.thread_name);
      } catch {
        // A line being written.
      }
    }
  } catch {
    return new Map();
  }
  titleCache.set(path, { stamp, titles });
  return titles;
}
