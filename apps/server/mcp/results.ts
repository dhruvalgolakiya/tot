import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Small helpers shared by TOT's MCP tools. */

/** Keeps the start and the (usually more useful) end of long output. */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.35);
  return `${text.slice(0, head)}\n… ${text.length - limit} characters omitted …\n${text.slice(-(limit - head))}`;
}

export const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

export const reply = (text: string, isError = false): CallToolResult => ({ content: [{ type: "text", text }], isError });

/** Runs a tool, turning a thrown error into an error result the model can read. */
export async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (err) {
    return reply(err instanceof Error ? err.message : String(err), true);
  }
}
