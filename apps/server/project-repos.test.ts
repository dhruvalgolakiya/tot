// A project's repos (roadmap module 11, lane A): the migration that gives every project with code its one primary
// repo (keeping its checkout), adding, renaming, making primary and removing repos, a task per repo with its worktree
// in that repo (a GitHub repo cloned at ~/projects/<slug>.<name>, a folder on this Mac in place), landing into the
// right folder, overlaps only within a repo, and a folder grant per repo (checked against the real macOS sandbox).
// Real git under a temp HOME; no network (GitHub URLs lead to local bare repos); no model turns, no ports.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/project-repos.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Conversation, Project, TaskLandOptions } from "../shared/types.ts";

// A temp home, set before anything reads it: folders on this Mac must be inside it. Like landing.test.ts, it lives
// in the repo's git-ignored .scratch (sandboxed commands may write anywhere in the system temp folder).
const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), "..", ".scratch");
mkdirSync(SCRATCH, { recursive: true });
const HOME = realpathSync.native(mkdtempSync(join(SCRATCH, "repos-home-")));
const OUTSIDE = realpathSync.native(mkdtempSync(join(SCRATCH, "repos-outside-")));
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
process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 300)}` : ""}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end && !condition(); ) await sleep(25);
}
const threw = (fn: () => unknown) => {
  try {
    fn();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

// git as the user (or the test, standing in for an agent) runs it on this Mac.
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function makeRepo(path: string, files: Record<string, string>): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  git(path, "config", "user.name", "The User");
  git(path, "config", "user.email", "user@example.com");
  for (const [file, content] of Object.entries(files)) writeFileSync(join(path, file), content);
  git(path, "add", ".");
  git(path, "commit", "-qm", "init");
}
function commit(cwd: string, files: Record<string, string>, subject: string): string {
  for (const [file, content] of Object.entries(files)) writeFileSync(join(cwd, file), content);
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", subject);
  return git(cwd, "rev-parse", "HEAD");
}

// =============================================================================
// Migration: projects from before module 11 get their one repo as the primary
// =============================================================================
console.log("\n# Migration");
const legacyFolder = join(HOME, "code/legacy");
makeRepo(legacyFolder, { "a.txt": "a\n" });
const { db } = await import("./db.ts");
const seed = db.prepare(
  `INSERT INTO projects (id, name, slug, kind, source, default_branch, brain_id, folder_granted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
);
seed.run("p-web", "Web app", "web-app", "github", "acme/web", "develop", "b-web", null);
seed.run("p-legacy", "Legacy", "legacy", "folder", legacyFolder, null, "b-legacy", 1234);
seed.run("p-notes", "Notes", "notes", "folder", join(HOME, "code/not-yet"), null, "b-notes", null);
seed.run("p-topic", "Q4 launch", "q4-launch", "none", null, null, "b-topic", null);
const { migrateProjectRepos, projectRepos } = await import("./projects/repos.ts");
const migrated = migrateProjectRepos();
const rows = () => db.prepare(`SELECT project_id, name, kind, source, default_branch, folder_granted_at, position, checkout FROM project_repos ORDER BY project_id`).all();
const after = rows();
check(
  "every project with a repo or a folder gets one primary repo, with its source, base branch and grant",
  migrated === 3 &&
    JSON.stringify(after) ===
      JSON.stringify([
        { project_id: "p-legacy", name: "legacy", kind: "folder", source: legacyFolder, default_branch: null, folder_granted_at: 1234, position: 0, checkout: null },
        { project_id: "p-notes", name: "not-yet", kind: "folder", source: join(HOME, "code/not-yet"), default_branch: null, folder_granted_at: null, position: 0, checkout: null },
        { project_id: "p-web", name: "web", kind: "github", source: "acme/web", default_branch: "develop", folder_granted_at: null, position: 0, checkout: "~/projects/web-app" },
      ]),
  JSON.stringify(after),
);
check("…a GitHub project keeps its clone at ~/projects/<slug>, a folder project its folder", projectRepos.folder(projectRepos.primary("p-web")!) === "~/projects/web-app" && projectRepos.folder(projectRepos.primary("p-legacy")!) === legacyFolder);
check("…a topic project gets none", projectRepos.list("p-topic").length === 0);
check("…and running it again changes nothing", migrateProjectRepos() === 0 && JSON.stringify(rows()) === JSON.stringify(after));

