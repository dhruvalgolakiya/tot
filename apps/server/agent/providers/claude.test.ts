// Live smoke test for the Claude provider (spends a little subscription quota).
// Run: TOT_DATA_DIR=/tmp/tot-claude-test npx tsx apps/server/agent/providers/claude.test.ts
import { fileURLToPath } from "node:url";
import { claudeProvider } from "./claude.ts";
import type { ProviderEvent, TurnInput } from "./types.ts";
import { paths } from "../../config.ts";

const fixture = fileURLToPath(new URL("./fixtures/echo-mcp.ts", import.meta.url));

function turn(overrides: Partial<TurnInput>): TurnInput {
  return {
    conversationId: "test",
    prompt: "Reply with exactly: pong",
    model: "claude-sonnet-5-5",
    effort: "low",
    systemPrompt: "You are TOT, a terse test assistant.",
    mcpServers: [],
    workDir: paths.agentHome,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(input: TurnInput, onEvent?: (e: ProviderEvent) => void) {
  const events: ProviderEvent[] = [];
  const started = Date.now();
  let firstText = 0;
  for await (const event of claudeProvider.runTurn(input)) {
    if (event.type === "text-delta" && !firstText) firstText = Date.now() - started;
    events.push(event);
    onEvent?.(event);
  }
  const text = events.flatMap((e) => (e.type === "text-delta" ? [e.delta] : [])).join("");
  const session = events.find((e) => e.type === "session");
  const usage = events.find((e) => e.type === "usage");
  const error = events.find((e) => e.type === "error");
  return { events, text, session, usage, error, firstText, total: Date.now() - started };
}

const summarize = (events: ProviderEvent[]) => {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  return Object.fromEntries(counts);
};

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const status = await claudeProvider.status();
check("status: logged in", status.loggedIn, `${status.authMethod ?? "-"} · ${status.models.map((m) => m.label).join(", ")}${status.detail ? ` · ${status.detail}` : ""}`);

const title = await claudeProvider.complete("Write a 3-word title for a chat about baking sourdough bread. Title only.");
check("complete()", title.length > 0 && title.length < 60, JSON.stringify(title));

const first = await collect(turn({}));
check("turn: streams text", first.text.trim().toLowerCase().includes("pong"), `${JSON.stringify(first.text)} · first token ${first.firstText}ms · total ${first.total}ms`);
check("turn: session id", first.session?.type === "session");
check("turn: usage", first.usage?.type === "usage", JSON.stringify(first.usage?.type === "usage" ? first.usage.usage : null));
check("turn: no error", !first.error, first.error?.type === "error" ? first.error.message : "");
console.log("      events:", JSON.stringify(summarize(first.events)));

const sessionId = first.session?.type === "session" ? first.session.sessionId : undefined;
const resumed = await collect(turn({ sessionId, prompt: "What exact word did you just reply with? Answer with just that word." }));
check("resume: remembers context", resumed.text.toLowerCase().includes("pong"), JSON.stringify(resumed.text));

const withTool = await collect(
  turn({
    prompt: 'Call the echo tool once with text "hi", then reply with just the tool\'s output.',
    mcpServers: [{ name: "echo", type: "stdio", command: process.execPath, args: ["--import", "tsx", fixture] }],
  }),
);
const toolStart = withTool.events.find((e) => e.type === "tool-start" && e.input !== undefined);
const toolEnd = withTool.events.find((e) => e.type === "tool-end");
check("mcp: tool-start normalized", toolStart?.type === "tool-start" && toolStart.name === "echo/echo", JSON.stringify(toolStart));
check("mcp: tool-end output", toolEnd?.type === "tool-end" && (toolEnd.output ?? "").includes("echo: hi"), JSON.stringify(toolEnd));
check("mcp: final text", withTool.text.includes("echo: hi"), JSON.stringify(withTool.text));

const controller = new AbortController();
const aborted = await collect(
  turn({ prompt: "Count from 1 to 400, one number per line.", signal: controller.signal }),
  (e) => {
    if (e.type === "text-delta") controller.abort();
  },
);
check("abort: ends quietly", !aborted.error, aborted.error?.type === "error" ? aborted.error.message : `stopped after ${aborted.total}ms`);

const opus = await collect(turn({ model: "claude-opus-5-5", prompt: "Reply with exactly: ok" }));
check("opus 5.5 model id works", opus.text.toLowerCase().includes("ok") && !opus.error, opus.error?.type === "error" ? opus.error.message : JSON.stringify(opus.text));

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
