// Knowledge auto-updates (roadmap module 11, lane C), with a fake model: a landed task's update (applied, and refused
// for an unknown id, a secret, a big shrink, a page the user edited meanwhile), one commit per run, Undo, the wiki
// keeper skipping a task its landing covered and writing a project chat's pages to the project's knowledge, base
// branch moves for a folder repo on this Mac and for a GitHub-style repo (a local bare remote, fetched on the agent's
// computer), TOT's own landed tasks left out of a move, failures that back off, Dreaming's page summaries and
// fact_to_page, and the routes. Real git in temp folders; never the real ~/.tot, GitHub or a model.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/knowledge-auto.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KnowledgeRefreshResult, KnowledgeUpdate, Message, TaskRepo } from "../shared/types.ts";

// A temp home, set before anything reads it: folder projects must be inside it (as in landing.test.ts, in the
// repo's git-ignored .scratch, which the macOS sandbox lets a local computer use).
const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), "..", ".scratch");
mkdirSync(SCRATCH, { recursive: true });
const HOME = realpathSync.native(mkdtempSync(join(SCRATCH, "kauto-home-")));
const OUTSIDE = realpathSync.native(mkdtempSync(join(SCRATCH, "kauto-outside-")));
process.env.HOME = HOME;
process.on("exit", () => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});
// A fake gh first on PATH, and a GitHub API nothing listens on: the real ones are never touched.
const bin = join(OUTSIDE, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.TOT_GITHUB_API_URL = "http://127.0.0.1:9";
process.env.TOT_GITHUB_WEB_URL = "http://127.0.0.1:9";
process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test

const { db } = await import("./db.ts");
const { agents } = await import("./data/agents.ts");
const { conversations } = await import("./data/conversations.ts");
const { memories } = await import("./data/memories.ts");
const { messages } = await import("./data/messages.ts");
const { settings } = await import("./data/settings.ts");
const { wiki } = await import("./data/wiki.ts");
const { knowledge } = await import("./knowledge/index.ts");
const { createApp } = await import("./app.ts");
const { computerManager } = await import("./computer/manager.ts");
const { localSandboxed } = await import("./computer/local.ts");
const { keepConversation } = await import("./agent/wiki-keeper.ts");
const { remember } = await import("./memory/memory.ts");
const { dream } = await import("./memory/dreaming.ts");
const repo = await import("./memory/repo.ts");
const { projects } = await import("./projects/projects.ts");
const { newTaskInfo, taskStore } = await import("./tasks/store.ts");
const { knowledgeAuto, runUpdate } = await import("./knowledge/auto/jobs.ts");
const { knowledgeLog, repoHeads } = await import("./knowledge/auto/log.ts");
const { checkProject, checkRepo } = await import("./knowledge/auto/watch.ts");
const { consolidate, trackWrite } = await import("./knowledge/auto/commit.ts");
const { undoUpdate } = await import("./knowledge/auto/undo.ts");
const { keeperKnowledge } = await import("./knowledge/auto/keeper.ts");
const { knowledgeRepo, projectRepos } = await import("./knowledge/auto/repos.ts");
const { SECRET_REFUSAL } = await import("./knowledge/auto/prompt.ts");
type ConversationRecord = import("./data/conversations.ts").ConversationRecord;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 300)}` : ""}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end && !condition(); ) await sleep(20);
}
const mascot = { shape: "blob" as const, color: "#60a5fa", accessory: "none" as const, eyes: "dots" as const };

settings.patch({ computer: { mode: "local" }, memory: { enabled: true } });

const app = createApp();
async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await app.request(`http://localhost:8787/api${path}`, {
    method,
    headers: { Host: "localhost:8787", Origin: "http://localhost:8787", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

// git as the user (or the test, standing in for one) runs it.
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function makeRepo(path: string, files: Record<string, string>): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  commit(path, files, "init");
}
function commit(cwd: string, files: Record<string, string>, subject: string): string {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), content);
  }
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", subject);
  return git(cwd, "rev-parse", "HEAD");
}

