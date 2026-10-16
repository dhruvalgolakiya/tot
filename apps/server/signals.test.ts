// What a project's Lead hears about on its own (roadmap module 12, lane A): the pull-request watcher against a fake
// GitHub (a TOT draft PR goes red, then green, gets a change request and comments, conflicts, then merges and marks
// its task merged); duplicates; a restart repeating nothing; GitHub's rate limit pausing the watcher; watching every
// open PR (the first look quiet) or none; tickets from intake going to the Lead; the inbox's wakes (batched, read when
// heard, bounded per hour); the routes. Fake model turns; nothing is written to GitHub.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx apps/server/signals.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { LeadSignal, Message, Project, ProjectSubscriptions, SendMessageRequest } from "@tot/shared/types";

// A temp home and a fake gh first on PATH (GitHub's status asks gh who's logged in), so the real ones are never touched.
const HOME = realpathSync.native(mkdtempSync(join(tmpdir(), "tot-signals-home-")));
process.env.HOME = HOME;
process.on("exit", () => rmSync(HOME, { recursive: true, force: true }));
const bin = join(HOME, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test
const PORT = 35_000 + Math.floor(Math.random() * 2000);
const GITHUB_PORT = PORT + 2500;
process.env.TOT_GITHUB_API_URL = `http://127.0.0.1:${GITHUB_PORT}`;
process.env.TOT_GITHUB_WEB_URL = `http://127.0.0.1:${GITHUB_PORT}`;

// --- A fake GitHub: pull requests, their checks, reviews and comments; it answers GETs only ---------------------
const TOKEN = "ghp_signalstoken0123456789";
interface FakePull {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  closed_at: string | null;
  updated_at: string;
  mergeable: boolean | null;
  mergeable_state: string;
  head: { sha: string; ref: string };
  base: { ref: string };
  user: { login: string };
  merged_by: { login: string } | null;
}
const gh = {
  pulls: new Map<string, FakePull>(),
  runs: new Map<string, { name: string; status: string; conclusion: string | null }[]>(),
  statuses: new Map<string, { context: string; state: string }[]>(),
  reviews: new Map<string, unknown[]>(),
  reviewComments: new Map<string, unknown[]>(),
  comments: new Map<string, unknown[]>(),
  /** Answer with a used-up rate limit until this time (epoch seconds), when set. */
  limitedUntil: 0,
  calls: [] as string[],
  writes: [] as string[],
};
let ids = 1000;
const iso = (at = Date.now()) => new Date(at).toISOString();
const key = (c: { req: { param: (name: string) => string } }) => `${c.req.param("owner")}/${c.req.param("repo")}#${c.req.param("number")}`;
function pull(repo: string, number: number, patch: Partial<FakePull> = {}): FakePull {
  const current = gh.pulls.get(`${repo}#${number}`);
  const next: FakePull = {
    number,
    title: "Fix cart",
    html_url: `https://github.com/${repo}/pull/${number}`,
    state: "open",
    draft: true,
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    closed_at: null,
    updated_at: iso(),
    mergeable: null,
    mergeable_state: "unknown",
    head: { sha: "head-1", ref: "tot/fix-cart-ab12" },
    base: { ref: "main" },
    user: { login: "octocat" },
    merged_by: null,
    ...current,
    ...patch,
  };
  gh.pulls.set(`${repo}#${number}`, next);
  return next;
}
/** A comment or review on a PR (it also moves the PR's updated_at, as on GitHub). */
function add(list: Map<string, unknown[]>, pr: string, item: Record<string, unknown>) {
  const id = ++ids;
  list.set(pr, [...(list.get(pr) ?? []), { id, html_url: `https://github.com/${pr.replace("#", "/pull/")}#c${id}`, created_at: iso(), submitted_at: iso(), ...item }]);
  const [repo, number] = pr.split("#");
  pull(repo!, Number(number), { updated_at: iso(Date.now() + ids) });
  return id;
}
const fake = new Hono()
  .use("*", async (c, next) => {
    if (c.req.method !== "GET") gh.writes.push(`${c.req.method} ${c.req.path}`);
    if (c.req.header("authorization") !== `Bearer ${TOKEN}`) return c.json({ message: "Bad credentials" }, 401);
    if (c.req.path !== "/user") gh.calls.push(c.req.path);
    if (gh.limitedUntil && c.req.path !== "/user") {
      c.header("x-ratelimit-remaining", "0");
      c.header("x-ratelimit-reset", String(gh.limitedUntil));
      return c.json({ message: "API rate limit exceeded" }, 403);
    }
    await next();
  })
  .get("/user", (c) => {
    c.header("x-oauth-scopes", "repo, read:org");
    return c.json({ login: "octocat", name: "The Octocat", avatar_url: "https://avatars.example/octocat", id: 583231 });
  })
  .get("/repos/:owner/:repo/pulls", (c) => {
    const repo = `${c.req.param("owner")}/${c.req.param("repo")}`;
    return c.json([...gh.pulls.entries()].filter(([k, p]) => k.startsWith(`${repo}#`) && p.state === "open").map(([, p]) => p));
  })
  .get("/repos/:owner/:repo/pulls/:number", (c) => {
    const found = gh.pulls.get(key(c));
    return found ? c.json(found) : c.json({ message: "Not Found" }, 404);
  })
  .get("/repos/:owner/:repo/pulls/:number/reviews", (c) => c.json(gh.reviews.get(key(c)) ?? []))
  .get("/repos/:owner/:repo/pulls/:number/comments", (c) => {
    const since = Date.parse(c.req.query("since") ?? "") || 0;
    return c.json(((gh.reviewComments.get(key(c)) ?? []) as { created_at: string }[]).filter((comment) => Date.parse(comment.created_at) >= since));
  })
  .get("/repos/:owner/:repo/issues/:number/comments", (c) => {
    const since = Date.parse(c.req.query("since") ?? "") || 0;
    return c.json(((gh.comments.get(key(c)) ?? []) as { created_at: string }[]).filter((comment) => Date.parse(comment.created_at) >= since));
  })
  .get("/repos/:owner/:repo/commits/:sha/check-runs", (c) => {
    const runs = gh.runs.get(c.req.param("sha")) ?? [];
    return c.json({ total_count: runs.length, check_runs: runs });
  })
  .get("/repos/:owner/:repo/commits/:sha/status", (c) => c.json({ state: "pending", statuses: gh.statuses.get(c.req.param("sha")) ?? [] }));
const fakeServer = serve({ fetch: fake.fetch, port: GITHUB_PORT, hostname: "127.0.0.1" });

const { HttpError } = await import("./agent/orchestrator.ts");
const { MessageBuilder } = await import("./agent/message-builder.ts");
const { runRegistry } = await import("./agent/runs.ts");
const { agents } = await import("./data/agents.ts");
const { conversations, toPublicConversation } = await import("./data/conversations.ts");
const { messages } = await import("./data/messages.ts");
const { personas } = await import("./data/personas.ts");
const { queueHolds } = await import("./data/queue-holds.ts");
const { settings } = await import("./data/settings.ts");
const { github } = await import("./github.ts");
const { createApp } = await import("./app.ts");
const { leadInbox } = await import("./lead/inbox.ts");
const { leads } = await import("./lead/lead.ts");
const { intake } = await import("./projects/intake.ts");
const { projects } = await import("./projects/projects.ts");
const { clearGitHubCache } = await import("./signals/github.ts");
const { leadSignals, signalWakes, SIGNAL_WAKES_PER_HOUR } = await import("./signals/store.ts");
const { prWatch } = await import("./signals/watch.ts");
const { childResultsNote } = await import("./tasks/prompt.ts");
const { runLoop } = await import("./tasks/run-loop.ts");
const { taskStore } = await import("./tasks/store.ts");
const { tasks } = await import("./tasks/tasks.ts");
const { chatWakes } = await import("./tasks/wake.ts");
type TurnOptions = import("./agent/orchestrator.ts").TurnOptions;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 400)}` : ""}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end && !condition(); ) await sleep(25);
}
const mascot = { shape: "blob" as const, color: "#60a5fa", accessory: "none" as const, eyes: "dots" as const };

settings.patch({ computer: { mode: "local" } });

// --- Fake model turns: each records what it was sent ---------------------------------------------------------
const sent: { conversationId: string; text: string; preamble: string; auto: boolean }[] = [];
async function fakeSend(conversationId: string, request: SendMessageRequest, options: TurnOptions = {}) {
  if (runRegistry.activeFor(conversationId)) throw new HttpError(409, "Busy.");
  sent.push({ conversationId, text: request.text ?? "", preamble: options.preamble ?? "", auto: Boolean(options.auto) });
  const now = Date.now();
  const user: Message = { id: randomUUID(), conversationId, role: "user", parts: [{ type: "text", id: randomUUID(), text: request.text ?? "" }], status: "complete", createdAt: now };
  messages.insert(user);
  const assistant: Message = { id: randomUUID(), conversationId, role: "assistant", parts: [], status: "streaming", createdAt: now + 1 };
  messages.insert(assistant);
  const run = runRegistry.create(conversationId, assistant.id);
  const builder = new MessageBuilder(assistant, (event) => run.push(event));
  run.reply = () => builder.message;
  void (async () => {
    await sleep(20);
    builder.apply({ type: "text-delta", blockId: randomUUID(), delta: "On it." });
    const final = builder.finish("complete");
    messages.save(final);
    run.push({ type: "run-end", status: "complete", message: final });
    runRegistry.finish(run);
  })();
  return { runId: run.id, userMessage: user, conversation: toPublicConversation(conversations.get(conversationId)!) };
}
runLoop.useSender(fakeSend);

const app = createApp();
const server = serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" });
async function request<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`http://127.0.0.1:${PORT}/api${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

