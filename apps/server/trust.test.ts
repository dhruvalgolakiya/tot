// Trust gates & playbooks (module 03): repo profiles, gates, the reviewer and playbooks, against
// temporary git repos on the local computer backend and a fake model (no real model is called).
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx apps/server/trust.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import type { CommandRun, ProviderStatus, RepoProfile } from "@tot/shared/types";
import type { ModelCall } from "./trust/model.ts";

process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test

const { computerManager } = await import("./computer/manager.ts");
const { setSecret } = await import("./config.ts");
const { agents } = await import("./data/agents.ts");
const { brains } = await import("./data/brains.ts");
const { settings } = await import("./data/settings.ts");
const { wiki } = await import("./data/wiki.ts");
const { createApp } = await import("./app.ts");
const { trustModel } = await import("./trust/model.ts");
const { PROFILE_TITLE, detectProfile, draftAfterLearning, repoFolder } = await import("./trust/profile.ts");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 220)}` : ""}`);
}

const app = createApp();
async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await app.request(`http://localhost:8787/api${path}`, {
    method,
    headers: { Host: "localhost:8787", Origin: "http://localhost:8787", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as T };
}

// --- A fake model: both providers logged in; answers come from whatever the test queues ----------------
const statuses: ProviderStatus[] = [
  { id: "claude", label: "Claude", installed: true, loggedIn: true, models: [] },
  {
    id: "chatgpt",
    label: "ChatGPT",
    installed: true,
    loggedIn: true,
    // The account's default first, as ChatGPT lists them: it's the deep tier (orchestration/tiers.ts).
    models: [
      { id: "chatgpt:gpt-astra", provider: "chatgpt", model: "gpt-astra", label: "Astra", available: true },
      { id: "chatgpt:gpt-luna", provider: "chatgpt", model: "gpt-luna", label: "Luna", available: true },
    ],
  },
];
const calls: ModelCall[] = [];
let answer: (call: ModelCall) => string = () => "{}";
trustModel.use({
  statuses: async () => statuses,
  complete: async (call) => {
    calls.push(call);
    return answer(call);
  },
});

// --- A real-shaped repo on the agent's local computer ---------------------------------------------------
settings.patch({ computer: { mode: "local" } });
const agent = agents.create({ name: "Builder", mascot: agents.first().mascot });
const active = await computerManager.ensure(agent.id);
async function run(command: string, cwd?: string) {
  const result = await active.backend.exec(active.externalId, command, { cwd, timeoutMs: 120_000 });
  if (result.exitCode !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
const GIT = "git -c user.name=Test -c user.email=test@example.com -c init.defaultBranch=main -c commit.gpgsign=false";
async function write(folder: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) await active.backend.writeFile(active.externalId, `${folder}/${path}`, content);
}

const shop = "repos/shop";
await write(shop, {
  "package.json": JSON.stringify(
    {
      name: "shop",
      private: true,
      scripts: { dev: "vite", build: "vite build", typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest run", "test:e2e": "playwright test" },
      dependencies: { react: "^19.0.0" },
      devDependencies: { typescript: "^5.0.0", vitest: "^3.0.0", eslint: "^9.0.0", "@playwright/test": "^1.0.0" },
    },
    null,
    2,
  ),
  "package-lock.json": "{}\n",
  "tsconfig.json": "{}\n",
  "AGENTS.md": "# Rules\nUse the Result type.\n",
  ".github/workflows/ci.yml": "on: push\n",
  "db/migrations/001_init.sql": "create table carts (id int);\n",
  "src/cart.ts": "export const total = (items: number[]) => items.reduce((a, b) => a + b, 0);\n",
  "src/cart.test.ts": "import { total } from './cart';\n",
});
await run(`${GIT} init -q && ${GIT} add -A && ${GIT} commit -qm init`, shop);

// --- M1 · Repo profile ----------------------------------------------------------------------------------
const brain = brains.create({ name: "acme/shop", kind: "repo", source: "https://github.com/acme/shop.git", agentId: agent.id });
check("repo folder for a URL is ~/repos/<name>", repoFolder(brain.source!) === "repos/shop" && repoFolder("~/code/api/") === "code/api");

const detected = detectProfile({
  manifests: { "pyproject.toml": "[tool.poetry]\n[tool.pytest.ini_options]\n[tool.ruff]\n", Makefile: "test:\n\tpytest\n" },
  files: ["poetry.lock", "app/main.py", "tests/test_main.py", "alembic/versions/1_init.py"],
});
check(
  "python repo: poetry, pytest, ruff and alembic migrations",
  detected.commands.install === "poetry install" &&
    detected.commands.test === "poetry run pytest" &&
    detected.commands.testFile === "poetry run pytest {file}" &&
    detected.commands.lint === "poetry run ruff check ." &&
    detected.protectedPaths.includes("alembic/versions/**"),
  JSON.stringify(detected),
);

let res = await request<RepoProfile | null>("GET", `/brains/${brain.id}/profile`);
check("no profile until one is saved", res.status === 200 && res.json === null);
const notes = brains.create({ name: "Acme notes" });
check("a notes brain has no profile", (await request("GET", `/brains/${notes.id}/profile`)).status === 400);

// Learn a repo wrote its pages; the hook drafts the profile from the code and those notes.
wiki.create(brain.id, { title: "Run, test & deploy", content: "Run one test: `npx vitest run path/to/file.test.ts`. Seed data with `npm run seed`." }, "agent");
wiki.create(brain.id, { title: "Conventions & gotchas", content: "Prices are integers in cents. Never edit generated/ by hand." }, "agent");
answer = () =>
  'Here you go:\n```json\n{"commands":{"test":"npm run everything","seed":"npm run seed"},"conventions":["Prices are integers in cents"],"definitionOfDone":["Tests for new behaviour"],"protectedPaths":["generated/**"]}\n```';
await draftAfterLearning(brain.id, agent.id);
res = await request<RepoProfile | null>("GET", `/brains/${brain.id}/profile`);
const drafted = res.json!;
check(
  "drafted commands come from package.json",
  drafted.commands.install === "npm ci" &&
    drafted.commands.typecheck === "npm run typecheck" &&
    drafted.commands.lint === "npm run lint" &&
    drafted.commands.test === "npm test" &&
    drafted.commands.testFile === "npx vitest run {file}" &&
    drafted.commands.build === "npm run build" &&
    drafted.commands.e2e === "npm run test:e2e",
  JSON.stringify(drafted.commands),
);
check("the model can't replace a detected command or invent one", drafted.commands.test === "npm test" && !("seed" in drafted.commands));
check(
  "protected paths: CI, migrations, and generated code from the notes",
  [".github/**", "db/migrations/**", "generated/**"].every((glob) => drafted.protectedPaths.includes(glob)),
  JSON.stringify(drafted.protectedPaths),
);
check(
  "conventions from AGENTS.md and the notes",
  drafted.conventions.includes("Follow the rules in AGENTS.md") && drafted.conventions.includes("Prices are integers in cents"),
  JSON.stringify(drafted.conventions),
);
check("a light model refined it", calls.at(-1)?.model === "claude-sonnet-5-5" && drafted.updatedBy === "agent");
let page = wiki.withTitle(brain.id, PROFILE_TITLE, null)[0];
check("the profile is a page in the brain", Boolean(page?.content.includes("`npm run typecheck`") && page.content.includes("Drafted from the code")), page?.content.slice(0, 200));

// The user edits it; edits persist and show in the brain.
const edited = {
  ...drafted,
  commands: { ...drafted.commands, e2e: "" },
  protectedPaths: [...drafted.protectedPaths, "./infra/**"],
  limits: { ...drafted.limits, maxChangedLines: 400 },
};
const put = await request<RepoProfile>("PUT", `/brains/${brain.id}/profile`, edited);
check("edit saved", put.status === 200 && put.json.updatedBy === "user" && !put.json.commands.e2e && put.json.protectedPaths.includes("infra/**"), JSON.stringify(put.json));
res = await request<RepoProfile>("GET", `/brains/${brain.id}/profile`);
check("edit persists", res.json?.limits.maxChangedLines === 400 && res.json.updatedBy === "user");
page = wiki.withTitle(brain.id, PROFILE_TITLE, null)[0];
check("the brain page shows the edit", Boolean(page?.content.includes("400 changed lines") && page.content.includes("Edited by the user") && !page.content.includes("test:e2e")));
check("a later Learn a repo keeps the user's profile", await draftAfterLearning(brain.id, agent.id).then(() => (wiki.withTitle(brain.id, PROFILE_TITLE, null)[0]?.content ?? "").includes("400 changed lines")));

const bad = await request<{ error: string }>("PUT", `/brains/${brain.id}/profile`, { ...edited, commands: { testFile: "npx vitest run" } });
check("one-file test command needs {file}", bad.status === 400 && /\{file\}/.test(bad.json.error), bad.json.error);
check("commands stay on one line", (await request("PUT", `/brains/${brain.id}/profile`, { ...edited, commands: { test: "npm test\nrm -rf /" } })).status === 400);
check("unknown command names are refused", (await request("PUT", `/brains/${brain.id}/profile`, { ...edited, commands: { deploy: "npm run deploy" } })).status === 400);

// "Run now" runs in the repo's folder and never shows a secret.
setSecret("githubToken", "ghp_abcdefghijklmnopqrstuvwxyz0123456789");
const ran = await request<CommandRun>("POST", `/brains/${brain.id}/profile/run`, { agentId: agent.id, command: "pwd && echo token ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
check("run now: exit code and output", ran.status === 200 && ran.json.exitCode === 0 && ran.json.outputTail.includes("repos/shop"), JSON.stringify(ran.json));
check("run now: secrets hidden", !JSON.stringify(ran.json).includes("ghp_abc") && ran.json.outputTail.includes("[GitHub token hidden]"));
setSecret("githubToken", "");
const failing = await request<CommandRun>("POST", `/brains/${brain.id}/profile/run`, { agentId: agent.id, command: "echo nope >&2; exit 3" });
check("run now: failures come back as results", failing.status === 200 && failing.json.exitCode === 3 && failing.json.outputTail.includes("nope"));
const elsewhere = brains.create({ name: "acme/api", kind: "repo", source: "https://github.com/acme/api", agentId: agent.id });
const missing = await request<{ error: string }>("POST", `/brains/${elsewhere.id}/profile/draft`, { agentId: agent.id });
check("draft for a repo that isn't cloned says so", missing.status === 400 && /isn't on Builder's computer/.test(missing.json.error), missing.json.error);

// --- M2 · Gates -----------------------------------------------------------------------------------------
const { blocks, failureLines, runGates } = await import("./trust/gates.ts");
const { citedPaths, globMatcher } = await import("./trust/scope.ts");
const { db } = await import("./db.ts");

const glob = (pattern: string, path: string) => globMatcher(pattern)(path);
check(
  "globs: ** spans folders, * doesn't, bare names match at any depth",
  glob("db/migrations/**", "db/migrations/001.sql") &&
    !glob("migrations/**", "db/migrations/001.sql") &&
    glob("**/migrations/**", "db/migrations/001.sql") &&
    glob("*.lock", "deep/yarn.lock") &&
    glob(".github/", ".github/workflows/ci.yml") &&
    glob("src/**/*.ts", "src/a.ts") &&
    !glob("src/*.ts", "src/deep/a.ts"),
);
const cited = citedPaths("Change `src/cart.ts:42` and src/checkout.js (line 7–9), add test/cart.test.js, see package.json and https://example.com/docs/a.md. Also e.g. this.");
check(
  "plans: cited paths without line numbers or URLs",
  ["src/cart.ts", "src/checkout.js", "test/cart.test.js", "package.json"].every((path) => cited.includes(path)) && !cited.some((path) => /example|e\.g/.test(path)),
  JSON.stringify(cited),
);
check(
  "failure lines ignore folders, timings and counts",
  JSON.stringify(failureLines("✖ subtracts (1.2ms)\n  at /work/a/test.js:3:9\n# fail 1", ["/work/a"])) ===
    JSON.stringify(failureLines("✖ subtracts (7.9ms)\n  at /base/b/test.js:3:9\n# fail 1", ["/base/b"])),
);

const repo = "repos/gates";
await write(repo, {
  "package.json": JSON.stringify({ name: "gates", type: "module", scripts: { test: "node --test", lint: "node lint.mjs" }, dependencies: {} }, null, 2),
  "package-lock.json": "{}\n",
  "lint.mjs": "process.exit(0);\n",
  "src/math.js": "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a + b; // the old bug\n",
  "test/math.test.js":
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, sub } from '../src/math.js';\n\ntest('adds', () => assert.equal(add(2, 2), 4));\ntest('legacy subtracts', () => assert.equal(sub(5, 3), 2));\n",
  "migrations/001.sql": "create table t (id int);\n",
});
await run(`${GIT} init -q && ${GIT} add -A && ${GIT} commit -qm base && git checkout -qb work`, repo);
const profile = { ...detectProfile({ manifests: {}, files: [] }), commands: { test: "npm test", lint: "npm run lint" }, protectedPaths: ["migrations/**"] };
const gatesFor = (extra: Partial<Parameters<typeof runGates>[0]> = {}) =>
  runGates({ agentId: agent.id, cwd: repo, baseRef: "main", profile, brainId: null, gates: ["lint", "test", "scope", "deps", "size"], ...extra });
const gate = (report: Awaited<ReturnType<typeof runGates>>, name: string) => report.results.find((result) => result.gate === name)!;

// An unrelated change: the old failing test still fails, but that doesn't block.
await write(repo, { "src/math.js": "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a + b; // the old bug\nexport const one = 1;\n" });
let report = await gatesFor();
check(
  "failure the base already has doesn't block",
  gate(report, "test").status === "fail" && gate(report, "test").baseline === "fail" && gate(report, "test").newFailures?.length === 0 && !blocks(gate(report, "test")) && report.ok,
  JSON.stringify(gate(report, "test")),
);
check("base result is cached by commit", Number((db.prepare("SELECT COUNT(*) AS n FROM gate_baselines WHERE gate = 'test'").get() as { n: number }).n) === 1);
check("the base worktree is cleaned up", (await run("git worktree list", repo)).trim().split("\n").length === 1 && !(await run("ls -a")).includes(".tot-baselines/"));

// A new failure on the branch blocks; the old one is still not counted against it.
await write(repo, {
  "test/more.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\ntest('adds negatives', () => assert.equal(add(-2, -2), -5));\n",
});
report = await gatesFor();
const newOnes = gate(report, "test").newFailures ?? [];
check(
  "only the new failure blocks",
  !report.ok && blocks(gate(report, "test")) && newOnes.some((line) => line.includes("adds negatives")) && !newOnes.some((line) => line.includes("legacy subtracts")),
  JSON.stringify(newOnes),
);
check("lint passes and scope is clean", gate(report, "lint").status === "pass" && gate(report, "scope").status === "pass" && gate(report, "size").status === "pass");
await run("rm test/more.test.js", repo);

// A new dependency needs the user's OK (and is fine when the profile allows it).
await write(repo, {
  "package.json": JSON.stringify({ name: "gates", type: "module", scripts: { test: "node --test", lint: "node lint.mjs" }, dependencies: { "left-pad": "^1.3.0" } }, null, 2),
  "package-lock.json": '{"packages":{"node_modules/left-pad":{}}}\n',
});
report = await gatesFor();
check(
  "new dependency needs approval",
  gate(report, "deps").status === "needs-approval" && Boolean(gate(report, "deps").details?.some((line) => line.includes("+ left-pad ^1.3.0"))) && !report.ok,
  JSON.stringify(gate(report, "deps")),
);
report = await gatesFor({ profile: { ...profile, limits: { ...profile.limits, allowNewDependencies: true } } });
check("allowed by the profile, it passes", gate(report, "deps").status === "pass");
await run("git checkout -q -- package.json package-lock.json", repo);

// Skipped tests are caught, even when the test run itself doesn't block.
await write(repo, {
  "test/math.test.js":
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, sub } from '../src/math.js';\n\ntest.skip('adds', () => assert.equal(add(2, 2), 4));\ntest('legacy subtracts', () => assert.equal(sub(5, 3), 2));\n",
});
report = await gatesFor();
check(
  ".skip is caught",
  gate(report, "test").status === "needs-approval" && Boolean(gate(report, "test").details?.some((line) => line.includes("skips a test"))) && !report.ok,
  JSON.stringify(gate(report, "test")),
);
await write(repo, {
  "test/math.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, sub } from '../src/math.js';\n\n// test('adds', () => assert.equal(add(2, 2), 4));\n",
});
report = await gatesFor();
const findings = gate(report, "test").details ?? [];
check("commented-out and removed tests are caught", findings.some((line) => line.includes("comments out a test")) && findings.some((line) => line.includes("removes 2 tests")), JSON.stringify(findings));
await run("git checkout -q -- test/math.test.js && git rm -q test/math.test.js", repo);
report = await gatesFor({ gates: ["scope"] });
check("a deleted test file is caught", Boolean(gate(report, "test")?.details?.some((line) => line.includes("test file deleted"))));
await run("git reset -q && git checkout -q -- test", repo);

// Protected paths, the plan's files, size limits, read-only work.
await write(repo, { "migrations/002.sql": "alter table t add column x int;\n", "src/extra.js": "export const two = 2;\n" });
report = await gatesFor({ plan: { text: "Change src/math.js", files: ["src/math.js"] } });
const scopeDetails = gate(report, "scope").details ?? [];
check(
  "protected paths and files outside the plan need approval",
  gate(report, "scope").status === "needs-approval" &&
    scopeDetails.some((line) => line.startsWith("migrations/002.sql (protected")) &&
    scopeDetails.some((line) => line.startsWith("src/extra.js (outside the plan)")) &&
    !scopeDetails.some((line) => line.startsWith("src/math.js")),
  JSON.stringify(scopeDetails),
);
report = await gatesFor({ profile: { ...profile, protectedPaths: [], limits: { ...profile.limits, maxChangedLines: 2, maxChangedFiles: 1 } } });
check("over the size limits needs approval", gate(report, "size").status === "needs-approval" && /limit 2\b/.test(gate(report, "size").note ?? ""), gate(report, "size").note);
report = await gatesFor({ readOnly: true, gates: ["scope"] });
check("read-only work fails on any change", gate(report, "scope").status === "fail");
await run("rm -f migrations/002.sql src/extra.js && git checkout -q -- src", repo);

// Reproducing a bug: the repro must fail before the fix and pass after.
const repro = { command: "node -e \"import('./src/math.js').then(m => process.exit(m.sub(5, 3) === 2 ? 0 : 1))\"", expect: "fail" as const };
report = await gatesFor({ gates: ["repro"], repro });
check("repro fails before the fix: pass", gate(report, "repro").status === "pass", JSON.stringify(gate(report, "repro")));
await write(repo, { "src/math.js": "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n" });
report = await gatesFor({ gates: ["repro", "test"], repro: { ...repro, expect: "pass" } });
check("after the fix the repro passes and so do the tests", gate(report, "repro").status === "pass" && gate(report, "test").status === "pass" && report.ok, JSON.stringify(report.results.map((r) => [r.gate, r.status])));

// The dev route: any folder, with the profile read from it.
const checked = await request<{ ok: boolean; results: { gate: string; status: string }[] }>("POST", "/trust/check", { agentId: agent.id, cwd: repo, baseRef: "main" });
check(
  "dev route checks a folder with a detected profile",
  checked.status === 200 && ["lint", "test", "scope", "deps", "size"].every((name) => checked.json.results.some((r) => r.gate === name)),
  JSON.stringify(checked.json),
);
check("dev route refuses option-like refs", (await request("POST", "/trust/check", { agentId: agent.id, cwd: repo, baseRef: "--output=/tmp/x" })).status === 400);
check("dev route: unknown base", (await request("POST", "/trust/check", { agentId: agent.id, cwd: repo, baseRef: "nope" })).status === 400);
check("dev route: not a repo", (await request("POST", "/trust/check", { agentId: agent.id, cwd: "repos/nowhere", baseRef: "main" })).status === 400);

// --- M3 · Independent review -----------------------------------------------------------------------------
const { calledNames, chunkDiff, numberDiff } = await import("./trust/review.ts");
const { workflows } = await import("./trust/settings.ts");
const { reviewDiff } = await import("./trust/review.ts");

check(
  "diff lines get the new file's line numbers",
  numberDiff("diff --git a/x b/x\n+++ b/x\n@@ -3,2 +10,3 @@\n keep\n-old\n+new\n keep").endsWith("   10  keep\n      -old\n   11 +new\n   12  keep"),
);
check("big diffs split between files", chunkDiff(`diff --git a/a b/a\n${"x".repeat(50)}\ndiff --git a/b b/b\n${"y".repeat(50)}\n`, 80).length === 2);
const names = calledNames("+++ b/src/a.js\n+const fresh = () => 1;\n+if (ok) helper(x); fresh(); 'skip(this)';\n+  render(); // later(maybe)\n");
check("calls in added lines, minus keywords, strings, comments and new definitions", [...names.keys()].sort().join(",") === "helper,render", [...names.keys()].join(","));

// A fixture diff that calls a function that doesn't exist and has an off-by-one.
const shop2 = "repos/review";
await write(shop2, {
  "src/cart.js": "export function total(items) {\n  let sum = 0;\n  for (let i = 0; i < items.length; i++) sum += items[i].price;\n  return sum;\n}\n",
  "src/format.js": "export const cents = (n) => `$${(n / 100).toFixed(2)}`;\n",
});
await run(`${GIT} init -q && ${GIT} add -A && ${GIT} commit -qm base && git checkout -qb work`, shop2);
await write(shop2, {
  "src/cart.js":
    "import { cents } from './format.js';\n\nexport function total(items) {\n  let sum = 0;\n  for (let i = 0; i <= items.length; i++) sum += items[i].price;\n  return applyDiscount(sum);\n}\n\nexport const label = (items) => cents(total(items));\n",
});
const prompts: string[] = [];
const verdict = {
  verdict: "changes-requested",
  summary: "The loop reads past the end of the array, and applyDiscount doesn't exist.",
  findings: [
    { file: "b/src/cart.js", line: 5, severity: "must-fix", issue: "Off-by-one: `i <= items.length` reads items[items.length], which is undefined.", suggestion: "Use `i < items.length`." },
    { file: "src/cart.js", line: 6, severity: "must-fix", issue: "applyDiscount is called but defined nowhere in the repo or its libraries." },
    { file: "src/cart.js", line: 9, severity: "nit", issue: "label could use a clearer name." },
  ],
};
let replies = ["Sure! Here's my review: {not json", `\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``];
answer = (call) => {
  prompts.push(call.prompt);
  return replies.shift() ?? "{}";
};
calls.length = 0;
const reviewProfile = { ...profile, conventions: ["Prices are integers in cents"] };
const review = await reviewDiff({ agentId: agent.id, cwd: shop2, baseRef: "main", profile: reviewProfile, plan: "Apply discounts in src/cart.js", implementedBy: "claude" });
check(
  "fixture diff: changes requested, both bugs must-fix",
  review.verdict === "changes-requested" &&
    review.findings.filter((f) => f.severity === "must-fix").length === 2 &&
    review.findings.some((f) => /off-by-one/i.test(f.issue) && f.line === 5) &&
    review.findings.some((f) => /applyDiscount/.test(f.issue)),
  JSON.stringify(review.findings),
);
check("findings: must-fix first, paths without a/ b/", review.findings[0].severity === "must-fix" && review.findings.at(-1)!.severity === "nit" && review.findings.every((f) => !f.file.startsWith("b/")));
check("invalid output is asked again, once", calls.length === 2 && prompts[1].includes("didn't match that format"));
check("reviewed on the other provider, with the strongest model", review.reviewer.provider === "chatgpt" && review.reviewer.model === "gpt-astra" && calls.every((call) => call.provider === "chatgpt"), JSON.stringify(review.reviewer));
check(
  "the reviewer sees the plan, conventions and numbered diff, and nothing of the work's chat",
  prompts[0].includes("Apply discounts in src/cart.js") && prompts[0].includes("Prices are integers in cents") && /\s5 \+\s+for \(let i = 0; i <= items\.length/.test(prompts[0]),
);
check("calls found nowhere else in the repo are pointed out", /applyDiscount\(\) in src\/cart\.js/.test(prompts[0]) && !/- cents\(\)/.test(prompts[0]) && !/- total\(\)/.test(prompts[0]), prompts[0].slice(prompts[0].indexOf("## Calls"), prompts[0].indexOf("## The diff")));
check("the reviewer gets no tools and no transcript", calls.every((call) => !("mcpServers" in call) && !call.prompt.includes("transcript")));

replies = ["nope", "still nope"];
const broken = await reviewDiff({ agentId: agent.id, cwd: shop2, baseRef: "main", profile, implementedBy: "claude" }).then(
  () => "resolved",
  (err: Error) => err.message,
);
check("twice invalid: a clear error", /wasn't valid twice/.test(broken), broken);

workflows.patch({ reviewer: "claude" });
replies = [JSON.stringify({ verdict: "approve", summary: "Looks right.", findings: [{ file: "src/cart.js", line: 5, severity: "must-fix", issue: "Off by one." }] })];
const fixed = await reviewDiff({ agentId: agent.id, cwd: shop2, baseRef: "main", profile, implementedBy: "claude" });
check("a fixed reviewer in Settings wins", fixed.reviewer.provider === "claude" && fixed.reviewer.model === "claude-opus-5-5");
check("a must-fix finding always means changes requested", fixed.verdict === "changes-requested");
workflows.patch({ reviewer: "other" });
statuses[1] = { ...statuses[1], loggedIn: false };
replies = [JSON.stringify({ verdict: "approve", summary: "Fine.", findings: [] })];
const fallback = await reviewDiff({ agentId: agent.id, cwd: shop2, baseRef: "main", profile, implementedBy: "claude" });
check("the other provider unavailable: the same one reviews", fallback.reviewer.provider === "claude" && fallback.verdict === "approve");
statuses[1] = { ...statuses[1], loggedIn: true };

replies = [JSON.stringify(verdict)];
const viaRoute = await request<{ verdict: string }>("POST", "/trust/review", { agentId: agent.id, cwd: shop2, baseRef: "main", implementedBy: "chatgpt" });
check("dev route reviews a folder", viaRoute.status === 200 && viaRoute.json.verdict === "changes-requested", JSON.stringify(viaRoute.json));
await run("git checkout -q -- .", shop2);
check("nothing to review is a 400", (await request("POST", "/trust/review", { agentId: agent.id, cwd: shop2, baseRef: "main" })).status === 400);

// --- M4 · Playbooks -------------------------------------------------------------------------------------
type PlaybookT = import("@tot/shared/types").Playbook;
type MatchT = import("@tot/shared/types").PlaybookMatch;
const { hintScore, isReadOnly } = await import("./trust/playbooks.ts");

calls.length = 0;
let matched = await request<MatchT>("POST", "/playbooks/match", { goal: "the checkout page crashes when the cart is empty" });
check("“the checkout page crashes when the cart is empty” → Bug fix", matched.json.playbook.id === "bug-fix" && matched.json.by === "hints", JSON.stringify(matched.json.by));
matched = await request<MatchT>("POST", "/playbooks/match", { goal: "add CSV export" });
check("“add CSV export” → Feature", matched.json.playbook.id === "feature" && matched.json.by === "hints");
matched = await request<MatchT>("POST", "/playbooks/match", { goal: "Why doesn’t the nightly job pick up new carts?" });
check("investigate questions match too", matched.json.playbook.id === "investigate", matched.json.playbook.id);
check("hints match whole words with endings", hintScore("It crashed while adding items", ["crash", "add"]) === 2 && hintScore("the prefix address", ["fix", "add"]) === 0);
check("no model call when the hints decide", calls.length === 0);

answer = () => "refactor";
matched = await request<MatchT>("POST", "/playbooks/match", { goal: "tidy up the error handling" });
check("a tie goes to the light classifier", matched.json.playbook.id === "refactor" && matched.json.by === "classifier" && calls.at(-1)?.model === "claude-sonnet-5-5", JSON.stringify(matched.json.by));
answer = () => "I can't tell.";
matched = await request<MatchT>("POST", "/playbooks/match", { goal: "the quarterly numbers" });
check("no hints and no answer: Feature as the fallback", matched.json.playbook.id === "feature" && matched.json.by === "fallback");

let list = (await request<PlaybookT[]>("GET", "/playbooks")).json;
check("built-ins listed first", ["bug-fix", "feature", "refactor", "investigate", "review-pr"].every((id, i) => list[i]?.id === id && list[i].builtIn && list[i].enabled));
const bugFix = list[0];
check(
  "bug fix: reproduce (repro) before the plan, verify needs the repro to pass, fix loop after review",
  bugFix.steps.map((s) => s.kind).join(" → ") === "understand → reproduce → plan → approve-plan → implement → verify → review → fix-loop → summarize" &&
    bugFix.steps[1].gates?.includes("repro") === true &&
    bugFix.steps[5].gates?.includes("repro") === true,
);
check("investigate and review a PR are read-only", isReadOnly(list[3]) && isReadOnly(list[4]) && !isReadOnly(bugFix));
check("built-ins can't be edited", (await request("PATCH", "/playbooks/bug-fix", { name: "Mine" })).status === 400);
check("built-ins can't be deleted", (await request("DELETE", "/playbooks/bug-fix")).status === 400);
check("built-ins can be turned off", (await request<PlaybookT>("PATCH", "/playbooks/investigate", { enabled: false })).json.enabled === false);
matched = await request<MatchT>("POST", "/playbooks/match", { goal: "Why doesn't the nightly job pick up new carts?" });
check("a playbook that's off isn't matched", matched.json.playbook.id !== "investigate");
await request("PATCH", "/playbooks/investigate", { enabled: true });

// Duplicate a built-in, edit the copy, save it.
const copy = await request<PlaybookT>("POST", "/playbooks", { name: "Bug fix (copy)", description: bugFix.description, match: bugFix.match, steps: bugFix.steps });
check("a duplicate is a custom playbook", copy.status === 201 && !copy.json.builtIn && copy.json.steps.length === bugFix.steps.length);
const steps = copy.json.steps.filter((s) => s.kind !== "approve-plan").map((s) => (s.kind === "fix-loop" ? { ...s, maxRounds: 5 } : s));
const edited2 = await request<PlaybookT>("PATCH", `/playbooks/${copy.json.id}`, {
  name: "Hotfix",
  match: ["hotfix", "Outage", "outage"],
  steps: [...steps.slice(0, -1), { kind: "custom", instructions: "Post the fix to #incidents as a draft.", gates: [] }, steps.at(-1)],
});
check(
  "edited and saved",
  edited2.status === 200 &&
    edited2.json.name === "Hotfix" &&
    edited2.json.match.join() === "hotfix,outage" &&
    !edited2.json.steps.some((s) => s.kind === "approve-plan") &&
    edited2.json.steps.find((s) => s.kind === "fix-loop")?.maxRounds === 5 &&
    edited2.json.steps.some((s) => s.kind === "custom" && s.id === "custom"),
  JSON.stringify(edited2.json).slice(0, 300),
);
list = (await request<PlaybookT[]>("GET", "/playbooks")).json;
check("the edit persists", list.find((p) => p.id === copy.json.id)?.name === "Hotfix");
matched = await request<MatchT>("POST", "/playbooks/match", { goal: "outage: hotfix the payment webhook" });
check("custom playbooks are matched by their hints", matched.json.playbook.id === copy.json.id, matched.json.playbook.name);

const invalid = async (patch: object) => (await request<{ error: string }>("PATCH", `/playbooks/${copy.json.id}`, patch)).json.error ?? "";
check("needs a step", /at least one step/.test(await invalid({ steps: [] })));
check("steps need instructions", /Step 1 needs instructions/.test(await invalid({ steps: [{ kind: "implement", instructions: " " }] })));
check("unknown step kinds are refused", /needs a kind/.test(await invalid({ steps: [{ kind: "deploy", instructions: "Ship it" }] })));
check("approve-plan needs a plan first", /needs a plan step before it/.test(await invalid({ steps: [{ kind: "approve-plan", instructions: "OK?" }] })));
check("a fix loop needs something to fix", /verify or review step before it/.test(await invalid({ steps: [{ kind: "implement", instructions: "Do" }, { kind: "fix-loop", instructions: "Fix" }] })));
check("unknown checks are refused", /checks are some of/.test(await invalid({ steps: [{ kind: "verify", instructions: "Check", gates: ["vibes"] }] })));
check("names are unique", /already a playbook called/.test(await invalid({ name: "feature" })));
check("deleted", (await request("DELETE", `/playbooks/${copy.json.id}`)).status === 200 && !(await request<PlaybookT[]>("GET", "/playbooks")).json.some((p) => p.id === copy.json.id));

// Workflow defaults.
let flows = await request<{ requirePlanApproval: boolean; reviewer: string; maxFixRounds: number }>("GET", "/workflows");
check("workflow defaults: plans need an OK, the other provider reviews, 3 fix rounds", flows.json.requirePlanApproval && flows.json.reviewer === "other" && flows.json.maxFixRounds === 3);
flows = await request("PATCH", "/workflows", { requirePlanApproval: false, maxFixRounds: 2 });
check("workflow defaults saved", !flows.json.requirePlanApproval && flows.json.maxFixRounds === 2 && (await request<typeof flows.json>("GET", "/workflows")).json.maxFixRounds === 2);
check("workflow defaults validated", (await request("PATCH", "/workflows", { maxFixRounds: 0 })).status === 400 && (await request("PATCH", "/workflows", { reviewer: "gemini" })).status === 400);

// ---------------------------------------------------------------------------------------------------------
trustModel.use(null);
await computerManager.destroy(agent.id);
agents.delete(agent.id);
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