// --- The fake model: records what it was shown; its answer can depend on it ----------------------------------
const prompts: string[] = [];
let modelCalls = 0;
type Answer = unknown[] | ((prompt: string) => unknown[] | Promise<unknown[]>);
function fake(answer: Answer) {
  return async (prompt: string) => {
    modelCalls++;
    prompts.push(prompt);
    const ops = typeof answer === "function" ? await answer(prompt) : answer;
    return "Here you go:\n```json\n" + JSON.stringify({ ops, notes: "test" }) + "\n```";
  };
}
/** What the queued updates answer (swapped per test). */
let model: (prompt: string, system: string) => Promise<string> = fake([]);
knowledgeAuto.useComplete((prompt, system) => model(prompt, system), { retryMs: 20 });
const lastPrompt = () => prompts.at(-1) ?? "";

const kCommits = async (dir: string) => Number((await repo.git(dir, ["rev-list", "--count", "HEAD"])).trim());
const kLog = async (dir: string, format: string) => (await repo.git(dir, ["log", "-1", `--format=${format}`])).trim();

// =============================================================================
// A folder project on this Mac with docs and facts
// =============================================================================
console.log("\n# A landed task updates the project's knowledge");
const shop = join(HOME, "code/shop");
makeRepo(shop, {
  "README.md": "shop\n",
  "src/cart.ts": "export const total = (items: number[]) => items.reduce((a, b) => a + b, 0);\n",
  "src/checkout.ts": "export const pay = () => true;\n",
});
const project = projects.create({ kind: "folder", source: shop, grant: true });
check("a folder project's one repo, without lane A", projectRepos(project).length === 1 && projectRepos(project)[0]!.name === "shop" && projectRepos(project)[0]!.primary, JSON.stringify(projectRepos(project)));
const kRepo = knowledgeRepo(project);
const kDir = repo.repoDir(kRepo);
const cartText = `The cart lives in \`src/cart.ts\`.\n\n${"It adds items up and shows the total in the header. ".repeat(12)}`.trim();
const cart = wiki.create(project.brainId, { title: "Cart", summary: "How the cart works", content: cartText }, "user");
const checkoutText = `Checkout is in \`src/checkout.ts\`.\n\n${"Payment runs through the provider's hosted page, then a webhook confirms it. ".repeat(30)}`.trim();
const checkoutPage = wiki.create(project.brainId, { title: "Checkout", summary: "Paying for the cart", content: checkoutText }, "user");
const testsFact = (await remember({ repo: kRepo, text: "Tests run with npm test", source: "you", actor: "you" })).memory;

const tot = agents.create({ name: "Tot", mascot });
const chat = conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Shop", projectId: project.id });

/** A task whose branch was merged into the folder's main, as TOT's merge does (git merge --no-ff); not landed yet. */
function mergedTask(title: string, files: Record<string, string>, opts: { messages?: string } = {}): { task: ConversationRecord; sha: string } {
  const branch = `tot/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 4)}`;
  git(shop, "checkout", "-q", "-b", branch);
  commit(shop, files, title);
  git(shop, "checkout", "-q", "main");
  git(shop, "merge", "--no-ff", "-q", "-m", `Merge ${branch}: ${title}`, branch);
  const sha = git(shop, "rev-parse", "HEAD");
  git(shop, "branch", "-q", "-d", branch);
  const taskRepo: TaskRepo = { source: shop, folder: shop, baseBranch: "main", branch, worktree: `${shop}/.tot-worktrees/${branch.replace(/\//g, "-")}`, headSha: null };
  const task = conversations.create({
    agentId: tot.id,
    modelId: tot.modelId,
    title,
    kind: "task",
    parentId: chat.id,
    projectId: project.id,
    task: { ...newTaskInfo(`${title}.`, taskRepo), status: "done", summary: `Did it: ${title.toLowerCase()}.`, finishedAt: Date.now() },
  });
  if (opts.messages) {
    const at = Date.now() - 1000;
    for (const [role, text] of [["user", opts.messages], ["assistant", `Done. ${opts.messages}`]] as const) {
      const message: Message = { id: randomUUID(), conversationId: task.id, role, parts: [{ type: "text", id: randomUUID(), text }], status: "complete", createdAt: at + (role === "user" ? 0 : 1) };
      messages.insert(message);
    }
  }
  return { task, sha };
}
const land = (taskId: string, sha: string) => taskStore.patch(taskId, { landing: { kind: "merged", target: "main", sha, pr: null, at: Date.now() } }, true);
const runFor = (taskId: string) => knowledgeLog.landedRun(taskId);

knowledgeAuto.start();