const tot = agents.create({ name: "Tot", mascot });
// Tasks are created here and given a landing by hand; none starts by itself.
queueHolds.set(tot.id, null, "test");
chatWakes.useBatchDelay(150);
chatWakes.start();

let res: { status: number; data: any } = await request<Project>("POST", "/projects", { kind: "github", source: "acme/web" });
const web: Project = res.data;
const lead = leads.open(web.id, tot.id).lead;
const leadTurns = () => sent.filter((turn) => turn.conversationId === lead.id);
const settled = () => until(() => !runRegistry.activeFor(lead.id) && !conversations.get(lead.id)!.wakePending);
const signalsOf = (projectId = web.id) => leadSignals.list(projectId);
const notices = () =>
  messages
    .listByConversation(lead.id)
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "notice")
    .map((p) => (p as { text: string }).text);

/** A task of the project that TOT opened as draft PR #number. */
function prTask(title: string, number: number, repo = "acme/web") {
  const created = tasks.create({ agentId: tot.id, goal: title, title, projectId: web.id });
  taskStore.patch(created.id, { landing: { kind: "pr", at: Date.now(), target: "main", sha: "head-1", pr: { number, url: `https://github.com/${repo}/pull/${number}` } } });
  return taskStore.get(created.id)!;
}

// =============================================================================
// Subscriptions
// =============================================================================
console.log("\n# Subscriptions");
check("a project watches TOT's own PRs by default", web.subscriptions?.pullRequests === "tot", JSON.stringify(web.subscriptions));
res = await request<ProjectSubscriptions>("GET", `/projects/${web.id}/subscriptions`);
check("GET …/subscriptions", res.status === 200 && res.data.pullRequests === "tot", JSON.stringify(res.data));
res = await request("PATCH", `/projects/${web.id}/subscriptions`, { pullRequests: "everything" });
check("PATCH …/subscriptions refuses a value that isn't one", res.status === 400, JSON.stringify(res.data));
res = await request("GET", `/projects/nope/subscriptions`);
check("…and an unknown project is a 404", res.status === 404);

