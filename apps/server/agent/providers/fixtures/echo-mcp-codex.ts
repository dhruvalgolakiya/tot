// Tiny stdio MCP server used by chatgpt.test.ts.
//   echo  -> "echo: <text> #<ECHO_NONCE>" (the nonce proves the tool really ran)
//   fail  -> an isError result, to check error mapping
// Run with: node --import tsx server/agent/providers/fixtures/echo-mcp-codex.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const nonce = process.env.ECHO_NONCE ?? "no-nonce";
const server = new McpServer({ name: "echo", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Echoes the given text back, prefixed with 'echo: ' and suffixed with a verification tag.",
    inputSchema: { text: z.string().describe("Text to echo back") },
    annotations: { readOnlyHint: true },
  },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text} #${nonce}` }] }),
);

server.registerTool(
  "fail",
  {
    description: "Always fails. Only call it when explicitly asked to.",
    inputSchema: { reason: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ reason }) => ({ isError: true, content: [{ type: "text", text: `failed on purpose${reason ? `: ${reason}` : ""}` }] }),
);

await server.connect(new StdioServerTransport());