const fix = mergedTask(
  "Fix cart",
  {
    "src/cart.ts": "// Totals are kept in cents.\nexport const total = (items: number[]) => Math.round(items.reduce((a, b) => a + b, 0) * 100);\n",
    "src/checkout.ts": "export const pay = () => true; // cents\n",
  },
  { messages: `Fix the cart total so it's kept in cents everywhere. ${"Details about rounding and the header display. ".repeat(10)}` },
);
let commitsBefore = await kCommits(kDir);
model = fake([
  { op: "page_update", id: cart.id, content: `${cartText}\n\n## Totals\nTotals are kept in cents (\`src/cart.ts\`).` },
  { op: "page_update", id: checkoutPage.id, content: "Checkout: see the code." },
  { op: "page_update", id: "no-such-page", content: "x" },
  { op: "fact_add", text: "Cart totals are kept in cents" },
  { op: "fact_add", text: "The deploy key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123" },
  { op: "page_create", parent: null, title: "Leak", summary: "Where the token is", content: "Use ghp_abcdefghijklmnopqrstuvwxyz0123456789 to deploy." },
  { op: "fact_update", id: testsFact.id, text: "Tests run with npm test -- --runInBand" },
]);
land(fix.task.id, fix.sha);
await until(() => runFor(fix.task.id) !== null);
const fixRun = runFor(fix.task.id);
const fixPrompt = lastPrompt();
check("landing (merged) queues an update, run by the light model in the background", Boolean(fixRun) && modelCalls === 1, JSON.stringify(fixRun));
check(
  "the model sees the task's diff (from the merge commit in the folder), its summary, the repo's pages and the facts",
  fixPrompt.includes(`kind="landed" task="Fix cart"`) &&
    fixPrompt.includes("src/cart.ts | +2 −1") &&
    fixPrompt.includes("+// Totals are kept in cents.") &&
    fixPrompt.includes("Did it: fix cart.") &&
    fixPrompt.includes(`<page id="${cart.id}"`) &&
    fixPrompt.includes(`<page id="${checkoutPage.id}"`) &&
    fixPrompt.includes(`Tests run with npm test (${testsFact.id})`),
  fixPrompt.slice(0, 400),
);
check("a page update lands", wiki.get(cart.id)!.content.endsWith("Totals are kept in cents (`src/cart.ts`).") && wiki.get(cart.id)!.updatedBy === "keeper");
check("a page cut by more than 60% is refused", wiki.get(checkoutPage.id)!.content === checkoutText);
check("an unknown page and a secret (in a fact, in a new page) are refused", !wiki.withTitle(project.brainId, "Leak").length && !memories.list(kRepo).some((m) => m.content.includes("sk-ant")));
const facts = memories.list(kRepo).map((m) => m.content);
check("a fact is added and another updated", facts.includes("Cart totals are kept in cents") && facts.includes("Tests run with npm test -- --runInBand") && !facts.includes("Tests run with npm test"), JSON.stringify(facts));
check("one commit, by TOT, named after the task", (await kCommits(kDir)) === commitsBefore + 1 && (await kLog(kDir, "%an|%s")) === "TOT|Knowledge: after “Fix cart”" && (await kLog(kDir, "%b")).includes("TOT-Actor: TOT"), await kLog(kDir, "%an|%s%n%b"));
const head1 = await repo.head(kRepo);
check(
  "the run is logged: landed, its repo and task, the page and facts it changed, its commit",
  fixRun?.trigger === "landed" &&
    fixRun.repoName === "shop" &&
    fixRun.taskId === fix.task.id &&
    JSON.stringify(fixRun.pages) === JSON.stringify([{ id: cart.id, title: "Cart", action: "updated" }]) &&
    fixRun.facts === 2 &&
    fixRun.sha === head1 &&
    fixRun.summary === "Updated after “Fix cart”" &&
    fixRun.error === null,
  JSON.stringify(fixRun),
);
check("the commit says what it skipped", (await kLog(kDir, "%b")).includes("Skipped 4 that didn't check out") && (await kLog(kDir, "%b")).includes(SECRET_REFUSAL));
check(
  "the one commit keeps the page's trailers (the page and its writer), so its history reads as TOT's",
  (await kLog(kDir, "%b")).includes(`TOT-Page: ${cart.id} `) &&
    (await kLog(kDir, "%b")).includes("TOT-Author: keeper") &&
    (await knowledge.history(project, 1))[0]?.pages.some((page) => page.id === cart.id && page.action === "edited"),
  `${await kLog(kDir, "%b")}\n${JSON.stringify((await knowledge.history(project, 1))[0])}`,
);