// =============================================================================
// No GitHub connection: quiet
// =============================================================================
console.log("\n# No connection");
const cart = prTask("Fix cart", 12);
pull("acme/web", 12, { head: { sha: "head-1", ref: "tot/fix-cart-ab12" } });
await prWatch.tick();
check("without a GitHub connection the watcher reads nothing and isn't paused", gh.calls.length === 0 && prWatch.paused().reason === null, gh.calls.join(", "));
res = await request("POST", `/projects/${web.id}/signals/check`, {});
check("…and Check now says to connect GitHub", res.status === 409 && /Connect GitHub/.test(res.data.error), JSON.stringify(res.data));
await github.connect({ method: "token", token: TOKEN });

// =============================================================================
// A TOT draft PR: red, then green, reviews and comments, a conflict, merged
// =============================================================================
console.log("\n# A TOT draft PR");
gh.runs.set("head-1", [
  { name: "build", status: "in_progress", conclusion: null },
  { name: "test", status: "queued", conclusion: null },
]);
await prWatch.tick();
check("checks still running: nothing yet", signalsOf().length === 0, JSON.stringify(signalsOf()));
check("the PR, its checks and its conversation were read", ["/repos/acme/web/pulls/12", "/repos/acme/web/commits/head-1/check-runs", "/repos/acme/web/issues/12/comments"].every((p) => gh.calls.some((c) => c.startsWith(p))), gh.calls.join(", "));