// The rest of the app, now that the old rows are in place.
const { computerManager } = await import("./computer/manager.ts");
const { localSandboxed } = await import("./computer/local.ts");
const { agents } = await import("./data/agents.ts");
const { conversations } = await import("./data/conversations.ts");
const { queueHolds } = await import("./data/queue-holds.ts");
const { settings } = await import("./data/settings.ts");
const { createApp } = await import("./app.ts");
const { taskChecks } = await import("./landing/checks.ts");
const { findOverlaps, missionOverview } = await import("./mission/overview.ts");
const { checkout, forTools, grantFor, prepareTask } = await import("./projects/checkout.ts");
const { intake } = await import("./projects/intake.ts");
const { projects } = await import("./projects/projects.ts");
const { projectSection } = await import("./projects/prompt.ts");
const { taskStore } = await import("./tasks/store.ts");
const { tasks } = await import("./tasks/tasks.ts");
type TaskRecord = import("./tasks/store.ts").TaskRecord;

const legacy = projects.get("p-legacy")!;
check(
  "a migrated project lists its repo, and mirrors it",
  legacy.repos?.length === 1 && legacy.repos[0]!.primary && legacy.repos[0]!.folderGranted && legacy.kind === "folder" && legacy.folderGranted,
  JSON.stringify(legacy.repos),
);
check("…an old folder project not allowed yet stays not allowed", projects.get("p-notes")!.repos?.[0]?.folderGranted === false);

settings.patch({ computer: { mode: "local" } });
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

const mascot = { shape: "blob" as const, color: "#60a5fa", accessory: "none" as const, eyes: "dots" as const };
const tot = agents.create({ name: "Tot", mascot });
// Tasks are created here and set up by hand (prepareTask, as the run loop does); none starts by itself.
queueHolds.set(tot.id, null, "test");
const pc = await computerManager.ensure(tot.id);
const workspace = realpathSync(pc.backend.home(pc.externalId));
/** A path on the agent's computer ("~/projects/…" or a folder on this Mac) as a path here. */
const local = (path: string) => (path.startsWith("~/") ? join(workspace, path.slice(2)) : path);

// github.com/acme/api is a bare repo in the computer's home, and git is told to fetch that URL there.
function fakeGitHub(fullName: string, files: Record<string, string>): string {
  const name = fullName.split("/")[1]!;
  const seedRepo = join(OUTSIDE, `${name}-seed`);
  makeRepo(seedRepo, files);
  const bare = join(workspace, `remotes/${name}.git`);
  execFileSync("git", ["clone", "-q", "--bare", seedRepo, bare], { env: GIT_ENV });
  execFileSync("git", ["config", "--file", join(workspace, ".gitconfig"), `url.${bare}.insteadOf`, `https://github.com/${fullName}.git`], { env: GIT_ENV });
  return bare;
}

// =============================================================================
// Adding, naming and listing repos
// =============================================================================
console.log("\n# Repos of a project");
const shop = join(HOME, "code/shop");
const admin = join(HOME, "code/admin");
const docs = join(HOME, "code/docs");
makeRepo(shop, { "README.md": "shop\n", "a.txt": "one\n" });
makeRepo(admin, { "README.md": "admin\n", "x.txt": "secret admin notes\n" });
makeRepo(docs, { "d.txt": "docs\n" });
fakeGitHub("acme/api", { "README.md": "api\n" });

let res: { status: number; data: any } = await call<Project>("POST", "/projects", { kind: "folder", source: shop, grant: true });
let project: Project = res.data;
const id = project.id;
check(
  "a new project's folder is its primary repo",
  res.status === 201 && project.repos?.length === 1 && project.repos[0]!.name === "shop" && project.repos[0]!.primary && project.repos[0]!.kind === "folder" && project.repos[0]!.folderGranted,
  JSON.stringify(project.repos),
);