// The wiki keeper leaves a task to its landing's update.
modelCalls = 0;
const kept = await keepConversation(fix.task.id, fake([]));
check("the wiki keeper skips a task whose landing updated the knowledge (no model call)", kept.length === 0 && modelCalls === 0 && keeperKnowledge.covered(fix.task.id, Date.now() - 5000));

// --- A page the user edits while the model thinks ---------------------------------------------------------------
console.log("\n# Refused: a page the user changed since it was read");
const rename = mergedTask("Rename cart total", { "src/cart.ts": "// Totals are kept in cents.\nexport const cartTotal = (items: number[]) => items.length;\n" });
const userText = `${wiki.get(cart.id)!.content}\n\nThe user's own note.`;
model = fake(() => {
  wiki.update(cart.id, { content: userText }, "user");
  return [{ op: "page_update", id: cart.id, content: `${cartText}\n\nThe export is \`cartTotal\`.` }];
});
commitsBefore = await kCommits(kDir);
land(rename.task.id, rename.sha);
await until(() => runFor(rename.task.id) !== null);
const renameRun = runFor(rename.task.id);
check("the user's edit stands; nothing to update", wiki.get(cart.id)!.content === userText && renameRun?.summary === "Nothing to update after “Rename cart total”" && renameRun.sha === null && !renameRun.pages.length, JSON.stringify(renameRun));
check(
  "…and no commit of its own (only the user's edit, by the user)",
  (await kCommits(kDir)) === commitsBefore + 1 && (await kLog(kDir, "%b")).includes("TOT-Author: user"),
  await kLog(kDir, "%s%n%b"),
);

// --- Undo ---------------------------------------------------------------------------------------------------------
console.log("\n# Undo");
const refusedUndo = await undoUpdate(project.id, fixRun!.id).then(
  () => "undone",
  (err: Error) => err.message,
);
check("Undo is refused when a page it wrote changed since (nothing lost)", /“Cart” changed since this update/.test(refusedUndo) && wiki.get(cart.id)!.content === userText && memories.list(kRepo).some((m) => m.content === "Cart totals are kept in cents"), refusedUndo);
const coupon = mergedTask("Add a coupon field", { "src/coupon.ts": "export const coupon = (code: string) => code.trim().toUpperCase();\n" });
model = fake([
  { op: "page_create", parent: null, title: "Coupons", summary: "Coupon codes at checkout", content: "Coupon codes are upper-cased in `src/coupon.ts`." },
  { op: "fact_add", text: "Coupon codes are case-insensitive" },
]);
land(coupon.task.id, coupon.sha);
await until(() => runFor(coupon.task.id) !== null);
const couponRun = runFor(coupon.task.id)!;
const coupons = wiki.withTitle(project.brainId, "Coupons")[0];
check("a new page goes into the project's wiki", Boolean(coupons) && couponRun.pages[0]?.action === "created" && couponRun.facts === 1, JSON.stringify(couponRun));
commitsBefore = await kCommits(kDir);
let res: { status: number; data: any } = await call<KnowledgeUpdate>("POST", `/projects/${project.id}/knowledge/updates/${couponRun.id}/undo`);
check(
  "Undo reverts its commit through memory's undo, and puts its pages back",
  res.status === 200 &&
    Boolean(res.data.undoneAt) &&
    !wiki.get(coupons!.id) &&
    !memories.list(kRepo).some((m) => m.content === "Coupon codes are case-insensitive") &&
    (await kCommits(kDir)) === commitsBefore + 1 &&
    (await kLog(kDir, "%s")).startsWith("you: undo “Knowledge: after"),
  `${res.status} ${JSON.stringify(res.data)} ${await kLog(kDir, "%s")}`,
);
res = await call("POST", `/projects/${project.id}/knowledge/updates/${couponRun.id}/undo`);
check("…once", res.status === 409, JSON.stringify(res.data));