gh.runs.set("head-1", [
  { name: "build", status: "completed", conclusion: "failure" },
  { name: "test", status: "completed", conclusion: "success" },
]);
gh.statuses.set("head-1", [{ context: "lint", state: "error" }]);
gh.calls.length = 0;
await prWatch.tick();
let all = signalsOf();
const red = all.find((s) => s.kind === "ci-failed");
check(
  "checks failed: a ci-failed signal naming the failing checks",
  all.length === 1 && red?.title === "Checks failed on draft PR #12 “Fix cart”" && red.detail === "Failing: build, lint (2 of 3 checks)." && red.taskId === cart.id && red.prNumber === 12 && red.repoName === "web",
  JSON.stringify(all),
);
check("…with a link to the PR's checks", red?.url === "https://github.com/acme/web/pull/12/checks", red?.url ?? "");
check("…a note in the Lead's chat", notices().includes("Checks failed on draft PR #12 “Fix cart”"), notices().join(" | "));
check("…and only the conversation wasn't read again (it didn't change)", !gh.calls.some((c) => c.includes("/comments") || c.includes("/reviews")), gh.calls.join(", "));
await until(() => leadTurns().length > 0);
check(
  "the Lead is woken with one auto turn (in TOT's own words) whose note lists it",
  leadTurns().length === 1 && leadTurns()[0]!.auto && leadTurns()[0]!.text === "News: checks failed on a pull request." && leadTurns()[0]!.preamble.includes('"kind": "ci-failed"') && leadTurns()[0]!.preamble.includes("Failing: build, lint"),
  JSON.stringify(leadTurns()),
);
await settled();
check("…and the signal is read once the turn has it", leadSignals.get(red!.id)?.readAt !== null);

gh.calls.length = 0;
await prWatch.tick();
check("looking again: the same failure isn't news twice", signalsOf().length === 1 && leadTurns().length === 1, JSON.stringify(signalsOf().map((s) => s.title)));
check("…though settled checks are read again for a while (late workflows, re-runs)", gh.calls.some((c) => c.includes("check-runs")), gh.calls.join(", "));

// The task pushed a fix: a new head, its checks pass.
pull("acme/web", 12, { head: { sha: "head-2", ref: "tot/fix-cart-ab12" } });
gh.runs.set("head-2", [
  { name: "build", status: "completed", conclusion: "success" },
  { name: "test", status: "completed", conclusion: "success" },
]);
gh.statuses.set("head-2", [{ context: "lint", state: "success" }]);
await prWatch.tick();
all = signalsOf();
check("a new head whose checks pass: ci-passed", all[0]?.kind === "ci-passed" && all[0].title === "Checks passed on draft PR #12 “Fix cart”" && all[0].detail === "3 checks passed.", JSON.stringify(all[0]));
await until(() => leadTurns().length === 2);
await settled();