res = await call<Project>("POST", `/projects/${id}/repos`, { kind: "github", source: "https://github.com/acme/api.git" });
project = res.data;
const api = projectRepos.get(id, "api")!;
check(
  "POST …/repos adds a GitHub repo, named after it, cloned next to the project's: ~/projects/<slug>.<name>",
  res.status === 201 && project.repos?.map((r) => r.name).join() === "shop,api" && api.source === "acme/api" && api.checkout === `~/projects/${project.slug}.api` && api.folderGranted,
  JSON.stringify(res.data),
);
check("…and the project still mirrors its primary", project.kind === "folder" && project.source === shop && project.folderGranted);
res = await call<Project>("POST", `/projects/${id}/repos`, { kind: "folder", source: "~/code/admin", grant: true });
check("a folder on this Mac, with the user's OK given in the consent dialog", res.status === 201 && res.data.repos?.find((r: any) => r.name === "admin")?.folderGranted === true, JSON.stringify(res.data));
res = await call<Project>("POST", `/projects/${id}/repos`, { kind: "folder", source: docs });
check("a folder without the OK yet", res.status === 201 && res.data.repos?.find((r: any) => r.name === "docs")?.folderGranted === false, JSON.stringify(res.data));
res = await call("POST", `/projects/${id}/repos`, { kind: "github", source: "acme/api" });
check("the same repo twice is refused", res.status === 409 && res.data.error.includes("“api”"), JSON.stringify(res.data));
res = await call("POST", `/projects/${id}/repos`, { kind: "github", source: "acme/web", name: "Admin" });
check("a name the project has already is refused (case aside)", res.status === 409, JSON.stringify(res.data));
res = await call("POST", `/projects/${id}/repos`, { kind: "github", source: "acme/web", name: "../web" });
check("a name that isn't one is refused", res.status === 400, JSON.stringify(res.data));
mkdirSync(join(HOME, ".ssh"));
res = await call("POST", `/projects/${id}/repos`, { kind: "folder", source: join(HOME, ".ssh") });
check("a folder that can't be shared is refused, as for projects", res.status === 400 && res.data.error.includes("Hidden folders"), JSON.stringify(res.data));
res = await call("POST", `/projects/${id}/repos`, { kind: "zip", source: "x" });
check("an unknown kind is a 400", res.status === 400);
res = await call<Project[]>("GET", "/projects");
check("GET /api/projects lists each project's repos, the primary first", res.data.find((p: Project) => p.id === id)?.repos?.map((r: any) => r.name).join() === "shop,api,admin,docs");

res = await call("POST", `/projects/${id}/repos/docs/grant`);
check("POST …/repos/:name/grant: the consent dialog's yes for one folder", res.status === 200 && res.data.repos.find((r: any) => r.name === "docs").folderGranted === true, JSON.stringify(res.data));
res = await call("POST", `/projects/${id}/repos/api/grant`);
check("…a GitHub repo needs no OK", res.status === 400);
// docs back to not allowed, for the grant checks below.
db.prepare(`UPDATE project_repos SET folder_granted_at = NULL WHERE project_id = ? AND name = 'docs'`).run(id);
res = await call("PATCH", `/projects/${id}/repos/api`, { defaultBranch: "release" });
check("PATCH sets a repo's base branch", res.status === 200 && res.data.repos.find((r: any) => r.name === "api").defaultBranch === "release");
const planned = tasks.create({ agentId: tot.id, projectId: id, goal: "Plan only", repo: "api" });
check("…where its tasks start", planned.task.repo?.baseBranch === "release" && planned.task.repo.repoName === "api", JSON.stringify(planned.task.repo));
await tasks.remove(planned.id);
await call("PATCH", `/projects/${id}/repos/api`, { defaultBranch: null });

// =============================================================================
// A task per repo, its worktree in that repo
// =============================================================================
console.log("\n# Tasks in a repo");
if (!localSandboxed) {
  console.log("SKIP  the rest needs the macOS sandbox for folders on this Mac; not here");
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}
const chat = conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Shop", projectId: id });
/** A task in the chat, in `repo`, set up as the run loop would. */
async function taskIn(goal: string, repo?: string): Promise<TaskRecord> {
  const created = tasks.create({ agentId: tot.id, parentId: chat.id, goal, repo });
  const prepared = await prepareTask(taskStore.get(created.id)!);
  return taskStore.patch(created.id, { repo: prepared })!;
}
/** Work done in its worktree (as its agent would), and the task finished "done", its checks settled. */
async function finish(task: TaskRecord, files: Record<string, string>): Promise<TaskRecord> {
  const wt = local(task.task.repo!.worktree);
  commit(wt, files, task.title);
  taskStore.patch(task.id, { repo: { ...task.task.repo!, headSha: git(wt, "rev-parse", "HEAD") } });
  taskStore.transition(task.id, "running");
  tasks.finish(task.id, "done", `Did it: ${task.title}.`);
  await until(() => taskStore.get(task.id)?.task.checks != null && !taskChecks.isRunning(task.id));
  return taskStore.get(task.id)!;
}