// =============================================================================
// Base branch moves: a folder repo
// =============================================================================
console.log("\n# A folder repo's main branch moves");
let check1 = await checkProject(project);
check("the first look records where main is, and runs nothing", check1.checked === 1 && !check1.jobs.length && repoHeads.get(project.id, "shop")?.sha === git(shop, "rev-parse", "main"), JSON.stringify(repoHeads.get(project.id, "shop")));
check1 = await checkProject(project);
check("…and the 6-hour timer doesn't look again soon", check1.checked === 0);
const shopRepo = projectRepos(project)[0]!;
check("unchanged: nothing to run", (await checkRepo(project, shopRepo)) === null);
const userSha = commit(shop, { "src/search.ts": "export const search = (q: string) => q;\n" }, "Add product search");
const moved = await checkRepo(project, shopRepo);
const movedText = moved ? (await moved.material()).text : "";
check(
  "new commits on main: an update over their log and diff stat",
  moved?.trigger === "base-moved" && movedText.includes("Add product search") && movedText.includes("src/search.ts | +1 −0") && moved.subject === `Knowledge: shop moved to ${userSha.slice(0, 7)}`,
  movedText.slice(0, 300),
);
model = fake([
  { op: "page_create", parent: null, title: "Search", summary: "Product search", content: "Search lives in `src/search.ts`." },
  { op: "fact_add", text: "Product search is in src/search.ts" },
]);
commitsBefore = await kCommits(kDir);
const movedRun = (await runUpdate(moved!, model))!.update;
check(
  "…applied as one commit, “Knowledge: shop moved to <sha7>”",
  (await kCommits(kDir)) === commitsBefore + 1 &&
    (await kLog(kDir, "%s")) === `Knowledge: shop moved to ${userSha.slice(0, 7)}` &&
    movedRun.trigger === "base-moved" &&
    movedRun.summary === `Updated after shop moved to ${userSha.slice(0, 7)}` &&
    wiki.withTitle(project.brainId, "Search").length === 1,
  JSON.stringify(movedRun),
);

// TOT's own landed tasks were covered when they landed.
model = fake([]);
const tidy = mergedTask("Tidy checkout", { "src/checkout.ts": "export const pay = () => true; // tidy\n" });
land(tidy.task.id, tidy.sha);
await until(() => runFor(tidy.task.id) !== null);
check("a move made only of TOT's landed task: no update (its landing had one), and the head moves on", (await checkRepo(project, shopRepo)) === null && repoHeads.get(project.id, "shop")?.sha === tidy.sha);
const both = mergedTask("Polish header", { "src/header.ts": "export const header = 'Shop';\n" });
land(both.task.id, both.sha);
await until(() => runFor(both.task.id) !== null);
commit(shop, { "docs/deploy.md": "Deploy with make ship.\n" }, "Write the deploy notes");
const mixed = await checkRepo(project, shopRepo);
const mixedText = mixed ? (await mixed.material()).text : "";
check("with the user's commits too: only theirs are listed", mixedText.includes("Write the deploy notes") && !mixedText.includes("Polish header"), mixedText.slice(0, 300));

// =============================================================================
// One commit per run: the run's commits squashed (lane B makes pages commits too)
// =============================================================================
console.log("\n# One commit per run");
const lab = projects.create({ kind: "none", name: "Lab" });
const labRepo = knowledgeRepo(lab);
const labDir = repo.repoDir(labRepo);
await remember({ repo: labRepo, text: "Seed fact", source: "you", actor: "you" });
// A run's writes are page writes (wiki.*, by the keeper); its facts come as one commit whose sha it adds itself.
const labPage = wiki.create(lab.brainId, { title: "Lab notes", summary: "Notes", content: "Start." }, "user");
const labOther = wiki.create(lab.brainId, { title: "Lab log", summary: "Log", content: "Start." }, "user");
await knowledge.flush(lab.brainId);
let base = await repo.head(labRepo);
let mine = new Set<string>();
await trackWrite(labRepo, mine, () => wiki.update(labPage.id, { content: "First write of a run" }, "keeper"));
await trackWrite(labRepo, mine, () => wiki.update(labOther.id, { content: "Second write of a run" }, "keeper"));
let squashed = await consolidate(labRepo, base, { subject: "Knowledge: after “Two writes”", actor: "TOT", kind: "edit" }, mine);
check(
  "a run's two commits become one, by TOT, with everything in it",
  squashed.length === 1 &&
    Number((await repo.git(labDir, ["rev-list", "--count", `${base}..HEAD`])).trim()) === 1 &&
    (await kLog(labDir, "%s")) === "Knowledge: after “Two writes”" &&
    wiki.get(labPage.id)!.content === "First write of a run" &&
    wiki.get(labOther.id)!.content === "Second write of a run",
  JSON.stringify(squashed),
);
base = await repo.head(labRepo);
mine = new Set<string>();
await trackWrite(labRepo, mine, () => wiki.update(labPage.id, { content: "Third write of a run" }, "keeper"));
await remember({ repo: labRepo, text: "Someone else saved this meanwhile", source: "you", actor: "you" });
await trackWrite(labRepo, mine, () => wiki.update(labOther.id, { content: "Fourth write of a run" }, "keeper"));
squashed = await consolidate(labRepo, base, { subject: "Knowledge: after “Interleaved”", actor: "TOT", kind: "edit" }, mine);
check("someone else's commit in between: nothing is squashed into the run (Undo reverts its own two)", squashed.length === 2 && Number((await repo.git(labDir, ["rev-list", "--count", `${base}..HEAD`])).trim()) === 3, JSON.stringify(squashed));