// A change request with line comments, a comment from someone, one from TOT's own persona account, one from a bot.
const persona = personas.create({ name: "Ivy", email: "ivy@example.com" });
personas.setGitHubAccount(persona.id, { login: "ivy-tot", name: "Ivy", avatarUrl: null, allowWrites: false, problem: null, id: 777 });
const review = add(gh.reviews, "acme/web#12", { user: { login: "alice" }, state: "CHANGES_REQUESTED", body: "A couple of things.\n\nPlease rename the helper." });
add(gh.reviewComments, "acme/web#12", { user: { login: "alice" }, body: "This should handle an empty cart.", path: "src/cart.ts", line: 14, pull_request_review_id: review });
add(gh.comments, "acme/web#12", { user: { login: "bob", type: "User" }, body: "Can we ship this today?\nThe launch is tomorrow." });
add(gh.comments, "acme/web#12", { user: { login: "ivy-tot", type: "User" }, body: "Pushed the fix." });
add(gh.comments, "acme/web#12", { user: { login: "vercel[bot]", type: "Bot" }, body: "Preview deployed." });
const turnsBefore = leadTurns().length;
await prWatch.tick();
const changes = signalsOf().find((s) => s.kind === "changes-requested");
const comment = signalsOf().find((s) => s.kind === "comment");
check(
  "changes requested: who, the review's first lines and its line comments",
  changes?.title === "@alice asked for changes on draft PR #12 “Fix cart”" && /A couple of things\./.test(changes.detail ?? "") && /src\/cart\.ts:14: This should handle an empty cart\./.test(changes.detail ?? ""),
  JSON.stringify(changes),
);
check("a comment: who and its first lines", comment?.title === "@bob commented on draft PR #12 “Fix cart”" && comment.detail === "Can we ship this today?\nThe launch is tomorrow.", JSON.stringify(comment));
check(
  "never TOT's own account, nor a bot; the line comment rides in its review",
  !signalsOf().some((s) => /ivy-tot|vercel/.test(s.title)) && !signalsOf().some((s) => s.kind === "review-comment"),
  JSON.stringify(signalsOf().map((s) => s.title)),
);
await until(() => leadTurns().length > turnsBefore);
await sleep(400);
const both = leadTurns().slice(turnsBefore);
check(
  "signals that come together wake the Lead once",
  both.length === 1 && both[0]!.text === "2 updates: a review asked for changes, a comment on a pull request.",
  JSON.stringify(both.map((t) => t.text)),
);
await settled();

// A reply in a review thread, by itself: a review-comment.
add(gh.reviewComments, "acme/web#12", { user: { login: "alice" }, body: "Thanks, looks better.", path: "src/cart.ts", line: 20, pull_request_review_id: null });
await prWatch.tick();
check("a line comment on its own: review-comment", signalsOf()[0]?.kind === "review-comment" && signalsOf()[0]!.title === "@alice commented on src/cart.ts in draft PR #12 “Fix cart”", JSON.stringify(signalsOf()[0]));
await until(() => leadTurns().length > turnsBefore + 1);
await settled();

// A review still being written (only its author sees it) isn't news; once it's submitted, it is, with its comments.
const draftReview = add(gh.reviews, "acme/web#12", { user: { login: "octocat" }, state: "PENDING", body: "Some thoughts.", submitted_at: null });
add(gh.reviewComments, "acme/web#12", { user: { login: "octocat" }, body: "Maybe rename this.", path: "src/cart.ts", line: 3, pull_request_review_id: draftReview });
await prWatch.tick();
check("a review still being written isn't news", !signalsOf().some((s) => s.title.includes("@octocat")), JSON.stringify(signalsOf()[0]));
const submitted = (gh.reviews.get("acme/web#12") as { id: number; state: string; submitted_at: string | null }[]).find((r) => r.id === draftReview)!;
Object.assign(submitted, { state: "COMMENTED", submitted_at: iso() });
pull("acme/web", 12, { updated_at: iso(Date.now() + 5) });
await prWatch.tick();
check(
  "…once submitted it is, with its line comments",
  signalsOf()[0]?.kind === "review-comment" && signalsOf()[0]!.title === "@octocat reviewed draft PR #12 “Fix cart”" && /src\/cart\.ts:3: Maybe rename this\./.test(signalsOf()[0]!.detail ?? ""),
  JSON.stringify(signalsOf()[0]),
);
await until(() => leadTurns().length > turnsBefore + 2);
await settled();

// =============================================================================
// A restart repeats nothing
// =============================================================================
console.log("\n# Restart");
const countBefore = signalsOf().length;
const turnsAtRestart = leadTurns().length;
chatWakes.stop();
prWatch.reset();
clearGitHubCache();
chatWakes.start();
await prWatch.tick();
await sleep(400);
check("after a restart, what was seen isn't news again", signalsOf().length === countBefore && leadTurns().length === turnsAtRestart, `${signalsOf().length} vs ${countBefore}`);

