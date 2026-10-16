// Live tests for the ChatGPT provider. They spend a little of the user's ChatGPT plan
// (tiny prompts, fast model, low effort).
//
//   npx tsx server/agent/providers/chatgpt.test.ts            # everything
//   npx tsx server/agent/providers/chatgpt.test.ts status pong  # a subset
//
// Tests: status, complete, pong, resume, bad-resume, mcp, lockdown, abort, hygiene.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Keep TOT's own database out of it: the provider reads settings through the data layer.
const dataDir = mkdtempSync(join(tmpdir(), "tot-chatgpt-test-"));
process.env.TOT_DATA_DIR = dataDir;

const { chatgptProvider, stopCodex } = await import("./chatgpt.ts");
type ProviderEvent = import("./types.ts").ProviderEvent;
type TurnInput = import("./types.ts").TurnInput;

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "echo-mcp-codex.ts");
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const MODEL = process.env.TOT_TEST_MODEL ?? "gpt-6-luna";
const workDir = mkdtempSync(join(tmpdir(), "tot-chatgpt-work-"));

const SYSTEM = "You are TOT, a concise assistant used in automated tests. Follow instructions literally.";

function turnInput(overrides: Partial<TurnInput> & { prompt: string }): TurnInput {
  return {
    conversationId: "test",
    model: MODEL,
    effort: "low",
    systemPrompt: SYSTEM,
    mcpServers: [],
    workDir,
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface TurnResult {
  events: ProviderEvent[];
  text: string;
  sessionId?: string;
  firstTextMs?: number;
  totalMs: number;
}

/** Runs a turn, printing a compact event log (consecutive deltas of one block are merged). */
async function run(label: string, input: TurnInput, onEvent?: (e: ProviderEvent) => void): Promise<TurnResult> {
  const started = Date.now();
  const events: ProviderEvent[] = [];
  let firstTextMs: number | undefined;
  const line = { key: "", text: "" };
  const flush = () => {
    if (line.key) console.log(`   ${line.key} ${JSON.stringify(line.text)}`);
    line.key = "";
    line.text = "";
  };
  console.log(`\n── ${label}`);
  for await (const event of chatgptProvider.runTurn(input)) {
    events.push(event);
    onEvent?.(event);
    if (event.type === "text-delta" || event.type === "reasoning-delta") {
      if (event.type === "text-delta" && firstTextMs === undefined) firstTextMs = Date.now() - started;
      const key = `${event.type}[${event.blockId.slice(-10)}]`;
      if (line.key !== key) {
        flush();
        line.key = key;
      }
      line.text += event.delta;
      continue;
    }
    flush();
    console.log(`   ${event.type} ${JSON.stringify({ ...event, type: undefined }).slice(0, 300)}`);
  }
  flush();
  const text = events
    .filter((e): e is Extract<ProviderEvent, { type: "text-delta" }> => e.type === "text-delta")
    .map((e) => e.delta)
    .join("");
  const sessionId = events.find((e): e is Extract<ProviderEvent, { type: "session" }> => e.type === "session")?.sessionId;
  const totalMs = Date.now() - started;
  console.log(`   ⏱ first text ${firstTextMs ?? "-"} ms · total ${totalMs} ms`);
  return { events, text, sessionId, firstTextMs, totalMs };
}

const errors = (r: TurnResult) => r.events.filter((e) => e.type === "error");

// ---------------------------------------------------------------------------

let pongSession: string | undefined;

const tests: Record<string, () => Promise<void>> = {
  async status() {
    const t = Date.now();
    const status = await chatgptProvider.status();
    const cachedAt = Date.now();
    await chatgptProvider.status();
    console.log(`\n── status (${cachedAt - t} ms, cached ${Date.now() - cachedAt} ms)`);
    console.log(
      `   installed=${status.installed} loggedIn=${status.loggedIn} authMethod=${status.authMethod} account=${status.account} detail=${status.detail ?? ""}`,
    );
    for (const m of status.models) console.log(`   ${m.id.padEnd(24)} ${m.label.padEnd(16)} ${m.description ?? ""}`);
    assert.equal(status.installed, true);
    assert.equal(status.loggedIn, true, "codex should be logged in with ChatGPT");
    assert.ok(status.models.length > 0);
    assert.ok(status.models.every((m) => m.id === `chatgpt:${m.model}` && m.provider === "chatgpt" && m.available));
  },

  async complete() {
    const t = Date.now();
    const title = await chatgptProvider.complete(
      "Write a short title (2-6 words) for a chat that starts with: 'how do I bake sourdough bread at home?'. Reply with the title only.",
      { signal: AbortSignal.timeout(60_000) },
    );
    console.log(`\n── complete (${Date.now() - t} ms): ${JSON.stringify(title)}`);
    assert.ok(title.length > 0 && title.length < 80);
  },

  async pong() {
    const r = await run("pong (new thread)", turnInput({ prompt: "Reply with exactly: pong" }));
    assert.equal(errors(r).length, 0);
    assert.equal(r.events[0].type, "session");
    assert.match(r.text.toLowerCase(), /pong/);
    assert.ok(r.events.some((e) => e.type === "usage" && (e.usage.inputTokens ?? 0) > 0));
    pongSession = r.sessionId;
  },

  async resume() {
    if (!pongSession) await tests.pong();
    const warm = await run(
      "resume (thread still loaded)",
      turnInput({ prompt: "What exactly did I ask you in my previous message? One short sentence.", sessionId: pongSession }),
    );
    assert.equal(errors(warm).length, 0);
    assert.equal(warm.sessionId, pongSession);
    assert.match(warm.text.toLowerCase(), /pong/);

    // Cold: a fresh app-server process has to load the thread from disk.
    await stopCodex();
    const cold = await run(
      "resume (fresh process, thread/resume from disk)",
      turnInput({ prompt: "Reply with exactly the word you replied with in your first answer.", sessionId: pongSession }),
    );
    assert.equal(errors(cold).length, 0);
    assert.match(cold.text.toLowerCase(), /pong/);
  },

  async "bad-resume"() {
    const r = await run("resume an unknown thread", turnInput({ prompt: "hi", sessionId: "01a0eeb0-3255-7891-be85-000000000000" }));
    const [error] = errors(r);
    assert.ok(error, "expected an error event");
    assert.ok(r.totalMs < 5_000, "should fail fast so the orchestrator can retry fresh");
    assert.ok(!r.events.some((e) => e.type === "text-delta"));
  },

  async mcp() {
    const nonce = Math.random().toString(36).slice(2, 8);
    const r = await run(
      "mcp round-trip (stdio fixture)",
      turnInput({
        prompt: "Call the echo tool with text 'hello', then call the fail tool once. Finally reply with exactly the echo tool's output.",
        mcpServers: [
          { name: "echo", type: "stdio", command: process.execPath, args: ["--import", TSX_LOADER, FIXTURE], env: { ECHO_NONCE: nonce } },
        ],
      }),
    );
    assert.equal(errors(r).length, 0);
    const starts = r.events.filter((e): e is Extract<ProviderEvent, { type: "tool-start" }> => e.type === "tool-start");
    const ends = r.events.filter((e): e is Extract<ProviderEvent, { type: "tool-end" }> => e.type === "tool-end");
    const echo = starts.find((e) => e.name === "echo/echo");
    assert.ok(echo, "expected an echo/echo tool call");
    assert.deepEqual(echo.input, { text: "hello" });
    const echoEnd = ends.find((e) => e.toolCallId === echo.toolCallId);
    assert.ok(echoEnd?.output?.includes(nonce), "tool output should carry the fixture's nonce");
    assert.equal(echoEnd?.isError, false);
    const fail = starts.find((e) => e.name === "echo/fail");
    if (fail) assert.equal(ends.find((e) => e.toolCallId === fail.toolCallId)?.isError, true, "fail tool should map to isError");
    else console.log("   (model skipped the fail tool)");
    assert.ok(r.text.includes(nonce), "final answer should quote the tool output");
  },

  async lockdown() {
    const r = await run(
      "lockdown (local shell / file writes must be impossible)",
      turnInput({
        prompt:
          "Run the shell command `ls -la` in the current directory, then create a file named hello.txt containing 'hi' there. " +
          "Use any tool you have; if you have an exec tool, also try apply_patch from ALL_TOOLS. Then state exactly what happened.",
      }),
    );
    assert.equal(errors(r).length, 0);
    const files = readdirSync(workDir);
    console.log(`   workDir entries: ${JSON.stringify(files)} · hello.txt anywhere: ${existsSync(join(workDir, "hello.txt"))}`);
    assert.ok(!files.includes("hello.txt"), "the agent must not write to this machine");
    for (const e of r.events) {
      if (e.type === "tool-end" && ["shell", "apply_patch"].some((n) => r.events.some((s) => s.type === "tool-start" && s.toolCallId === e.toolCallId && s.name === n))) {
        assert.equal(e.isError, true, "local command/file tools must fail");
      }
    }
  },

  async abort() {
    const controller = new AbortController();
    let abortedAt = 0;
    const r = await run(
      "abort mid-turn",
      turnInput({ prompt: "Count from 1 to 400, one number per line, no other text.", signal: controller.signal }),
      (e) => {
        if (e.type === "text-delta" && !abortedAt) {
          abortedAt = Date.now();
          setTimeout(() => controller.abort(), 300);
        }
      },
    );
    const endedAfterAbort = Date.now() - abortedAt - 300;
    console.log(`   generator ended ${endedAfterAbort} ms after abort`);
    assert.ok(abortedAt, "should have streamed some text before the abort");
    assert.equal(errors(r).length, 0, "abort must end quietly");
    assert.ok(endedAfterAbort < 6_000);
    assert.ok(!/\b400\b/.test(r.text), "the turn should have been cut short");

    const after = await run("same thread after interrupt", turnInput({ prompt: "Reply with exactly: ok", sessionId: r.sessionId }));
    assert.equal(errors(after).length, 0);
    assert.match(after.text.toLowerCase(), /ok/);
  },

  async hygiene() {
    await stopCodex();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const children = execFileSync("ps", ["-o", "pid=,ppid=,command=", "-ax"], { encoding: "utf8" })
      .split("\n")
      .filter((l) => /codex.*app-server|echo-mcp-codex|code-mode-host/.test(l) && l.trim().split(/\s+/)[1] === String(process.pid));
    console.log(`\n── hygiene: codex children left after stopCodex(): ${children.length}`);
    assert.equal(children.length, 0);
  },
};

const selected = process.argv.slice(2);
const names = selected.length ? selected : Object.keys(tests);
let failed = 0;
for (const name of names) {
  const test = tests[name];
  if (!test) throw new Error(`Unknown test: ${name}`);
  try {
    await test();
    console.log(`✔ ${name}`);
  } catch (err) {
    failed++;
    console.error(`✘ ${name}:`, err instanceof Error ? err.message : err);
  }
}
await stopCodex();
rmSync(dataDir, { recursive: true, force: true });
rmSync(workDir, { recursive: true, force: true });
console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
process.exit(failed ? 1 : 0);
