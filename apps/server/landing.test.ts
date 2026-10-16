// Landing finished tasks (roadmap module 09, lane A): checks when a coding task is done, merging into a folder
// project on this Mac (done by TOT itself), a draft PR (a fake GitHub API, a local bare repo as the remote),
// updating a branch from its base, and discarding (also after cleanup removed a worktree). Real git and the macOS sandbox under a temp HOME; fake
// model turns, so a task "given a turn" never reaches a model.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/landing.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { AppEvent, Conversation, Message, Project, SendMessageRequest, TaskLandOptions } from "../shared/types.ts";

// A temp home, set before anything reads it: folder projects must be inside it. Like projects-folders.test.ts,
// it lives in the repo's git-ignored .scratch (sandboxed commands may write anywhere in the system temp folder).
const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), "..", ".scratch");
mkdirSync(SCRATCH, { recursive: true });
const HOME = realpathSync.native(mkdtempSync(join(SCRATCH, "land-home-")));
const OUTSIDE = realpathSync.native(mkdtempSync(join(SCRATCH, "land-outside-")));
process.env.HOME = HOME;
process.on("exit", () => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});
// A fake gh first on PATH (GitHub's status asks gh who's logged in), so the real one is never touched.
const bin = join(OUTSIDE, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
const GITHUB_PORT = 8838;
process.env.TOT_GITHUB_API_URL = `http://127.0.0.1:${GITHUB_PORT}`;
process.env.TOT_GITHUB_WEB_URL = `http://127.0.0.1:${GITHUB_PORT}`;
process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test

// --- A fake GitHub: who the token is, and the pull requests opened ------------------------------
const TOKEN = "ghp_landingtoken0123456789";
const pulls: { repo: string; auth: string; body: Record<string, unknown> }[] = [];
const fake = new Hono()
  .get("/user", (c) => {
    if (c.req.header("authorization") !== `Bearer ${TOKEN}`) return c.json({ message: "Bad credentials" }, 401);
    c.header("x-oauth-scopes", "repo, read:org");
    return c.json({ login: "octocat", name: "The Octocat", avatar_url: "https://avatars.example/octocat", id: 583231 });
  })
  .post("/repos/:owner/:repo/pulls", async (c) => {
    const repo = `${c.req.param("owner")}/${c.req.param("repo")}`;
    pulls.push({ repo, auth: c.req.header("authorization") ?? "", body: await c.req.json() });
    return c.json({ number: 11 + pulls.length, html_url: `https://github.com/${repo}/pull/${11 + pulls.length}` }, 201);
  });
const fakeServer = serve({ fetch: fake.fetch, port: GITHUB_PORT, hostname: "127.0.0.1" });

const { HttpError } = await import("./agent/orchestrator.ts");
const { MessageBuilder } = await import("./agent/message-builder.ts");
const { runRegistry } = await import("./agent/runs.ts");
const { appEvents } = await import("./app-events.ts");
const { computerManager } = await import("./computer/manager.ts");
const { localSandboxed } = await import("./computer/local.ts");
const { agents } = await import("./data/agents.ts");
const { conversations, toPublicConversation } = await import("./data/conversations.ts");
const { messages } = await import("./data/messages.ts");
const { queueHolds } = await import("./data/queue-holds.ts");
const { settings } = await import("./data/settings.ts");
const { github } = await import("./github.ts");
const { createApp } = await import("./app.ts");
const { taskChecks } = await import("./landing/checks.ts");
const { grantFor, prepareTask } = await import("./projects/checkout.ts");
const { runLoop } = await import("./tasks/run-loop.ts");
const { taskStore } = await import("./tasks/store.ts");
const { tasks } = await import("./tasks/tasks.ts");
const { worktrees } = await import("./tasks/worktree.ts");
const { repoProfiles } = await import("./trust/profile.ts");
type TurnOptions = import("./agent/orchestrator.ts").TurnOptions;
type TaskRecord = import("./tasks/store.ts").TaskRecord;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 300)}` : ""}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end && !condition(); ) await sleep(25);
}
const mascot = { shape: "blob" as const, color: "#60a5fa", accessory: "none" as const, eyes: "dots" as const };

settings.patch({ computer: { mode: "local" } });

// --- Fake model turns: each records what it was asked, then finishes its task ---------------------
const sent: { taskId: string; text: string }[] = [];
/** Work a turn does before it finishes its task (e.g. a review fix committed on its branch). */
const turnWork = new Map<string, () => void>();
async function fakeSend(conversationId: string, request: SendMessageRequest, _options: TurnOptions = {}) {
  if (runRegistry.activeFor(conversationId)) throw new HttpError(409, "Busy.");
  sent.push({ taskId: conversationId, text: request.text });
  const now = Date.now();
  const user: Message = { id: randomUUID(), conversationId, role: "user", parts: [{ type: "text", id: randomUUID(), text: request.text }], status: "complete", createdAt: now };
  messages.insert(user);
  const assistant: Message = { id: randomUUID(), conversationId, role: "assistant", parts: [], status: "streaming", createdAt: now + 1 };
  messages.insert(assistant);
  const run = runRegistry.create(conversationId, assistant.id);
  const builder = new MessageBuilder(assistant, (event) => run.push(event));
  run.reply = () => builder.message;
  void (async () => {
    await sleep(20);
    builder.apply({ type: "text-delta", blockId: randomUUID(), delta: "Done." });
    const work = turnWork.get(conversationId);
    turnWork.delete(conversationId);
    // Like a real turn, the work lands well after the loop has looked at the worktree.
    if (work) await sleep(800).then(work);
    if (taskStore.get(conversationId)?.task.status === "running") tasks.finish(conversationId, "done", "Rebased and resolved the conflicts.");
    const final = builder.finish("complete");
    messages.save(final);
    run.push({ type: "run-end", status: "complete", message: final });
    runRegistry.finish(run);
  })();
  return { runId: run.id, userMessage: user, conversation: toPublicConversation(conversations.get(conversationId)!) };
}
runLoop.useSender(fakeSend);

const events: AppEvent[] = [];
appEvents.subscribe((event) => events.push(event));
tasks.start();

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
const options = async (taskId: string) => (await call<TaskLandOptions>("GET", `/tasks/${taskId}/land`)).data;

// git as the user (or the test, standing in for an agent) runs it on this Mac.
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitOk = (cwd: string, ...args: string[]) => {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
};
function makeRepo(path: string, files: Record<string, string>): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  // The user's identity, for the merge commit TOT makes in their folder.
  git(path, "config", "user.name", "The User");
  git(path, "config", "user.email", "user@example.com");
  for (const [file, content] of Object.entries(files)) writeFileSync(join(path, file), content);
  git(path, "add", ".");
  git(path, "commit", "-qm", "init");
}
/** A commit of some files in a checkout. */
function commit(cwd: string, files: Record<string, string>, subject: string): string {
  for (const [file, content] of Object.entries(files)) writeFileSync(join(cwd, file), content);
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", subject);
  return git(cwd, "rev-parse", "HEAD");
}

const tot = agents.create({ name: "Tot", mascot });
// Tasks are created here and set up by hand (prepareTask, as the run loop does); none starts by itself.
queueHolds.set(tot.id, null, "test");
const pc = await computerManager.ensure(tot.id);
const workspace = realpathSync(pc.backend.home(pc.externalId));
/** A path on the agent's computer ("~/projects/…" or a folder on this Mac) as a path here. */
const local = (path: string) => (path.startsWith("~/") ? join(workspace, path.slice(2)) : path);

/** A task in a chat, set up, with `work` done in its worktree (as its agent would), and finished "done". */
async function doneTask(chatId: string, goal: string, work: (worktree: string) => void): Promise<TaskRecord> {
  const created = tasks.create({ agentId: tot.id, parentId: chatId, goal });
  const repo = await prepareTask(taskStore.get(created.id)!);
  work(local(repo.worktree));
  taskStore.patch(created.id, { repo: { ...repo, headSha: git(local(repo.worktree), "rev-parse", "HEAD") } });
  taskStore.transition(created.id, "running");
  tasks.finish(created.id, "done", `Did it: ${goal.toLowerCase()}.`);
  await until(() => taskStore.get(created.id)?.task.checks != null && !taskChecks.isRunning(created.id));
  return taskStore.get(created.id)!;
}

if (!localSandboxed) {
  console.log("SKIP  landing needs the macOS sandbox for folder projects; not here");
  fakeServer.close();
  process.exit(0);
}

// =============================================================================
// A folder project on this Mac: options, refusals, merge
// =============================================================================
console.log("\n# Merge into a folder project");
const shop = join(HOME, "code/shop");
makeRepo(shop, { "a.txt": "one\ntwo\nthree\n", "b.txt": "b\n" });
// The user has pushed their main to a remote of their own (a bare repo here), to show pushed branches survive.
execFileSync("git", ["clone", "-q", "--bare", shop, join(OUTSIDE, "shop.git")], { env: GIT_ENV });
git(shop, "remote", "add", "origin", join(OUTSIDE, "shop.git"));
git(shop, "fetch", "-q", "origin");
let res: { status: number; data: any } = await call<Project>("POST", "/projects", { kind: "folder", source: shop, grant: true });
const shopProject: Project = res.data;
check("a folder project with the user's OK", res.status === 201 && shopProject.folderGranted, JSON.stringify(res.data));
const shopChat = conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Shop", projectId: shopProject.id });

// A task that's still working can't land.
const conflicting = tasks.create({ agentId: tot.id, parentId: shopChat.id, goal: "Shout line two" });
const conflictingRepo = await prepareTask(taskStore.get(conflicting.id)!);
taskStore.patch(conflicting.id, { repo: conflictingRepo });
taskStore.transition(conflicting.id, "running");
let opts = await options(conflicting.id);
check("a running task can't land yet", !opts.merge.available && opts.merge.reason === "Wait for the task to finish, or stop it.", JSON.stringify(opts));

const greet = await doneTask(shopChat.id, "Add a greeting", (wt) => commit(wt, { "hello.txt": "hello\n" }, "Add a greeting"));
// No saved profile (no Learn a repo): the checks read one from the worktree. This repo has no test command, so only scope, deps and size run.
check(
  "no saved profile: the checks read the repo and run what they find",
  greet.task.checks?.state === "passing" && greet.task.checks.lines.join() === "scope passed,deps passed,size passed",
  JSON.stringify(greet.task.checks),
);
opts = await options(greet.id);
check(
  "a done task in a folder project: Merge into main, no PR, not behind",
  opts.merge.available && opts.merge.target === "main" && !opts.merge.reason && !opts.pr.available && opts.pr.reason === "Draft PRs are for GitHub projects." && opts.behind === 0,
  JSON.stringify(opts),
);

// Refusals, each leaving the user's folder exactly as it was.
const mainBefore = git(shop, "rev-parse", "main");
writeFileSync(join(shop, "b.txt"), "the user's own edit\n");
opts = await options(greet.id);
res = await call("POST", `/tasks/${greet.id}/land`, { method: "merge" });
check(
  "a folder with uncommitted changes: refused",
  !opts.merge.available && /uncommitted changes/.test(opts.merge.reason ?? "") && res.status === 409 && git(shop, "rev-parse", "main") === mainBefore,
  `${opts.merge.reason} ${JSON.stringify(res.data)}`,
);
git(shop, "checkout", "--", "b.txt");
git(shop, "checkout", "-q", "-b", "tot/by-hand-0000");
opts = await options(greet.id);
res = await call("POST", `/tasks/${greet.id}/land`, { method: "merge" });
check(
  "a folder on a tot/* branch: refused",
  !opts.merge.available && opts.merge.reason?.includes("has tot/by-hand-0000 checked out") === true && res.status === 409 && git(shop, "rev-parse", "tot/by-hand-0000") === mainBefore,
  `${opts.merge.reason} ${JSON.stringify(res.data)}`,
);
git(shop, "checkout", "-q", "--detach", "main");
opts = await options(greet.id);
check("a detached folder: refused", !opts.merge.available && opts.merge.reason?.includes("isn't on a branch") === true, JSON.stringify(opts.merge));
git(shop, "checkout", "-q", "main");
git(shop, "branch", "-D", "tot/by-hand-0000");
res = await call("POST", `/tasks/${greet.id}/land`, { method: "zip" });
check("an unknown method is a 400", res.status === 400, JSON.stringify(res.data));

// The other task changes line two; so does the user, on main: a conflict.
commit(local(conflictingRepo.worktree), { "a.txt": "one\nTWO!\nthree\n" }, "Shout line two");
taskStore.patch(conflicting.id, { repo: { ...conflictingRepo, headSha: git(local(conflictingRepo.worktree), "rev-parse", "HEAD") } });
tasks.finish(conflicting.id, "done", "Shouted.");
const userCommit = commit(shop, { "a.txt": "one\n2\nthree\n" }, "Number line two");
opts = await options(conflicting.id);
res = await call("POST", `/tasks/${conflicting.id}/land`, { method: "merge" });
check(
  "conflicts with main (git merge-tree): refused before anything is touched",
  !opts.merge.available &&
    opts.merge.reason === "Conflicts with main. Update from main first." &&
    opts.behind === 1 &&
    res.status === 409 &&
    git(shop, "rev-parse", "HEAD") === userCommit &&
    !gitOk(shop, "rev-parse", "--verify", "--quiet", "MERGE_HEAD") &&
    git(shop, "status", "--porcelain") === "",
  `${JSON.stringify(opts)} ${JSON.stringify(res.data)}`,
);

const before = events.length;
res = await call<Conversation>("POST", `/tasks/${greet.id}/land`, { method: "merge" });
const merged = res.data.task?.landing;
check(
  "Merge: a --no-ff merge commit in the user's folder, made by TOT",
  res.status === 200 &&
    merged?.kind === "merged" &&
    merged.target === "main" &&
    merged.sha === git(shop, "rev-parse", "main") &&
    git(shop, "log", "-1", "--format=%s %P").startsWith(`Merge ${greet.task.repo!.branch}: Add a greeting ${userCommit}`) &&
    existsSync(join(shop, "hello.txt")) &&
    git(shop, "status", "--porcelain") === "",
  `${res.status} ${JSON.stringify(res.data.task?.landing ?? res.data)} ${git(shop, "log", "-1", "--format=%s %P")}`,
);
check(
  "…then its worktree goes, and its merged branch",
  !existsSync(greet.task.repo!.worktree) && !git(shop, "branch", "--list", greet.task.repo!.branch),
  git(shop, "branch", "--list"),
);
check(
  "…and every tab hears about it",
  events.slice(before).some((event) => event.type === "task" && event.conversation.id === greet.id && event.conversation.task?.landing?.kind === "merged"),
);
res = await call("POST", `/tasks/${greet.id}/land`, { method: "merge" });
check("merging it again is refused", res.status === 409 && /Already merged into main/.test(res.data.error), JSON.stringify(res.data));

// =============================================================================
// Update from main
// =============================================================================
console.log("\n# Update from main");
let sentBefore = sent.length;
res = await call<Conversation>("POST", `/tasks/${conflicting.id}/update-from-base`);
const conflictingWorktree = conflictingRepo.worktree;
const rebaseDirs = ["rebase-merge", "rebase-apply"].map((dir) => join(shop, ".git/worktrees", conflictingWorktree.split("/").pop()!, dir));
check(
  "a rebase that conflicts is undone, and the task gets a turn to resolve it",
  res.status === 200 &&
    res.data.task?.status === "running" &&
    sent.slice(sentBefore).some((turn) => turn.taskId === conflicting.id && turn.text === "Rebase onto main and resolve the conflicts, keeping both sides' intent, then run the checks.") &&
    rebaseDirs.every((dir) => !existsSync(dir)) &&
    git(conflictingWorktree, "status", "--porcelain") === "" &&
    git(conflictingWorktree, "rev-parse", "HEAD") === taskStore.get(conflicting.id)!.task.repo!.headSha,
  `${res.status} ${res.data.task?.status ?? JSON.stringify(res.data)} ${JSON.stringify(sent.slice(sentBefore))}`,
);
await until(() => taskStore.get(conflicting.id)?.task.status === "done");
check("…the turn it took (the fake one here) finished it again", taskStore.get(conflicting.id)?.task.status === "done");

const tidy = await doneTask(shopChat.id, "Tidy b", (wt) => commit(wt, { "b.txt": "b, tidied\n" }, "Tidy b"));
commit(shop, { "c.txt": "the user's\n" }, "Add c");
opts = await options(tidy.id);
check("a task whose base moved on is behind", opts.behind === 1 && opts.merge.available, JSON.stringify(opts));
res = await call<Conversation>("POST", `/tasks/${tidy.id}/update-from-base`);
const tidyWorktree = tidy.task.repo!.worktree;
check(
  "a clean rebase onto main, in the worktree, through the sandbox: no turn needed",
  res.status === 200 &&
    res.data.task?.status === "done" &&
    git(tidyWorktree, "merge-base", "HEAD", "main") === git(shop, "rev-parse", "main") &&
    git(tidyWorktree, "log", "-1", "--format=%s") === "Tidy b" &&
    res.data.task?.repo?.headSha === git(tidyWorktree, "rev-parse", "HEAD") &&
    !sent.some((turn) => turn.taskId === tidy.id),
  `${res.status} ${JSON.stringify(res.data.task?.repo ?? res.data)}`,
);
check("…and it's no longer behind", (await options(tidy.id)).behind === 0);

writeFileSync(join(tidyWorktree, "b.txt"), "left uncommitted\n");
opts = await options(tidy.id);
check(
  "work left uncommitted in the worktree: refused",
  !opts.merge.available && opts.merge.reason === "This task has files it didn't commit (b.txt). Reply to the task to commit them, or discard it.",
  JSON.stringify(opts.merge),
);
commit(shop, { "d.txt": "more\n" }, "Add d");
sentBefore = sent.length;
res = await call<Conversation>("POST", `/tasks/${tidy.id}/update-from-base`);
check(
  "…and Update from main asks the task to commit first",
  res.status === 200 && sent.slice(sentBefore).some((turn) => turn.taskId === tidy.id && turn.text.startsWith("Commit your work, then rebase onto main")),
  JSON.stringify(sent.slice(sentBefore)),
);
await until(() => taskStore.get(tidy.id)?.task.status === "done");
git(tidyWorktree, "checkout", "--", "b.txt");
res = await call<Conversation>("POST", `/tasks/${tidy.id}/update-from-base`);
const tidyHead = git(tidyWorktree, "rev-parse", "HEAD");
check("…once it's committed, Update from main rebases it", res.status === 200 && res.data.task?.repo?.headSha === tidyHead && (await options(tidy.id)).behind === 0, JSON.stringify(res.data.task?.repo));
res = await call("POST", `/tasks/${tidy.id}/update-from-base`);
check("updating a task that's up to date changes nothing", res.status === 200 && git(tidyWorktree, "rev-parse", "HEAD") === tidyHead, JSON.stringify(res.data));

// =============================================================================
// Discard
// =============================================================================
console.log("\n# Discard");
const scrap = await doneTask(shopChat.id, "Try a rewrite", (wt) => commit(wt, { "rewrite.txt": "maybe\n" }, "Try a rewrite"));
res = await call<Conversation>("POST", `/tasks/${scrap.id}/discard`);
check(
  "Discard removes the worktree and the unpushed branch",
  res.status === 200 && res.data.task?.landing?.kind === "discarded" && !existsSync(scrap.task.repo!.worktree) && !git(shop, "branch", "--list", scrap.task.repo!.branch),
  JSON.stringify(res.data.task?.landing ?? res.data),
);
res = await call<Conversation>("POST", `/tasks/${scrap.id}/discard`);
check("…discarding again is a no-op", res.status === 200 && res.data.task?.landing?.kind === "discarded");
res = await call("POST", `/tasks/${scrap.id}/land`, { method: "merge" });
check("…and it can't be landed afterwards", res.status === 409 && /discarded/.test(res.data.error), JSON.stringify(res.data));

const shared = await doneTask(shopChat.id, "Share a draft", (wt) => {
  commit(wt, { "draft.txt": "shared\n" }, "Share a draft");
  // The user pushed it to their remote to show someone.
  git(wt, "push", "-q", "origin", "HEAD");
  git(shop, "fetch", "-q", "origin", `+refs/heads/*:refs/remotes/origin/*`);
});
res = await call<Conversation>("POST", `/tasks/${shared.id}/discard`);
check(
  "Discard keeps a branch that was pushed (its worktree still goes)",
  res.status === 200 && res.data.task?.landing?.kind === "discarded" && !existsSync(shared.task.repo!.worktree) && git(shop, "branch", "--list", shared.task.repo!.branch).includes(shared.task.repo!.branch),
  git(shop, "branch", "--list"),
);
// Cleanup (lane C) removes an old task's worktree and forgets its head; its branch stays.
const stale = await doneTask(shopChat.id, "Stale work", (wt) => commit(wt, { "stale.txt": "old\n" }, "Stale work"));
await worktrees.remove(tot.id, stale.task.repo!, { grant: grantFor(stale) });
taskStore.patch(stale.id, { repo: { ...stale.task.repo!, headSha: null } });
const cleanedUp = "This task's worktree was cleaned up. Reply to the task to pick it up again.";
opts = await options(stale.id);
res = await call("POST", `/tasks/${stale.id}/update-from-base`);
check(
  "a task whose worktree was cleaned up says so, and how to pick it up again",
  opts.merge.reason === cleanedUp && !opts.merge.available && res.status === 409 && res.data.error === cleanedUp,
  `${JSON.stringify(opts.merge)} ${JSON.stringify(res.data)}`,
);
res = await call<Conversation>("POST", `/tasks/${stale.id}/discard`);
check(
  "…and discarding it deletes its unpushed branch",
  res.status === 200 && res.data.task?.landing?.kind === "discarded" && !git(shop, "branch", "--list", stale.task.repo!.branch),
  git(shop, "branch", "--list"),
);
const waiting = tasks.create({ agentId: tot.id, parentId: shopChat.id, goal: "Wait in line" });
res = await call<Conversation>("POST", `/tasks/${waiting.id}/discard`);
check("Discard stops a task that hasn't finished", res.status === 200 && res.data.task?.status === "stopped" && res.data.task?.landing?.kind === "discarded", JSON.stringify(res.data.task));

// =============================================================================
// Checks: a repo profile's gates when a task is done, and on demand
// =============================================================================
console.log("\n# Checks");
repoProfiles.save(shopProject.brainId, { commands: { typecheck: "true", test: "test -f a.txt && test ! -f broken.txt" } }, "user");
const good = await doneTask(shopChat.id, "Add an index", (wt) => commit(wt, { "index.txt": "index\n" }, "Add an index"));
check(
  "a done task in a folder project gets its gates, run in its worktree through its grant",
  good.task.checks?.state === "passing" &&
    ["typecheck passed", "test passed", "scope passed", "deps passed", "size passed"].every((line) => good.task.checks!.lines.includes(line)) &&
    good.task.checks.headSha === good.task.repo!.headSha,
  JSON.stringify(good.task.checks),
);
const bad = await doneTask(shopChat.id, "Break the build", (wt) => commit(wt, { "broken.txt": "oops\n" }, "Break the build"));
check(
  "…a gate that fails makes them failing, one line per gate",
  bad.task.checks?.state === "failing" && bad.task.checks.lines.some((line) => line.startsWith("test failed")) && bad.task.checks.lines.includes("typecheck passed"),
  JSON.stringify(bad.task.checks),
);
git(bad.task.repo!.worktree, "rm", "-q", "broken.txt");
git(bad.task.repo!.worktree, "commit", "-qm", "Remove broken.txt");
res = await call<Conversation>("POST", `/tasks/${bad.id}/checks`);
check("POST /checks runs them again: “running” right away", res.status === 200 && res.data.task?.checks?.state === "running", JSON.stringify(res.data.task?.checks));
await taskChecks.settled(bad.id);
check("…and they pass now", taskStore.get(bad.id)?.task.checks?.state === "passing", JSON.stringify(taskStore.get(bad.id)?.task.checks));

// =============================================================================
// A GitHub project: draft PRs
// =============================================================================
console.log("\n# Draft PR on GitHub");
// github.com/acme/web is a bare repo in the computer's home, and git is told to fetch and push that URL there.
const bare = join(workspace, "remotes/web.git");
const seed = join(OUTSIDE, "web-seed");
makeRepo(seed, { "README.md": "web\n" });
execFileSync("git", ["clone", "-q", "--bare", seed, bare], { env: GIT_ENV });
execFileSync("git", ["config", "--file", join(workspace, ".gitconfig"), `url.${bare}.insteadOf`, "https://github.com/acme/web.git"], { env: GIT_ENV });
await github.connect({ method: "token", token: TOKEN });
res = await call<Project>("POST", "/projects", { kind: "github", source: "acme/web" });
const web: Project = res.data;
repoProfiles.save(web.brainId, { commands: { test: "test -f README.md" } }, "user");
const webChat = conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Web", projectId: web.id });
const footer = await doneTask(webChat.id, "Fix the footer", (wt) => commit(wt, { "footer.txt": "footer\n" }, "Fix the footer"));
const footerBranch = footer.task.repo!.branch;
const pushedRefs = () => git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/");
check("checks run on a GitHub project's clone too", footer.task.checks?.state === "passing" && footer.task.checks.lines.includes("test passed"), JSON.stringify(footer.task.checks));

opts = await options(footer.id);
res = await call("POST", `/tasks/${footer.id}/land`, { method: "pr" });
check(
  "GitHub writes off: no PR, and nothing is pushed",
  !opts.pr.available && opts.pr.reason === "Turn on GitHub writes in Settings → GitHub." && opts.pr.base === "main" && res.status === 409 && pushedRefs() === "refs/heads/main" && pulls.length === 0,
  `${JSON.stringify(opts.pr)} ${JSON.stringify(res.data)} ${pushedRefs()}`,
);
check("…and merging is only for folders on this Mac", !opts.merge.available && opts.merge.reason === "Merging is for folders on this Mac. Open a draft PR instead.", JSON.stringify(opts.merge));

await github.setAllowWrites(true);
const other = await doneTask(webChat.id, "Rename a thing", (wt) => commit(wt, { "rename.txt": "renamed\n" }, "Rename a thing"));
taskStore.patch(other.id, { repo: { ...other.task.repo!, branch: "feature/rename" } });
opts = await options(other.id);
res = await call("POST", `/tasks/${other.id}/land`, { method: "pr" });
check(
  "a branch that isn't tot/*: never pushed",
  !opts.pr.available && opts.pr.reason === "Only TOT's own tot/… branches are pushed." && res.status === 409 && pushedRefs() === "refs/heads/main" && pulls.length === 0,
  `${JSON.stringify(opts.pr)} ${pushedRefs()}`,
);

opts = await options(footer.id);
check("GitHub writes on: Open draft PR", opts.pr.available && !opts.pr.reason, JSON.stringify(opts.pr));
const mainOnGitHub = git(bare, "rev-parse", "main");
res = await call<Conversation>("POST", `/tasks/${footer.id}/land`, { method: "pr" });
const pr = res.data.task?.landing;
const head = git(local(footer.task.repo!.worktree), "rev-parse", "HEAD");
check(
  "Open draft PR: the tot/* branch pushed (only it), then a draft PR into main",
  res.status === 200 &&
    pr?.kind === "pr" &&
    pr.target === "main" &&
    pr.sha === head &&
    pr.pr?.number === 12 &&
    pr.pr.url === "https://github.com/acme/web/pull/12" &&
    git(bare, "rev-parse", footerBranch) === head &&
    git(bare, "rev-parse", "main") === mainOnGitHub,
  `${res.status} ${JSON.stringify(pr ?? res.data)} ${pushedRefs()}`,
);
const opened = pulls[0];
const prBody = String(opened?.body.body ?? "");
check(
  "…as the agent's account, a draft, with the task's title",
  pulls.length === 1 &&
    opened?.repo === "acme/web" &&
    opened.auth === `Bearer ${TOKEN}` &&
    opened.body.draft === true &&
    opened.body.head === footerBranch &&
    opened.body.base === "main" &&
    opened.body.title === "Fix the footer",
  JSON.stringify({ ...opened, auth: undefined }),
);
check(
  "…its body: the goal, summary, files changed, checks and who it's for",
  prBody.startsWith("Fix the footer") &&
    prBody.includes("## Summary\nDid it: fix the footer.") &&
    prBody.includes("## Files changed\n- `footer.txt` (+1 −0)") &&
    prBody.includes("## Checks\n- test passed") &&
    prBody.endsWith("Opened by TOT for @octocat"),
  prBody,
);
check("…and the worktree stays, for review fixes", existsSync(local(footer.task.repo!.worktree)));
res = await call("POST", `/tasks/${footer.id}/land`, { method: "pr" });
check("opening it again is refused", res.status === 409 && /draft PR #12/.test(res.data.error), JSON.stringify(res.data));
res = await call("POST", `/tasks/${footer.id}/discard`);
check("…and so is discarding it (close the PR on GitHub)", res.status === 409 && pushedRefs().includes(footerBranch), JSON.stringify(res.data));
let reviewFix = "";
turnWork.set(footer.id, () => {
  reviewFix = commit(local(footer.task.repo!.worktree), { "footer.txt": "footer, reviewed\n" }, "Address the review comments");
});
await tasks.message(footer.id, { text: "Address the review comments" });
await until(() => taskStore.get(footer.id)?.task.status === "done");
check(
  "a draft PR's task picked up again keeps its PR (the branch carries on)",
  taskStore.get(footer.id)?.task.landing?.kind === "pr" && existsSync(local(footer.task.repo!.worktree)),
  JSON.stringify(taskStore.get(footer.id)?.task.landing),
);
await until(() => taskStore.get(footer.id)?.task.repo?.headSha === reviewFix, 5000).catch(() => {});
check(
  "…and the commit that turn made is the task's head (a message's turn is recorded, even when it finishes the task)",
  Boolean(reviewFix) && taskStore.get(footer.id)?.task.repo?.headSha === reviewFix,
  `${taskStore.get(footer.id)?.task.repo?.headSha} vs ${reviewFix}`,
);

// =============================================================================
// Landing safely: only what was committed and reviewed, never over the user's files, one merge at a time
// =============================================================================
console.log("\n# Landing safely");
const lab = join(HOME, "code/lab");
makeRepo(lab, { "main.ts": "export {};\n", ".gitignore": ".env\n" });
const labProject: Project = (await call<Project>("POST", "/projects", { kind: "folder", source: lab, grant: true })).data;
const labChat = conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Lab", projectId: labProject.id });
const labDone = (goal: string, work: (worktree: string) => void) => doneTask(labChat.id, goal, work);
const merges = () => Number(git(lab, "rev-list", "--count", "--merges", "HEAD"));

// A file the task made and never added: the merge wouldn't carry it, and removing the worktree would lose it.
const importer = await labDone("Use a new module", (wt) => {
  commit(wt, { "main.ts": "import './new';\n" }, "Use a new module");
  writeFileSync(join(wt, "new.ts"), "export const fresh = true;\n");
});
const importerTree = local(importer.task.repo!.worktree);
const labHead = git(lab, "rev-parse", "HEAD");
opts = await options(importer.id);
res = await call("POST", `/tasks/${importer.id}/land`, { method: "merge" });
check(
  "a file left untracked in the worktree: refused, by name, and nothing is merged",
  !opts.merge.available &&
    opts.merge.reason === "This task has files it didn't commit (new.ts). Reply to the task to commit them, or discard it." &&
    res.status === 409 &&
    git(lab, "rev-parse", "HEAD") === labHead &&
    existsSync(join(importerTree, "new.ts")),
  `${JSON.stringify(opts.merge)} ${JSON.stringify(res.data)}`,
);
let removeError = "";
await worktrees.remove(tot.id, importer.task.repo!, { grant: grantFor(importer) }).catch((err: Error) => (removeError = err.message));
check("…and removing a worktree with new files is refused (no --force) and keeps them", Boolean(removeError) && existsSync(join(importerTree, "new.ts")), removeError);
git(importerTree, "add", "new.ts");
git(importerTree, "commit", "-qm", "Add the new module");
const importerHead = git(importerTree, "rev-parse", "HEAD");
res = await call<Conversation>("POST", `/tasks/${importer.id}/land`, { method: "merge", headSha: importer.task.repo!.headSha });
check("the head the user reviewed: a commit made since is refused", res.status === 409 && res.data.error === "The task's branch changed since you looked. Review it again." && git(lab, "rev-parse", "HEAD") === labHead, JSON.stringify(res.data));
res = await call<Conversation>("POST", `/tasks/${importer.id}/land`, { method: "merge", headSha: "zzz" });
check("…a headSha that isn't one is a 400", res.status === 400, JSON.stringify(res.data));
res = await call<Conversation>("POST", `/tasks/${importer.id}/land`, { method: "merge", headSha: importerHead });
check(
  "…and the head now, once reviewed, is merged, its worktree removed (clean, no force)",
  res.status === 200 && res.data.task?.landing?.kind === "merged" && existsSync(join(lab, "new.ts")) && !existsSync(importerTree),
  JSON.stringify(res.data.task?.landing ?? res.data),
);

// A worktree that isn't on its branch anymore.
const wanderer = await labDone("Wander off", (wt) => commit(wt, { "w.txt": "w\n" }, "Wander off"));
const wandererTree = local(wanderer.task.repo!.worktree);
git(wandererTree, "checkout", "-q", "--detach");
opts = await options(wanderer.id);
check(
  "a worktree on a detached HEAD: refused, saying so",
  !opts.merge.available && opts.merge.reason?.startsWith(`The task's worktree isn't on a branch (detached HEAD), not ${wanderer.task.repo!.branch}.`) === true,
  JSON.stringify(opts.merge),
);
git(wandererTree, "checkout", "-q", wanderer.task.repo!.branch);

// The branch force-added a file the user's folder ignores, and the user has their own copy.
writeFileSync(join(lab, ".env"), "USER_SECRET=mine\n");
const envy = await labDone("Commit an env file", (wt) => {
  writeFileSync(join(wt, ".env"), "FROM_BRANCH=1\n");
  git(wt, "add", "-f", ".env");
  git(wt, "commit", "-qm", "Commit an env file");
});
const beforeEnv = git(lab, "rev-parse", "HEAD");
opts = await options(envy.id);
res = await call("POST", `/tasks/${envy.id}/land`, { method: "merge" });
check(
  "a branch changing a file git ignores in the folder (which has its own): refused, by name, the user's copy kept",
  !opts.merge.available &&
    opts.merge.reason === "Merging would replace a file git ignores in your folder with the branch's: .env. Move it aside, then merge." &&
    res.status === 409 &&
    readFileSync(join(lab, ".env"), "utf8") === "USER_SECRET=mine\n" &&
    git(lab, "rev-parse", "HEAD") === beforeEnv,
  `${JSON.stringify(opts.merge)} ${readFileSync(join(lab, ".env"), "utf8")}`,
);
await call("POST", `/tasks/${envy.id}/discard`);

// Two merges into one folder at once: one after the other, both land.
const one = await labDone("Add one", (wt) => commit(wt, { "one.txt": "1\n" }, "Add one"));
const two = await labDone("Add two", (wt) => commit(wt, { "two.txt": "2\n" }, "Add two"));
const mergesBefore = merges();
const both = await Promise.all([call<Conversation>("POST", `/tasks/${one.id}/land`, { method: "merge" }), call<Conversation>("POST", `/tasks/${two.id}/land`, { method: "merge" })]);
check(
  "two merges into the same folder at once both land, one after the other",
  both.every((r) => r.status === 200 && r.data.task?.landing?.kind === "merged") &&
    merges() === mergesBefore + 2 &&
    existsSync(join(lab, "one.txt")) &&
    existsSync(join(lab, "two.txt")) &&
    git(lab, "status", "--porcelain") === "",
  both.map((r) => JSON.stringify(r.data.task?.landing ?? r.data)).join(" "),
);

// git in the folder doesn't follow TOT's own GIT_* variables somewhere else.
const decoy = join(OUTSIDE, "decoy");
makeRepo(decoy, { "decoy.txt": "decoy\n" });
const decoyHead = git(decoy, "rev-parse", "HEAD");
const three = await labDone("Add three", (wt) => commit(wt, { "three.txt": "3\n" }, "Add three"));
Object.assign(process.env, { GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy, GIT_INDEX_FILE: join(decoy, ".git/index") });
try {
  opts = await options(three.id);
  res = await call<Conversation>("POST", `/tasks/${three.id}/land`, { method: "merge" });
} finally {
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete process.env[name];
}
check(
  "TOT's own GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE don't reach git in the user's folder",
  opts.merge.available && res.status === 200 && existsSync(join(lab, "three.txt")) && git(decoy, "rev-parse", "HEAD") === decoyHead && git(decoy, "status", "--porcelain") === "",
  `${JSON.stringify(opts.merge)} ${JSON.stringify(res.data.task?.landing ?? res.data)}`,
);

// A merge that fails: aborted only when it's TOT's own, and a half-merged folder is said so.
const hook = join(lab, ".git/hooks/pre-merge-commit");
mkdirSync(dirname(hook), { recursive: true });
writeFileSync(hook, "#!/bin/sh\necho 'the hook says no' >&2\nexit 1\n");
chmodSync(hook, 0o755);
const four = await labDone("Add four", (wt) => commit(wt, { "four.txt": "4\n" }, "Add four"));
const beforeFour = git(lab, "rev-parse", "HEAD");
res = await call("POST", `/tasks/${four.id}/land`, { method: "merge" });
check(
  "a merge git stops (the user's hook) is TOT's: aborted, the folder as it was",
  res.status === 409 &&
    String(res.data.error).includes("the hook says no") &&
    !gitOk(lab, "rev-parse", "--verify", "--quiet", "MERGE_HEAD") &&
    git(lab, "status", "--porcelain") === "" &&
    git(lab, "rev-parse", "HEAD") === beforeFour,
  JSON.stringify(res.data),
);
rmSync(hook);
// git standing in for one that's stopped halfway: `merge` merges without committing, then leaves MERGE_HEAD as the test says.
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const wrapped = join(OUTSIDE, "wrapped-git");
const mode = join(OUTSIDE, "merge-mode");
mkdirSync(wrapped);
writeFileSync(
  join(wrapped, "git"),
  `#!/bin/sh
if [ "$1" = merge ] && [ "$2" = --no-ff ]; then
  for last; do :; done
  ${realGit} merge --no-ff --no-commit --no-stat "$last" >/dev/null 2>&1
  case "$(cat ${mode})" in
    other) ${realGit} rev-parse HEAD > .git/MERGE_HEAD ;;
    half) rm -f .git/MERGE_HEAD ;;
  esac
  echo "fatal: stopped halfway" >&2
  exit 1
fi
exec ${realGit} "$@"
`,
);
chmodSync(join(wrapped, "git"), 0o755);
const pathBefore = process.env.PATH;
const landWith = async (how: string, taskId: string) => {
  writeFileSync(mode, how);
  process.env.PATH = `${wrapped}:${pathBefore}`;
  try {
    return await call("POST", `/tasks/${taskId}/land`, { method: "merge" });
  } finally {
    process.env.PATH = pathBefore;
  }
};
res = await landWith("other", four.id);
check(
  "a failed merge that left someone else's MERGE_HEAD: not aborted, and said so",
  res.status === 409 && String(res.data.error).includes("in the middle of another merge now, which TOT left alone") && gitOk(lab, "rev-parse", "--verify", "--quiet", "MERGE_HEAD"),
  JSON.stringify(res.data),
);
git(lab, "merge", "--abort");
res = await landWith("half", four.id);
check(
  "a merge stopped halfway with no MERGE_HEAD: the half-merged folder is reported, not touched",
  res.status === 409 && String(res.data.error).startsWith(`Git stopped partway through merging ${four.task.repo!.branch}`) && git(lab, "status", "--porcelain", "--untracked-files=no") !== "",
  `${JSON.stringify(res.data)} ${git(lab, "status", "--porcelain")}`,
);
git(lab, "reset", "-q", "--hard", "HEAD");
rmSync(join(lab, ".git/MERGE_MSG"), { force: true });
rmSync(join(lab, ".git/MERGE_MODE"), { force: true });
res = await call<Conversation>("POST", `/tasks/${four.id}/land`, { method: "merge" });
check("…and once the folder's sorted, it merges", res.status === 200 && res.data.task?.landing?.kind === "merged", JSON.stringify(res.data.task?.landing ?? res.data));

// Merged or discarded, then picked up again: new work in a new worktree, which can land again.
const mergedBranch = four.task.repo!.branch;
await tasks.message(four.id, { text: "One more thing" });
await until(() => taskStore.get(four.id)?.task.status === "done");
let again = taskStore.get(four.id)!;
opts = await options(four.id);
check(
  "a merged task picked up again: its landing is cleared, its worktree and branch made again from main",
  again.task.landing === null &&
    existsSync(again.task.repo!.worktree) &&
    git(lab, "branch", "--list", mergedBranch).includes(mergedBranch) &&
    again.task.repo!.headSha === git(lab, "rev-parse", "main") &&
    opts.merge.reason === "The branch has no commits yet.",
  `${JSON.stringify(again.task.landing)} ${JSON.stringify(opts.merge)}`,
);
commit(again.task.repo!.worktree, { "five.txt": "5\n" }, "Add five");
taskStore.patch(four.id, { repo: { ...again.task.repo!, headSha: git(again.task.repo!.worktree, "rev-parse", "HEAD") } });
res = await call<Conversation>("POST", `/tasks/${four.id}/land`, { method: "merge" });
check("…and its new work lands again", res.status === 200 && res.data.task?.landing?.kind === "merged" && existsSync(join(lab, "five.txt")), JSON.stringify(res.data.task?.landing ?? res.data));
const dropped = await labDone("Try something", (wt) => commit(wt, { "maybe.txt": "?\n" }, "Try something"));
await call("POST", `/tasks/${dropped.id}/discard`);
await tasks.message(dropped.id, { text: "Try again, differently" });
await until(() => taskStore.get(dropped.id)?.task.status === "done");
again = taskStore.get(dropped.id)!;
check(
  "a discarded task picked up again: landing cleared, a new worktree from main",
  again.task.landing === null && existsSync(again.task.repo!.worktree) && !existsSync(join(again.task.repo!.worktree, "maybe.txt")),
  JSON.stringify(again.task.landing),
);


fakeServer.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