// A signal stored but not heard when TOT stopped wakes the Lead after the restart.
chatWakes.stop();
const pending = leadInbox.post(web.id, { kind: "schedule", title: "Weekday check-in: what's stuck?", detail: "Look at the board and say what's stuck.", url: null, repoName: null, taskId: null, prNumber: null });
await sleep(300);
check("while TOT is stopping, a new signal waits (no turn)", Boolean(pending) && leadTurns().length === turnsAtRestart && conversations.get(lead.id)!.wakePending);
chatWakes.start();
await until(() => leadTurns().length > turnsAtRestart);
check("…and wakes the Lead once it's back", leadTurns().at(-1)?.text === "News: schedule “Weekday check-in: what's stuck”." && leadSignals.get(pending!.id)?.readAt !== null, JSON.stringify(leadTurns().at(-1)));
await settled();

// =============================================================================
// GitHub's rate limit
// =============================================================================
console.log("\n# Rate limit");
gh.limitedUntil = Math.ceil(Date.now() / 1000) + 2;
pull("acme/web", 12, { mergeable: false, mergeable_state: "dirty", updated_at: iso(Date.now() + 1) });
await prWatch.tick();
check("a used-up rate limit pauses the watcher until it resets", prWatch.paused().reason === "rate-limit" && prWatch.paused().until === gh.limitedUntil * 1000, JSON.stringify(prWatch.paused()));
gh.calls.length = 0;
await prWatch.tick();
check("…it asks GitHub nothing meanwhile", gh.calls.length === 0, gh.calls.join(", "));
res = await request("POST", `/projects/${web.id}/signals/check`, {});
check("…and Check now says when it looks again", res.status === 409 && /rate limit/i.test(res.data.error), JSON.stringify(res.data));
gh.limitedUntil = 0;
await until(() => prWatch.paused().reason === null, 5000);
await prWatch.tick();
const conflict = signalsOf().find((s) => s.kind === "pr-conflict");
check("once it resets, it carries on: a conflict with the base", conflict?.title === "Draft PR #12 “Fix cart” has conflicts with main", JSON.stringify(signalsOf()[0]));
await settled();

// =============================================================================
// Merged: the task's landing follows
// =============================================================================
console.log("\n# Merged");
pull("acme/web", 12, { state: "closed", merged: true, merged_at: iso(), merge_commit_sha: "merge-sha-1", closed_at: iso(), draft: false, merged_by: { login: "alice" } });
res = await request<LeadSignal[]>("POST", `/projects/${web.id}/signals/check`, {});
const checked: LeadSignal[] = res.data;
const merged = checked.find((s) => s.kind === "pr-merged");
check("Check now: merged, answered with the project's signals", res.status === 200 && merged?.title === "PR #12 “Fix cart” was merged into main by @alice", JSON.stringify(checked.slice(0, 2)));
const landed = taskStore.get(cart.id)!.task.landing;
check(
  "a merged TOT PR marks its task merged (the PR kept)",
  landed?.kind === "merged" && landed.sha === "merge-sha-1" && landed.target === "main" && landed.pr?.number === 12,
  JSON.stringify(landed),
);
gh.calls.length = 0;
await prWatch.tick();
check("a merged PR isn't watched any more", !gh.calls.some((c) => c.includes("/pulls/12")), gh.calls.join(", "));
await settled();
check("nothing was ever written to GitHub", gh.writes.length === 0, gh.writes.join(", "));