const inShop = await taskIn("Tidy the shop");
check(
  "a task with no repo works in the primary",
  inShop.task.repo?.repoName === "shop" && inShop.task.repo.folder === shop && inShop.task.repo.worktree.startsWith(`${shop}/.tot-worktrees/tot-`) && existsSync(inShop.task.repo.worktree),
  JSON.stringify(inShop.task.repo),
);
const inAdmin = await taskIn("Fix the admin login", "admin");
check(
  "a task in another folder repo gets its worktree in that folder, its branch in that repo",
  inAdmin.task.repo?.repoName === "admin" &&
    inAdmin.task.repo.folder === admin &&
    inAdmin.task.repo.worktree.startsWith(`${admin}/.tot-worktrees/tot-`) &&
    existsSync(inAdmin.task.repo.worktree) &&
    git(admin, "branch", "--list", inAdmin.task.repo.branch).includes(inAdmin.task.repo.branch) &&
    !git(shop, "branch", "--list", inAdmin.task.repo.branch),
  JSON.stringify(inAdmin.task.repo),
);
const inApi = await taskIn("Add an endpoint", "acme/api");
check(
  "a task in a GitHub repo (named by what it is) is cloned at ~/projects/<slug>.<name> and works there",
  inApi.task.repo?.repoName === "api" &&
    inApi.task.repo.folder === `~/projects/${project.slug}.api` &&
    existsSync(join(local(inApi.task.repo.folder), ".git")) &&
    existsSync(local(inApi.task.repo.worktree)) &&
    readFileSync(join(local(inApi.task.repo.worktree), "README.md"), "utf8") === "api\n",
  JSON.stringify(inApi.task.repo),
);
const inApi2 = tasks.create({ agentId: tot.id, parentId: chat.id, goal: "Add another endpoint", repo: "API" });
check("…a repo's name is matched whatever its case", inApi2.task.repo?.repoName === "api", JSON.stringify(inApi2.task.repo));
let error = threw(() => tasks.create({ agentId: tot.id, parentId: chat.id, goal: "Somewhere else", repo: "billing" }));
check("an unknown repo in a project with several is refused, with their names", error === `There's no repo called “billing” in ${project.name}. Its repos: shop, api, admin, docs.`, error);
error = threw(() => tasks.create({ agentId: tot.id, parentId: chat.id, goal: "Write the docs", repo: "docs" }));
check("a folder repo not allowed yet can't take tasks", error.includes("Agents can't use ~/code/docs yet"), error);
res = await call<Conversation>("POST", `/conversations/${chat.id}/tasks`, { goal: "Polish the admin", repo: "admin", requestId: "composer-1" });
check("the composer's Task mode names the repo (POST …/tasks with repo)", res.status === 201 && res.data.task?.repo?.repoName === "admin", JSON.stringify(res.data.task?.repo));
await tasks.remove(res.data.id);
res = await call<Conversation>("POST", "/tasks", { agentId: tot.id, projectId: id, goal: "From the project page", repo: "api" });
check("…so does a project page's (POST /api/tasks)", res.status === 201 && res.data.task?.repo?.repoName === "api", JSON.stringify(res.data.task?.repo));
await tasks.remove(res.data.id);

// A one-repo project keeps working as before 11: a repo that isn't its own is ignored.
const solo = projects.create({ kind: "folder", source: admin, grant: true });
const soloTask = tasks.create({ agentId: tot.id, projectId: solo.id, goal: "Anything", repo: "acme/whatever" });
check("in a project with one repo, a task's repo is always that one", soloTask.task.repo?.folder === admin && soloTask.task.repo.repoName === "admin", JSON.stringify(soloTask.task.repo));
await tasks.remove(soloTask.id);