// =============================================================================
// The wiki keeper writes a project chat's pages to the project's knowledge
// =============================================================================
console.log("\n# The wiki keeper in a project");
const now = Date.now() - 10 * 60_000;
for (const [i, role] of (["user", "assistant"] as const).entries()) {
  const text = `${role === "user" ? "How do releases go out?" : "Releases: tag vX.Y.Z on main, CI builds and publishes."} ${"We agreed the tag triggers the release workflow. ".repeat(8)}`;
  messages.insert({ id: randomUUID(), conversationId: chat.id, role, parts: [{ type: "text", id: randomUUID(), text }], status: "complete", createdAt: now + i });
}
const keeperAnswer = async () => JSON.stringify({ updates: [{ title: "Release process", summary: "How releases go out", content: "Tag `vX.Y.Z` on main; CI publishes." }] });
const keptPages = await keepConversation(chat.id, keeperAnswer);
const chatRun = knowledgeLog.list(project.id).find((u) => u.trigger === "chat");
check(
  "a project chat's new page goes to the project's brain, not the agent's notebook, and is logged",
  keptPages.length === 1 && keptPages[0]!.brainId === project.brainId && chatRun?.pages[0]?.title === "Release process" && chatRun.summary === "Updated after the chat “Shop”",
  JSON.stringify(chatRun),
);
res = await call<KnowledgeUpdate>("POST", `/projects/${project.id}/knowledge/updates/${chatRun!.id}/undo`);
check("…and Undo takes the keeper's page back out", res.status === 200 && !wiki.get(keptPages[0]!.id), JSON.stringify(res.data));

// =============================================================================
// Dreaming reads the project's page summaries, and moves a long fact into a page
// =============================================================================
console.log("\n# Dreaming with the project's pages");
const longFact = (await remember({ repo: kRepo, text: `Checkout refunds: ${"refunds go back through the provider's dashboard and take five days; ".repeat(4)}`.trim(), source: "you", actor: "you" })).memory;
const dupFact = (await remember({ repo: kRepo, text: "The cart lives in src/cart.ts", source: "you", actor: "you" })).memory;
for (const text of ["Uses pnpm", "CI runs on every push", "Main is protected"]) await remember({ repo: kRepo, text, source: "you", actor: "you" });
const checkoutBefore = wiki.get(checkoutPage.id)!.content;
commitsBefore = await kCommits(kDir);
let dreamPrompt = "";
const dreamt = await dream(kRepo, async (prompt) => {
  dreamPrompt = prompt;
  return JSON.stringify({
    ops: [
      { op: "fact_to_page", id: longFact.id, page: checkoutPage.id },
      { op: "delete", id: dupFact.id, reason: "the Cart page says it" },
      { op: "fact_to_page", id: "zzzzzzzz", page: checkoutPage.id },
    ],
  });
});
check("the dream sees the project's pages with their summaries", dreamPrompt.includes("<pages") && dreamPrompt.includes(`Cart (${cart.id}) — How the cart works`) && dreamPrompt.includes('"fact_to_page"'), dreamPrompt.slice(-600));
check(
  "a long fact moves into its page (added there, gone from memory); a duplicate of a page goes",
  wiki.get(checkoutPage.id)!.content.endsWith(longFact.content) && !memories.get(longFact.id, [kRepo]) && !memories.get(dupFact.id, [kRepo]) && dreamt.applied.length === 2 && dreamt.refused.length === 1,
  JSON.stringify(dreamt),
);
const dreamRun = knowledgeLog.list(project.id).find((u) => u.trigger === "dreaming");
check(
  "one commit, and it's in the project's knowledge updates",
  (await kCommits(kDir)) === commitsBefore + 1 && (await kLog(kDir, "%s")).startsWith("Dreaming: removed 1, moved 1 into pages") && dreamRun?.pages[0]?.id === checkoutPage.id && dreamRun.sha === (await repo.head(kRepo)),
  `${await kLog(kDir, "%s")} ${JSON.stringify(dreamRun)}`,
);
await undoUpdate(project.id, dreamRun!.id);
check("Undo puts the facts back and the page as it was", Boolean(memories.list(kRepo).find((m) => m.content === longFact.content)) && Boolean(memories.list(kRepo).find((m) => m.content === dupFact.content)) && wiki.get(checkoutPage.id)!.content === checkoutBefore);

