// Trust gates & playbooks (module 03): repo profiles, gates, the reviewer and playbooks, against
// temporary git repos on the local computer backend and a fake model (no real model is called).
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/trust.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import type { CommandRun, ProviderStatus, RepoProfile } from "../shared/types.ts";
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
    models: [
      { id: "chatgpt:gpt-luna", provider: "chatgpt", model: "gpt-luna", label: "Luna", available: true },
      { id: "chatgpt:gpt-astra", provider: "chatgpt", model: "gpt-astra", label: "Astra", available: true },
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

// ---------------------------------------------------------------------------------------------------------
trustModel.use(null);
await computerManager.destroy(agent.id);
agents.delete(agent.id);
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