// =============================================================================
// Folder grants per repo, in the real sandbox
// =============================================================================
console.log("\n# Folder grants");
const run = async (command: string, grant: any, cwd?: string) => pc.backend.exec(pc.externalId, command, { grant, cwd, timeoutMs: 30_000 });
const chatGrant = grantFor(conversations.get(chat.id)!);
check(
  "a chat reads the primary folder, and the project's other allowed folders (never one not allowed)",
  chatGrant?.folder === shop && JSON.stringify(chatGrant.reads) === JSON.stringify([admin]) && !chatGrant.task,
  JSON.stringify(chatGrant),
);
let out = await run(`cat ${shop}/a.txt && cat ${admin}/x.txt`, chatGrant);
check("…both readable in a chat's command", out.exitCode === 0 && out.stdout.includes("one") && out.stdout.includes("secret admin notes"), out.stderr);
out = await run(`cat ${docs}/d.txt`, chatGrant);
check("…a folder not allowed isn't", out.exitCode !== 0);
out = await run(`echo changed > ${admin}/x.txt`, chatGrant);
check("…and nothing in them is writable from a chat", out.exitCode !== 0 && readFileSync(join(admin, "x.txt"), "utf8") === "secret admin notes\n");
const tools = await forTools(conversations.get(chat.id)!, pc);
check("the chat's computer tools get that grant, and its GitHub repo is cloned for it", tools.grant?.folder === shop && existsSync(join(local(api.checkout!), ".git")), JSON.stringify(tools));

const adminGrant = grantFor(taskStore.get(inAdmin.id)!);
check(
  "a task in a folder repo gets that folder with its own branch and worktree, the others to read",
  adminGrant?.folder === admin && adminGrant.task?.branch === inAdmin.task.repo!.branch && JSON.stringify(adminGrant.reads) === JSON.stringify([shop]),
  JSON.stringify(adminGrant),
);
out = await run(`echo new > new.txt && cat ${shop}/a.txt`, adminGrant, inAdmin.task.repo!.worktree);
check("…it writes its worktree, and reads the primary", out.exitCode === 0 && existsSync(join(inAdmin.task.repo!.worktree, "new.txt")), out.stderr);
out = await run(`echo changed > ${shop}/a.txt`, adminGrant);
check("…but can't write another repo's folder", out.exitCode !== 0 && readFileSync(join(shop, "a.txt"), "utf8") === "one\n");
out = await run(`echo changed > ${admin}/x.txt`, adminGrant);
check("…nor its own folder's checked-out files", out.exitCode !== 0 && readFileSync(join(admin, "x.txt"), "utf8") === "secret admin notes\n");
rmSync(join(inAdmin.task.repo!.worktree, "new.txt"));
check("a task in a GitHub repo gets no folder grant (its clone is on its computer)", grantFor(taskStore.get(inApi.id)!) === null);
const elsewhere = projects.create({ kind: "none", name: "Elsewhere" });
const otherChat = conversations.create({ agentId: tot.id, modelId: tot.modelId, title: "Other", projectId: elsewhere.id });
check("a chat in another project gets nothing", grantFor(otherChat) === null);
out = await run(`cat ${admin}/x.txt`, null);
check("…and can't read the folders", out.exitCode !== 0);

// =============================================================================
// Overlaps per repo
// =============================================================================
console.log("\n# Overlaps");
const stats = (paths: string[]) => ({ files: paths.length, added: 1, removed: 0, paths, headSha: "abc", at: Date.now() });
taskStore.patch(inShop.id, { stats: stats(["README.md", "a.txt"]) });
taskStore.patch(inAdmin.id, { stats: stats(["README.md"]) });
const inAdminToo = await taskIn("Restyle the admin", "admin");
taskStore.patch(inAdminToo.id, { stats: stats(["README.md"]) });
const overlaps = findOverlaps([inShop.id, inAdmin.id, inAdminToo.id].map((taskId) => taskStore.get(taskId)!));
check(
  "two tasks in one repo changing the same file overlap; the same path in another repo doesn't",
  !overlaps.has(inShop.id) && overlaps.get(inAdmin.id)?.[0]?.taskId === inAdminToo.id && overlaps.get(inAdminToo.id)?.[0]?.taskId === inAdmin.id,
  JSON.stringify([...overlaps]),
);
const board = missionOverview({ projectId: id });
check("…on the project's board too", board.tasks.find((t) => t.conversation.id === inShop.id)?.overlaps.length === 0 && board.tasks.find((t) => t.conversation.id === inAdmin.id)?.overlaps.length === 1);

