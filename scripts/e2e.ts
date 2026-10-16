// End-to-end check against a running TOT server: sends one message and follows the stream.
// Usage: npx tsx scripts/e2e.ts "your message" [modelId]
//   modelId defaults to "auto"; e.g. "chatgpt:gpt-6.1-sol" or "claude:claude-sonnet-5-5".
//   Set TOT_E2E_CONVERSATION=<id> to continue an existing chat.
//   Set TOT_E2E_ATTACH=<file>[,<file>...] to upload and attach files.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Attachment, Conversation, RunEvent, SendMessageResponse } from "@tot/shared/types";

try {
  process.loadEnvFile(".env");
} catch {
  // no .env
}
const base = `http://127.0.0.1:${process.env.TOT_PORT ?? 8787}/api`;
// With sign-in on, scripts authenticate with the access token.
const auth: Record<string, string> = process.env.TOT_ACCESS_TOKEN?.trim()
  ? { authorization: `Bearer ${process.env.TOT_ACCESS_TOKEN.trim()}` }
  : {};
const text = process.argv[2] ?? "Reply with exactly: pong";
const modelId = process.argv[3] ?? "auto";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, { ...init, headers: { "content-type": "application/json", ...auth, ...init?.headers } });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${res.status} ${path}: ${body.error ?? JSON.stringify(body)}`);
  return body;
}

const conversationId =
  process.env.TOT_E2E_CONVERSATION ??
  (await api<Conversation>("/conversations", { method: "POST", body: JSON.stringify({ modelId }) })).id;

const attachments: string[] = [];
for (const path of (process.env.TOT_E2E_ATTACH ?? "").split(",").filter(Boolean)) {
  const form = new FormData();
  form.set("file", new File([readFileSync(path)], basename(path), { type: guessType(path) }));
  const res = await fetch(`${base}/uploads`, { method: "POST", body: form, headers: auth });
  const uploaded = (await res.json()) as Attachment & { error?: string };
  if (!res.ok) throw new Error(`upload ${path}: ${uploaded.error}`);
  console.log(`attached ${uploaded.name} (${uploaded.mimeType}, ${uploaded.size} B)`);
  attachments.push(uploaded.id);
}

function guessType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", csv: "text/csv", txt: "text/plain", json: "application/json", zip: "application/zip" }[ext ?? ""] ?? "application/octet-stream";
}

const started = Date.now();
const sent = await api<SendMessageResponse>(`/conversations/${conversationId}/messages`, {
  method: "POST",
  body: JSON.stringify({ text, modelId, attachments }),
});
console.log(`chat ${conversationId} · run ${sent.runId}`);

const res = await fetch(`${base}/runs/${sent.runId}/events`, { headers: auth });
if (!res.body) throw new Error("no stream");
const decoder = new TextDecoder();
let buffer = "";
let firstToken = 0;
let done = false;

for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let boundary: number;
  while ((boundary = buffer.indexOf("\n\n")) !== -1) {
    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    const event = JSON.parse(data) as RunEvent;
    switch (event.type) {
      case "run-start":
        console.log(`→ ${event.provider} ${event.model} (${event.routeReason ?? ""})`);
        break;
      case "part-start":
        if (event.part.type === "text" || event.part.type === "reasoning") {
          if (event.part.type === "text" && !firstToken) firstToken = Date.now() - started;
          process.stdout.write(event.part.type === "reasoning" ? `\n[thinking] ${event.part.text}` : `\n${event.part.text}`);
        } else if (event.part.type === "tool") {
          console.log(`\n[tool] ${event.part.title ?? event.part.name}`);
        } else if (event.part.type === "notice") {
          console.log(`\n[${event.part.kind}] ${event.part.text}`);
        }
        break;
      case "part-delta":
        process.stdout.write(event.delta);
        break;
      case "part-update":
        if (event.part.type === "tool" && event.part.status !== "running") {
          console.log(`\n[tool ${event.part.status}] ${event.part.name}: ${(event.part.output ?? "").slice(0, 200).replace(/\n/g, " ⏎ ")}`);
        }
        break;
      case "computer":
        console.log(`\n[computer] ${event.computer.state} · ${event.computer.label}`);
        break;
      case "conversation":
        console.log(`\n[title] ${event.conversation.title}`);
        break;
      case "error":
        console.log(`\n[error] ${event.message}`);
        break;
      case "run-end":
        console.log(
          `\n\n✓ ${event.status}${event.message.error ? ` — ${event.message.error}` : ""} · model ${event.message.model} · first token ${firstToken}ms · total ${Date.now() - started}ms · usage ${JSON.stringify(event.message.usage ?? {})}`,
        );
        done = true;
        break;
    }
  }
  if (done) break;
}
process.exit(0);