// =============================================================================
// Failures back off and never hold up landing
// =============================================================================
console.log("\n# Failures back off");
let failedCalls = 0;
model = async () => {
  failedCalls++;
  throw new Error("No provider available for a background job (the wiki keeper or Dreaming).");
};
const flaky = mergedTask("Fix the footer", { "src/footer.ts": "export const footer = '©';\n" });
land(flaky.task.id, flaky.sha);
await until(() => failedCalls === 1);
await sleep(5);
let list = (await call<KnowledgeUpdate[]>("GET", `/projects/${project.id}/knowledge/updates`)).data;
check("the landing stands; the update waits to try again, shown as running", taskStore.get(flaky.task.id)?.task.landing?.kind === "merged" && list[0]?.running === true && /Trying again soon/.test(list[0].error ?? ""), JSON.stringify(list[0]));
for (let i = 0; i < 20 && !runFor(flaky.task.id); i++) {
  await sleep(50);
  await knowledgeAuto.drain();
}
const failedRun = runFor(flaky.task.id);
check("after three tries it's logged as failed", failedCalls === 3 && failedRun?.summary === "Couldn't update after “Fix the footer”" && /No provider/.test(failedRun.error ?? "") && failedRun.sha === null, JSON.stringify(failedRun));

// =============================================================================
// A GitHub-style repo: fetched on the agent's computer from a local bare remote
// =============================================================================
console.log("\n# A GitHub repo's main branch moves (a local bare remote)");
if (!localSandboxed) {
  console.log("SKIP  a GitHub repo is fetched on a local computer, which needs the macOS sandbox; not here");
} else {
  const pc = await computerManager.ensure(tot.id);
  const workspace = realpathSync(pc.backend.home(pc.externalId));
  // github.com/acme/web is a bare repo in the computer's home, and git is told to fetch that URL there.
  const bare = join(workspace, "remotes/web.git");
  const seed = join(OUTSIDE, "web-seed");
  makeRepo(seed, { "README.md": "web\n" });
  execFileSync("git", ["clone", "-q", "--bare", seed, bare], { env: GIT_ENV });
  execFileSync("git", ["config", "--file", join(workspace, ".gitconfig"), `url.${bare}.insteadOf`, "https://github.com/acme/web.git"], { env: GIT_ENV });
  git(seed, "remote", "add", "origin", bare);
  const web = projects.create({ kind: "github", source: "acme/web" });
  // Its most recent chat is Tot's, so Tot's computer (where git is told about the bare repo) reads it.
  conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Web", projectId: web.id });
  res = await call<KnowledgeRefreshResult>("POST", `/projects/${web.id}/knowledge/refresh`);
  check("Check now clones and fetches it, and records where main is", res.status === 200 && res.data.checked === 1 && res.data.moved === 0 && repoHeads.get(web.id, "web")?.sha === git(seed, "rev-parse", "main"), JSON.stringify(res.data));
  const pushed = commit(seed, { "docs/api.md": "# API\n" }, "Document the API");
  git(seed, "push", "-q", "origin", "main");
  model = fake([{ op: "fact_add", text: "API docs live in docs/api.md" }]);
  res = await call<KnowledgeRefreshResult>("POST", `/projects/${web.id}/knowledge/refresh`);
  check("a new commit on GitHub: an update is queued and shows as running", res.status === 200 && res.data.moved === 1 && (res.data.updates[0]?.running === true || knowledgeLog.list(web.id).length === 1), JSON.stringify(res.data));
  await until(() => knowledgeLog.list(web.id).length === 1);
  await knowledgeAuto.drain();
  const webRun = knowledgeLog.list(web.id)[0];
  const webDir = repo.repoDir(knowledgeRepo(web));
  check(
    "…applied: one commit “Knowledge: web moved to <sha7>”, logged as asked for",
    webRun?.trigger === "manual" && webRun.facts === 1 && (await kLog(webDir, "%s")) === `Knowledge: web moved to ${pushed.slice(0, 7)}` && lastPrompt().includes("Document the API") && lastPrompt().includes("docs/api.md"),
    `${JSON.stringify(webRun)} ${await kLog(webDir, "%s")}`,
  );
  check("…and nothing new: nothing to run", (await checkRepo(web, projectRepos(web)[0]!)) === null);

  // A task opened as a draft PR: its worktree stays, and its diff is read there.
  const { queueHolds } = await import("./data/queue-holds.ts");
  const { prepareTask } = await import("./projects/checkout.ts");
  const { tasks } = await import("./tasks/tasks.ts");
  queueHolds.set(tot.id, null, "test");
  const webChat = conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Web work", projectId: web.id });
  const prTask = tasks.create({ agentId: tot.id, parentId: webChat.id, goal: "Add a health endpoint" });
  const prRepo = await prepareTask(taskStore.get(prTask.id)!);
  const worktree = prRepo.worktree.startsWith("~/") ? join(workspace, prRepo.worktree.slice(2)) : prRepo.worktree;
  const prHead = commit(worktree, { "src/health.ts": "export const health = () => 'ok';\n" }, "Add a health endpoint");
  taskStore.patch(prTask.id, { repo: { ...prRepo, headSha: prHead }, summary: "Added GET /health." });
  model = fake([{ op: "fact_add", text: "GET /health answers ok" }]);
  taskStore.patch(prTask.id, { landing: { kind: "pr", target: "main", sha: prHead, pr: { number: 12, url: "https://github.com/acme/web/pull/12" }, at: Date.now() } }, true);
  await until(() => runFor(prTask.id) !== null);
  const prRun = runFor(prTask.id);
  check(
    "a draft PR's update reads the diff in its worktree on the agent's computer",
    prRun?.trigger === "landed" && prRun.facts === 1 && lastPrompt().includes('how="opened as draft PR #12 into main"') && lastPrompt().includes("src/health.ts | +1 −0") && lastPrompt().includes("+export const health"),
    `${JSON.stringify(prRun)} ${lastPrompt().slice(lastPrompt().indexOf("<change"), lastPrompt().indexOf("<change") + 300)}`,
  );
}