// =============================================================================
// Landing into the right folder
// =============================================================================
console.log("\n# Landing");
const adminDone = await finish(taskStore.get(inAdmin.id)!, { "login.txt": "fixed\n" });
let opts: TaskLandOptions = (await call("GET", `/tasks/${adminDone.id}/land`)).data;
check("a done task in a folder repo can merge into that folder's main", opts.merge.available && opts.merge.target === "main", JSON.stringify(opts));
const shopMain = git(shop, "rev-parse", "main");
res = await call<Conversation>("POST", `/tasks/${adminDone.id}/land`, { method: "merge" });
check(
  "…Merge lands it in that folder, not the primary's",
  res.status === 200 &&
    res.data.task?.landing?.kind === "merged" &&
    existsSync(join(admin, "login.txt")) &&
    git(admin, "log", "-1", "--format=%s").startsWith(`Merge ${adminDone.task.repo!.branch}`) &&
    git(shop, "rev-parse", "main") === shopMain &&
    !existsSync(join(shop, "login.txt")),
  JSON.stringify(res.data.task?.landing ?? res.data),
);
const apiDone = await finish(taskStore.get(inApi.id)!, { "endpoint.txt": "GET /x\n" });
opts = (await call("GET", `/tasks/${apiDone.id}/land`)).data;
check(
  "a done task in a GitHub repo lands as a draft PR on that repo, never by merging into the project's folder",
  !opts.merge.available && opts.merge.reason === "Merging is for folders on this Mac. Open a draft PR instead." && opts.pr.reason !== "Draft PRs are for GitHub projects.",
  JSON.stringify(opts),
);

// =============================================================================
// Renaming, the primary, removing
// =============================================================================
console.log("\n# Rename, primary, remove");
res = await call<Project>("PATCH", `/projects/${id}/repos/admin`, { name: "backoffice" });
check(
  "rename: the repo's name changes, its folder doesn't",
  res.status === 200 && res.data.repos.map((r: any) => r.name).join() === "shop,api,backoffice,docs" && res.data.repos.find((r: any) => r.name === "backoffice").source === admin,
  JSON.stringify(res.data.repos),
);
check(
  "…its tasks follow the new name, and still find their repo",
  taskStore.get(inAdminToo.id)?.task.repo?.repoName === "backoffice" && projectRepos.forTask(taskStore.get(inAdminToo.id)!)?.name === "backoffice" && taskStore.get(inShop.id)?.task.repo?.repoName === "shop",
  JSON.stringify(taskStore.get(inAdminToo.id)?.task.repo),
);
res = await call("PATCH", `/projects/${id}/repos/backoffice`, { name: "API" });
check("…a name another repo has is refused", res.status === 409, JSON.stringify(res.data));
res = await call("PATCH", `/projects/${id}/repos/backoffice`, { name: "Backoffice" });
check("…its own name in other letters is fine", res.status === 200 && res.data.repos.some((r: any) => r.name === "Backoffice"), JSON.stringify(res.data));

res = await call<Project>("PATCH", `/projects/${id}/repos/api`, { primary: true });
project = res.data;
check(
  "primary: true makes it the primary: first in the list, and the project mirrors it",
  res.status === 200 && project.repos?.[0]?.name === "api" && project.repos[0].primary && !project.repos[1]!.primary && project.kind === "github" && project.source === "acme/api",
  JSON.stringify(project),
);
check(
  "…each keeps its checkout: the old primary's folder, the new one's clone",
  projects.folder(project) === `~/projects/${project.slug}.api` && projectRepos.folder(projectRepos.get(id, "shop")!) === shop,
);
const defaultTask = tasks.create({ agentId: tot.id, parentId: chat.id, goal: "Default repo now" });
check("…and new tasks start in it", defaultTask.task.repo?.repoName === "api", JSON.stringify(defaultTask.task.repo));
await tasks.remove(defaultTask.id);
await tasks.remove(inApi2.id);
await call("PATCH", `/projects/${id}/repos/shop`, { primary: true });
check("making the folder primary again: the project is a folder project again", projects.get(id)?.kind === "folder" && projects.get(id)?.source === shop && projects.get(id)?.folderGranted === true);

