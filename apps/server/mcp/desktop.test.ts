// Desktop tools end to end: MCP client → TOT's MCP server → computer manager → Boat backend → mock Boat API.
// Run: TOT_DATA_DIR=/tmp/tot-desktop-test npx tsx apps/server/mcp/desktop.test.ts
import "../test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import { startBoatMock } from "../computer/boat-mock.ts";
import { computerManager } from "../computer/manager.ts";
import { screenshotFile } from "../computer/screens.ts";
import { MCP_TOKEN } from "../config.ts";
import { agents } from "../data/agents.ts";
import { conversations } from "../data/conversations.ts";
import { settings } from "../data/settings.ts";
import { mcpRoutes } from "./server.ts";

const BOAT_PORT = 8796;
const MCP_PORT = 8795;
process.env.BOAT_API_KEY = "boat_test_key";
process.env.BOAT_API_URL = `http://127.0.0.1:${BOAT_PORT}/api/v1`;

const boat = startBoatMock(BOAT_PORT);
settings.patch({ computer: { mode: "boat" } });
const server = serve({ fetch: new Hono().route("/mcp", mcpRoutes).fetch, port: MCP_PORT, hostname: "127.0.0.1" });
const agent = agents.create({ name: "Desk", mascot: { shape: "bot", color: "#22d3ee", accessory: "antenna", eyes: "dots" } });
const conversation = conversations.create({ agentId: agent.id, modelId: "auto" });

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 160)}` : ""}`);
}

const client = new Client({ name: "tot-desktop-test", version: "0.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp/${conversation.id}`), {
    requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
  }),
);
type Content = { type: string; text?: string; data?: string; mimeType?: string };
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Content[];
  return { text: content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), image: content.find((c) => c.type === "image"), isError: Boolean(result.isError) };
};

const tools = (await client.listTools()).tools.map((t) => t.name);
check("desktop tools listed for Boat computers", ["computer_screenshot", "computer_click", "computer_type", "computer_key", "computer_scroll", "computer_open_url"].every((t) => tools.includes(t)), tools.join(", "));

let r = await call("computer_screenshot");
const url = /screenshot: (\S+)/.exec(r.text)?.[1] ?? "";
check("screenshot returns an image", r.image?.mimeType === "image/png" && Boolean(r.image?.data), r.text);
check("screenshot reports the model-facing size", r.text.includes("1280×720"), r.text);
const [, , , agentId, , , file] = url.split("/"); // /api/agents/<id>/computer/screens/<file>
check("screenshot stored and served", Boolean(screenshotFile(agentId, file)), url);
const summary = computerManager.get(agent.id);
check("live view updated", summary?.screenshotUrl === url && summary.gui === true, JSON.stringify(summary));

const before = boat.log.length;
r = await call("computer_click", { x: 100, y: 200, double: true });
const clickCommand = boat.log.slice(before).find((line) => line.includes("xdotool mousemove")) ?? "";
check("click scales 1280px coordinates to the 1920px screen", clickCommand.includes("mousemove --sync 150 300"), clickCommand);
check("click returns a fresh screenshot", Boolean(r.image) && r.text.startsWith("Double-clicked at (100, 200)"), r.text);

r = await call("computer_type", { text: "hello 'world'" });
check("type", !r.isError && Boolean(r.image), r.text);
r = await call("computer_open_url", { url: "https://example.com" });
check("open url", !r.isError && r.text.includes("Opened https://example.com"), r.text);
r = await call("computer_open_url", { url: "file:///etc/passwd" });
check("open url refuses non-http", r.isError, r.text);

await client.close();
await computerManager.destroy(agent.id);
agents.delete(agent.id);
server.close();
boat.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