// =============================================================================
// Routes
// =============================================================================
console.log("\n# Routes");
list = (await call<KnowledgeUpdate[]>("GET", `/projects/${project.id}/knowledge/updates`)).data;
check("GET …/knowledge/updates: newest first, with what each changed", list.length >= 8 && list.every((u, i) => i === 0 || u.at <= list[i - 1]!.at) && list.some((u) => u.trigger === "landed" && u.pages.length), JSON.stringify(list.map((u) => u.summary)));
res = await call("GET", `/projects/nope/knowledge/updates`);
check("an unknown project is a 404", res.status === 404);
res = await call("POST", `/projects/${project.id}/knowledge/updates/nope/undo`);
check("undoing an unknown update is a 404", res.status === 404);
model = fake([]);
commit(shop, { "docs/faq.md": "FAQ\n" }, "Start an FAQ");
res = await call<KnowledgeRefreshResult>("POST", `/projects/${project.id}/knowledge/refresh`);
check("Check now on a folder project: the folder's main read on this Mac", res.status === 200 && res.data.checked === 1 && res.data.moved === 1 && res.data.updates[0]?.trigger === "manual", JSON.stringify({ ...res.data, updates: res.data.updates?.slice(0, 1) }));
await knowledgeAuto.drain();
const kept50 = Number((db.prepare(`SELECT COUNT(*) AS n FROM knowledge_updates WHERE project_id = ?`).get(project.id) as { n: number }).n);
check("the log keeps at most 50 per project", kept50 <= 50);

knowledgeAuto.stop();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