// =============================================================================
// Watching every open PR, and none
// =============================================================================
console.log("\n# All PRs, and off");
pull("acme/web", 30, { title: "Bump deps", draft: false, head: { sha: "head-30", ref: "deps" }, user: { login: "dependabot" } });
gh.runs.set("head-30", [{ name: "build", status: "completed", conclusion: "failure" }]);
add(gh.comments, "acme/web#30", { user: { login: "carol", type: "User" }, body: "Old comment." });
const beforeAll = signalsOf().length;
res = await request<ProjectSubscriptions>("PATCH", `/projects/${web.id}/subscriptions`, { pullRequests: "all" });
check("PATCH …/subscriptions to every open PR", res.status === 200 && res.data.pullRequests === "all" && projects.get(web.id)!.subscriptions?.pullRequests === "all", JSON.stringify(res.data));
await prWatch.tick();
check("a PR TOT didn't open is looked at quietly the first time (its red checks and old comments aren't news)", signalsOf().length === beforeAll, JSON.stringify(signalsOf().slice(0, 2)));
add(gh.comments, "acme/web#30", { user: { login: "carol", type: "User" }, body: "Should we pin this?" });
pull("acme/web", 30, { head: { sha: "head-31", ref: "deps" } });
gh.runs.set("head-31", [{ name: "build", status: "completed", conclusion: "success" }]);
await prWatch.tick();
const news = signalsOf().slice(0, signalsOf().length - beforeAll);
check(
  "…after that, what changes is: a new comment, and green after red",
  news.some((s) => s.kind === "comment" && s.title === "@carol commented on PR #30 “Bump deps”" && s.taskId === null) && news.some((s) => s.kind === "ci-passed" && s.prNumber === 30),
  JSON.stringify(news.map((s) => s.title)),
);
pull("acme/web", 30, { state: "closed", closed_at: iso() });
await prWatch.tick();
check("a PR closed without merging (gone from the open list): pr-closed", signalsOf()[0]?.kind === "pr-closed" && signalsOf()[0]!.title === "PR #30 “Bump deps” was closed without merging", JSON.stringify(signalsOf()[0]));
await settled();