res = await call("DELETE", `/projects/${id}/repos/Backoffice`);
check("removing a repo a task still has work in is refused", res.status === 409 && res.data.error.includes("“Restyle the admin”") && res.data.error.includes("Land or discard"), JSON.stringify(res.data));
await call("POST", `/tasks/${inAdminToo.id}/discard`);
res = await call<Project>("DELETE", `/projects/${id}/repos/Backoffice`);
check(
  "…once it's landed or discarded, it goes: its folder stays as it is, and its grant goes",
  res.status === 200 && !res.data.repos.some((r: any) => r.name === "Backoffice") && existsSync(join(admin, "login.txt")) && !grantFor(conversations.get(chat.id)!)?.reads?.includes(admin),
  JSON.stringify(res.data.repos),
);
res = await call("DELETE", `/projects/${id}/repos/api`);
check("a GitHub repo with a task's unlanded worktree can't go either", res.status === 409, JSON.stringify(res.data));
await call("POST", `/tasks/${apiDone.id}/discard`);
const shopTaskBranch = inShop.task.repo!.branch;
await call("POST", `/tasks/${inShop.id}/discard`);
res = await call<Project>("DELETE", `/projects/${id}/repos/shop`);
project = res.data;
check(
  "removing the primary: the next repo becomes the primary, and the project mirrors it",
  res.status === 200 && project.repos?.map((r) => r.name).join() === "api,docs" && project.repos[0]!.primary && project.kind === "github" && project.source === "acme/api" && existsSync(join(shop, "README.md")),
  JSON.stringify(project),
);
check("…its clone stays where it is", existsSync(join(local(api.checkout!), ".git")) && !git(shop, "branch", "--list", shopTaskBranch));
await call("DELETE", `/projects/${id}/repos/api`);
res = await call<Project>("DELETE", `/projects/${id}/repos/docs`);
check("the last repo gone, the project has no files", res.status === 200 && res.data.repos.length === 0 && res.data.kind === "none" && res.data.source === null, JSON.stringify(res.data));
res = await call<Project>("POST", `/projects/${id}/repos`, { kind: "github", source: "acme/api" });
check(
  "a topic project's first repo becomes its primary, in a folder of its own next to the topic's",
  res.status === 201 && res.data.kind === "github" && res.data.repos[0].primary && projects.folder(res.data) === `~/projects/${project.slug}.api`,
  JSON.stringify(res.data),
);
res = await call("DELETE", `/projects/${id}/repos/nope`);
check("an unknown repo is a 404", res.status === 404);

// A removed repo's clone folder, taken by another repo added under its name later: refused, never used.
const other = join(workspace, `projects/${project.slug}.lib`);
makeRepo(other, { "x.txt": "a different repo\n" });
git(other, "remote", "add", "origin", "https://github.com/acme/somethingelse.git");
fakeGitHub("acme/lib", { "lib.txt": "lib\n" });
await call("POST", `/projects/${id}/repos`, { kind: "github", source: "acme/lib" });
checkout.reset();
error = await checkout.ensure(tot.id, projects.get(id)!, projectRepos.get(id, "lib")).then(
  () => "",
  (err: Error) => err.message,
);
check("a clone folder that holds another repo is refused, not used", error.includes("holds a clone of another repo"), error);

// =============================================================================
// What agents are told, and intake
// =============================================================================
console.log("\n# Prompt and intake");
await call("POST", `/projects/${id}/repos`, { kind: "folder", source: shop, grant: true, name: "storefront" });
const section = projectSection(projects.get(id)!);
check(
  "a chat in a project with several repos is told each one, and to split work one task per repo",
  section.includes("Repos (each task works in one; task_start's `repo` takes its name, the primary when left out):") &&
    section.includes(`- api (primary): GitHub acme/api · base branch is the repo's default · files at ~/projects/${project.slug}.api`) &&
    section.includes(`- storefront: folder on the user's Mac · base branch is the repo's default · files at ${shop}`) &&
    section.includes("one task per repo"),
  section,
);
const single = projectSection(projects.get(legacy.id)!);
check("a project with one repo reads as before", single.includes(`Folder on the user's Mac, ~/code/legacy`) && !single.includes("Repos ("), single);
check(
  "an issue of any of the project's GitHub repos is its intake",
  intake.match({ ticket: { kind: "github", key: "acme/lib#3", url: "https://github.com/acme/lib/issues/3", label: "acme/lib#3" } }).some((p) => p.id === id),
);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
