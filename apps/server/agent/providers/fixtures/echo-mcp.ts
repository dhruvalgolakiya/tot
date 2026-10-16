// Tiny stdio MCP server used by claude.test.ts: one tool, `echo`, that returns its input.
// Run with: node --import tsx apps/server/agent/providers/fixtures/echo-mcp.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Echoes the given text back, prefixed with 'echo: '.",
    inputSchema: { text: z.string().describe("Text to echo back") },
  },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);

await server.connect(new StdioServerTransport());