await request("PATCH", `/projects/${web.id}/subscriptions`, { pullRequests: "off" });
prTask("Fix search", 40);
pull("acme/web", 40, { title: "Fix search", head: { sha: "head-40", ref: "tot/fix-search" } });
gh.calls.length = 0;
await prWatch.tick();
check("watching off: nothing is read", gh.calls.length === 0, gh.calls.join(", "));
res = await request("POST", `/projects/${web.id}/signals/check`, {});
check("…and Check now says it's off", res.status === 409 && /doesn't watch pull requests/.test(res.data.error), JSON.stringify(res.data));
await request("PATCH", `/projects/${web.id}/subscriptions`, { pullRequests: "tot" });
await sleep(200);

// =============================================================================
// The inbox: duplicates, no Lead
// =============================================================================
console.log("\n# The inbox");
const fact = { kind: "comment" as const, title: "@dan commented on PR #9", detail: "Hi.", url: null, repoName: "web", taskId: null, prNumber: 9 };
const first = leadInbox.post(web.id, fact, { key: "test:dan:1" });
check("a keyed signal is stored once", Boolean(first) && leadInbox.post(web.id, { ...fact, detail: "Edited." }, { key: "test:dan:1" }) === null);
const schedule = { kind: "schedule" as const, title: "Daily: what's stuck?", detail: "Say what's stuck.", url: null, repoName: null, taskId: null, prNumber: null };
const daily = leadInbox.post(web.id, schedule);
check("without a key, an identical one is a duplicate while the first is unread", Boolean(daily) && leadInbox.post(web.id, schedule) === null);
await settled();
check("…and stored again once the Lead heard it (tomorrow's schedule)", leadSignals.get(daily!.id)?.readAt !== null && leadInbox.post(web.id, schedule) !== null);
await settled();
res = await request<Project>("POST", "/projects", { kind: "github", source: "acme/api" });
const api = res.data;
check("a project without a Lead: nothing stored", leadInbox.post(api.id, fact) === null && signalsOf(api.id).length === 0);

// =============================================================================
// Tickets go to the Lead
// =============================================================================
console.log("\n# Tickets");
await request("PATCH", `/projects/${web.id}`, { intake: { slackChannels: ["#web-bugs"] } });
const turnsBeforeTicket = leadTurns().length;
const went = intake.toLead({
  slackChannel: "web-bugs",
  text: "The cart button is broken, see https://github.com/acme/web/issues/7",
  who: "Alex Kim",
  where: "in #web-bugs",
  url: "https://acme.slack.com/archives/C1/p1",
  key: "slack:C1:1.0",
});
const ticket = signalsOf()[0];
check("work from a project's Slack channel goes to its Lead", went?.id === web.id, String(went?.name));
check(
  "…as a ticket: who, where, the text, the link",
  ticket?.kind === "ticket" && ticket.title === "acme/web#7 from Alex Kim in #web-bugs" && ticket.detail === "The cart button is broken, see https://github.com/acme/web/issues/7" && ticket.url === "https://github.com/acme/web/issues/7",
  JSON.stringify(ticket),
);
await until(() => leadTurns().length > turnsBeforeTicket);
check("…which wakes the Lead", leadTurns().at(-1)?.text === "News: a new ticket." && leadTurns().at(-1)!.preamble.includes('"kind": "ticket"'), JSON.stringify(leadTurns().at(-1)));
await settled();
const again = intake.toLead({ slackChannel: "web-bugs", text: "The cart button is broken", who: "Alex Kim", where: "in #web-bugs", key: "slack:C1:1.0" });
check("the same message seen twice: one ticket", again?.id === web.id && signalsOf().filter((s) => s.kind === "ticket").length === 1);
const plain = intake.toLead({ slackChannel: "random", text: "Hello", who: "Alex Kim", where: "in #random", key: "slack:C2:1.0" });
check("work that's no project's intake: not the Lead's (the caller starts a chat, as before)", plain === null);
await request("PATCH", `/projects/${api.id}`, { intake: { slackChannels: ["#api-bugs"] } });
check("…nor work for a project without a Lead", intake.toLead({ slackChannel: "api-bugs", text: "API is down", who: "Alex Kim", where: "in #api-bugs", key: "slack:C3:1.0" }) === null);

// =============================================================================
// The hourly bound
// =============================================================================
console.log("\n# The hourly bound");
await settled();
signalWakes.clear(web.id);
// The hour's wakes are used up; the oldest of them leaves the hour in about 1.5 s.
const hourAgo = Date.now() - 60 * 60_000;
signalWakes.record(web.id, hourAgo + 1500);
for (let i = 1; i < SIGNAL_WAKES_PER_HOUR; i++) signalWakes.record(web.id, Date.now() - 1000);
const turnsAtBound = leadTurns().length;
const bounded = leadInbox.post(web.id, { kind: "comment", title: "@erin commented on PR #9", detail: "One more thing.", url: null, repoName: "web", taskId: null, prNumber: 9 })!;
await sleep(500);
check(
  `past ${SIGNAL_WAKES_PER_HOUR} signal wakes in an hour, a signal waits (no turn, still unread)`,
  leadTurns().length === turnsAtBound && leadSignals.get(bounded.id)?.readAt === null && conversations.get(lead.id)!.wakePending,
  `${leadTurns().length - turnsAtBound} turns`,
);
await until(() => leadTurns().length > turnsAtBound, 5000);
check("…and wakes the Lead once the next one fits", leadTurns().at(-1)?.text === "News: a comment on a pull request." && leadSignals.get(bounded.id)?.readAt !== null, JSON.stringify(leadTurns().at(-1)));
await settled();

// The Lead's own next turn reads unread signals too (the note its turn starts with).
chatWakes.stop();
const quietOne = leadInbox.post(web.id, { kind: "ticket", title: "ENG-5 from Sam by email", detail: "Please look.", url: null, repoName: null, taskId: null, prNumber: null })!;
const note = childResultsNote(conversations.get(lead.id)!);
check("the Lead's next turn gets its unread signals, and they're read", note.includes('"title": "ENG-5 from Sam by email"') && leadSignals.get(quietOne.id)?.readAt !== null, note.slice(0, 200));
check("…a plain chat gets none", childResultsNote({ ...conversations.get(lead.id)!, lead: false }) === "");
chatWakes.start();

// =============================================================================
// GET …/signals
// =============================================================================
console.log("\n# Listing");
res = await request<LeadSignal[]>("GET", `/projects/${web.id}/signals?limit=3`);
const listed: LeadSignal[] = res.data;
check(
  "GET …/signals: newest first, as many as asked",
  res.status === 200 && listed.length === 3 && listed[0]!.id === quietOne.id && listed.every((s, i) => i === 0 || listed[i - 1]!.at >= s.at),
  JSON.stringify(listed.map((s) => s.title)),
);
res = await request("GET", `/projects/nope/signals`);
check("…an unknown project is a 404", res.status === 404);

chatWakes.stop();
prWatch.stop();
server.close();
fakeServer.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
