import { COMPACTED, claudeTool, type SessionEvent, type SessionImage } from "./events.ts";
import { records, timeOf, type SessionRecord } from "./jsonl.ts";

/**
 * Claude Code's sessions: <config folder>/projects/<folder>/<session id>.jsonl, one record per line. <folder> is the
 * folder the session ran in with every character but a letter or digit turned into "-" ("/Users/me/my.app" →
 * "-Users-me-my-app"), so different folders can share one; very long ones are cut and get a hash after. Subagents'
 * records sit in a folder of their own beside the session (and in older versions in agent-*.jsonl files), and are
 * marked isSidechain. TOT only ever reads these files.
 */

/** Claude Code's longest projects folder name before it cuts it. */
const MAX_DIR_NAME = 200;

export function claudeProjectDirName(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Whether sessions in projects/<name> may have run in `folder` or below it. Only a may: the name can't tell
 * "/a/b-c" from "/a/b/c", so the session's own cwd decides.
 */
export function mayHoldFolder(name: string, folder: string): boolean {
  const encoded = claudeProjectDirName(folder);
  if (encoded.length >= MAX_DIR_NAME) return name.startsWith(encoded.slice(0, MAX_DIR_NAME));
  return name === encoded || name.startsWith(`${encoded}-`);
}

export function isClaudeSessionFile(name: string): boolean {
  return name.endsWith(".jsonl") && !name.startsWith("agent-");
}

const COMMAND = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const TAGGED = /<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi;
const INTERRUPTED = /^\[Request interrupted by user/;

/**
 * What the user typed, from a user record's text: a slash command with arguments as "/name args"; null for what the
 * CLI wrote itself (command output, reminders, caveats, a bare command, an interruption).
 */
export function promptText(raw: string): string | null {
  const command = COMMAND.exec(raw);
  if (command) {
    const args = COMMAND_ARGS.exec(raw)?.[1]?.trim();
    return args ? `${command[1]!.trim()} ${args}` : null;
  }
  const text = raw.trim();
  if (!text || INTERRUPTED.test(text) || !text.replace(TAGGED, "").trim()) return null;
  return text;
}

type ToolResultContent = string | { type?: string; text?: string }[] | undefined;

function toolResultText(content: ToolResultContent): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block?.type === "text" ? (block.text ?? "") : `[${block?.type ?? "content"}]`)).join("\n");
}

function metaOf(record: SessionRecord): SessionEvent | null {
  const cwd = typeof record.cwd === "string" ? record.cwd : undefined;
  const branch = typeof record.gitBranch === "string" && record.gitBranch && record.gitBranch !== "HEAD" ? record.gitBranch : undefined;
  const model = typeof record.message?.model === "string" && !record.message.model.startsWith("<") ? record.message.model : undefined;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
  return cwd || branch || model || sessionId ? { type: "meta", cwd, branch, model, sessionId } : null;
}

/**
 * A Claude Code session file as SessionEvents. `light` skips what only an import needs (tool inputs and outputs,
 * images), for listing. Subagent (sidechain) and meta records, API errors and compaction summaries are left out; a
 * compaction is a notice.
 */
export async function* claudeEvents(path: string, { light = false } = {}): AsyncGenerator<SessionEvent> {
  for await (const record of records(path)) {
    const at = timeOf(record);
    switch (record.type) {
      case "custom-title":
        if (typeof record.customTitle === "string" && record.customTitle.trim()) yield { type: "title", text: record.customTitle, rank: 3 };
        break;
      case "ai-title":
        if (typeof record.aiTitle === "string" && record.aiTitle.trim()) yield { type: "title", text: record.aiTitle, rank: 2 };
        break;
      case "summary":
        if (typeof record.summary === "string" && record.summary.trim()) yield { type: "title", text: record.summary, rank: 1 };
        break;
      case "system":
        if (record.subtype === "compact_boundary" && !record.isSidechain) yield { type: "notice", text: COMPACTED, at };
        break;
      case "user": {
        if (record.isSidechain || record.isMeta || record.isVisibleInTranscriptOnly || record.isCompactSummary) break;
        const meta = metaOf(record);
        if (meta) yield meta;
        const content = record.message?.content;
        if (typeof content === "string") {
          const text = promptText(content);
          if (text) yield { type: "prompt", text, images: [], at };
          break;
        }
        if (!Array.isArray(content)) break;
        const texts: string[] = [];
        const images: SessionImage[] = [];
        let hadImage = false;
        for (const block of content) {
          if (block?.type === "tool_result") {
            if (!light && typeof block.tool_use_id === "string") {
              yield { type: "tool-end", id: block.tool_use_id, output: toolResultText(block.content), isError: Boolean(block.is_error) };
            }
          } else if (block?.type === "text" && typeof block.text === "string") {
            const text = promptText(block.text);
            if (text) texts.push(text);
          } else if (block?.type === "image") {
            hadImage = true;
            const source = block.source;
            if (!light && source?.type === "base64" && typeof source.data === "string") images.push({ mimeType: String(source.media_type ?? "image/png"), data: source.data });
          }
        }
        if (texts.length || hadImage) yield { type: "prompt", text: texts.join("\n\n"), images, at };
        break;
      }
      case "assistant": {
        if (record.isSidechain || record.isApiErrorMessage) break;
        const meta = metaOf(record);
        if (meta) yield meta;
        const content = record.message?.content;
        if (!Array.isArray(content)) break;
        const block = String(record.message?.id ?? record.uuid ?? at);
        for (const part of content) {
          if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
            yield { type: "text", text: part.text, block, at };
          } else if (part?.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
            const durationMs = typeof record.thinkingDurationMs === "number" ? record.thinkingDurationMs : undefined;
            yield { type: "reasoning", text: part.thinking, block, at, ...(durationMs ? { durationMs } : {}) };
          } else if ((part?.type === "tool_use" || part?.type === "server_tool_use") && typeof part.id === "string") {
            const tool = light ? { name: String(part.name), input: undefined } : claudeTool(String(part.name), part.input, record.cwd);
            yield { type: "tool-start", id: part.id, ...tool, at };
          }
        }
        break;
      }
    }
  }
}
