import type { Project, ProjectRepo } from "@tot/shared/types";
import { quote } from "../../computer/github-login.ts";
import { computerManager } from "../../computer/manager.ts";
import { agents } from "../../data/agents.ts";
import { conversations } from "../../data/conversations.ts";
import { db, type Row } from "../../db.ts";
import { folderGit } from "../../landing/git.ts";
import { checkout } from "../../projects/checkout.ts";
import { resolveFolder } from "../../projects/folders.ts";
import { projects } from "../../projects/projects.ts";
import { projectRepos as repoRecords } from "../../projects/repos.ts";
import { homeRelative } from "../../tasks/worktree.ts";
import { scrub } from "../../trust/secrets.ts";
import type { UpdateJob } from "./jobs.ts";
import { repoHeads } from "./log.ts";
import { movedMaterial, parseNumstat } from "./material.ts";
import { projectRepos, repoOfTask } from "./repos.ts";

/**
 * Module 11, lane C: noticing when a project repo's base branch moves. A GitHub repo is fetched in its clone on
 * an agent's computer (a local one, or one already running; the timer never clones a repo or starts a cloud
 * computer, Check now may); a folder repo on this Mac is read where it is, never fetched. The head is kept per repo: the first look records it, and a
 * later new head gives an update over the commits between (their log and diff stat, capped). Commits that came
 * from TOT's own landed tasks are left out of that: their on-land updates covered them.
 */

const GIT_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 5 * 60_000;
const MAX_COMMITS = 50;
/** Landed tasks this recent are left out of a range. */
const LANDED_WINDOW_MS = 14 * 24 * 60 * 60_000;

type Git = (args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Agents whose computer may read a GitHub repo, the likeliest first: the project's Lead, then whoever worked in
 * it most recently. Only local computers, or ones already running: a cloud computer isn't started for this.
 * Check now (`manual`) may also use any agent, and start its computer.
 */
function agentsFor(project: Project, manual: boolean): string[] {
  const ids: string[] = [];
  const lead = project.leadChatId ? conversations.get(project.leadChatId)?.agentId : null;
  if (lead) ids.push(lead);
  for (const row of db.prepare(`SELECT agent_id FROM conversations WHERE project_id = ? ORDER BY updated_at DESC LIMIT 50`).all(project.id) as Row[]) {
    if (row.agent_id) ids.push(String(row.agent_id));
  }
  if (manual) for (const agent of agents.list()) ids.push(agent.id);
  return [...new Set(ids)].filter((id) => {
    if (!agents.get(id)) return false;
    const kind = computerManager.kindFor(id);
    return kind === "local" || computerManager.get(id)?.state === "running" || (manual && Boolean(kind));
  });
}

/** git in a folder on an agent's computer (read only, plus fetch). */
function computerGit(agentId: string, folder: string): Git {
  return async (args, timeoutMs = GIT_TIMEOUT_MS) => {
    const active = await computerManager.ensure(agentId);
    const result = await active.backend.exec(active.externalId, `git ${args.map(quote).join(" ")}`, { cwd: homeRelative(folder), timeoutMs });
    computerManager.touch(agentId);
    return { code: result.exitCode, stdout: result.stdout, stderr: scrub(result.stderr) };
  };
}

const words = (text: string) => scrub(text).trim().split("\n").filter(Boolean).slice(-2).join(" · ").slice(0, 300);

/**
 * Where a GitHub repo's clone is on an agent's computer: the place lane A fixed when the repo was added
 * (~/projects/<slug> for the project's first repo, ~/projects/<slug>.<name> for the others), so a rename or a new
 * primary never looks in the wrong folder.
 */
const cloneFolder = (project: Project, repo: ProjectRepo) => {
  const record = repoRecords.get(project.id, repo.name);
  return (record && repoRecords.folder(record)) || (repo.primary ? `~/projects/${project.slug}` : `~/projects/${project.slug}.${repo.name}`);
};

async function hasClone(agentId: string, folder: string): Promise<boolean> {
  const active = await computerManager.ensure(agentId);
  return (await active.backend.exec(active.externalId, `test -e ${quote(`${homeRelative(folder)}/.git`)}`, { timeoutMs: GIT_TIMEOUT_MS })).exitCode === 0;
}

/** Clones a repo that isn't on the computer yet (Check now only; the timer never clones), as tasks would. */
async function cloneOnComputer(agentId: string, project: Project, repo: ProjectRepo): Promise<void> {
  const record = repoRecords.get(project.id, repo.name);
  if (!record) throw new Error(`${repo.name} isn't in ${project.name} any more.`);
  await checkout.ensure(agentId, project, record);
}

/** Where to read a repo's base branch, fetched first for a clone; null when it can't be read now. */
async function locate(project: Project, repo: ProjectRepo, manual: boolean): Promise<{ git: Git; branch: string; ref: string } | null> {
  const configured = repo.defaultBranch ?? (repo.primary ? project.defaultBranch : null);
  if (repo.kind === "folder") {
    if (!repo.folderGranted) return null;
    try {
      if (resolveFolder(repo.source) !== repo.source) return null;
    } catch {
      return null;
    }
    const git: Git = (args, timeoutMs) => folderGit(repo.source, args, { timeoutMs });
    let branch = configured;
    if (!branch) {
      const current = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
      if (current && !current.startsWith("tot/")) branch = current;
      else if ((await git(["rev-parse", "--verify", "--quiet", "refs/heads/main"])).code === 0) branch = "main";
      else if ((await git(["rev-parse", "--verify", "--quiet", "refs/heads/master"])).code === 0) branch = "master";
    }
    return branch ? { git, branch, ref: `refs/heads/${branch}` } : null;
  }
  // The first computer that has a clone already; only Check now makes one when none has.
  const folder = cloneFolder(project, repo);
  const candidates = agentsFor(project, manual);
  let agentId: string | null = null;
  for (const id of candidates) {
    if (await hasClone(id, folder).catch(() => false)) {
      agentId = id;
      break;
    }
  }
  if (!agentId) {
    if (!manual || !candidates[0]) return null;
    agentId = candidates[0];
    await cloneOnComputer(agentId, project, repo);
  }
  const git = computerGit(agentId, folder);
  const fetched = await git(["fetch", "--quiet", "origin"], FETCH_TIMEOUT_MS);
  if (fetched.code !== 0) throw new Error(`Couldn't fetch ${repo.name}: ${words(fetched.stderr)}`);
  const branch = configured ?? ((await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).stdout.trim().replace(/^origin\//, "") || "main");
  return { git, branch, ref: `refs/remotes/origin/${branch}` };
}

/**
 * Tips of TOT's own recently landed tasks in this repo, to leave out of a range: a merged task's branch (its merge
 * commit's second parent), or the head a draft PR pushed. Only those the repo has.
 */
async function landedTips(project: Project, repo: ProjectRepo, git: Git): Promise<string[]> {
  const since = Date.now() - LANDED_WINDOW_MS;
  const tips: string[] = [];
  for (const task of conversations.tasks()) {
    const landing = task.task?.landing;
    if (task.projectId !== project.id || !landing?.sha || landing.at < since || (landing.kind !== "merged" && landing.kind !== "pr")) continue;
    if (repoOfTask(project, task.task!.repo)?.name !== repo.name) continue;
    const tip = landing.kind === "merged" ? `${landing.sha}^2` : landing.sha;
    const found = (await git(["rev-parse", "--verify", "--quiet", `${tip}^{commit}`])).stdout.trim();
    if (found) tips.push(found);
    if (tips.length >= 30) break;
  }
  return tips;
}

/**
 * Checks one repo now. Returns the update to run when its base branch moved, else null (unchanged, its first
 * look, only TOT's own landed tasks, or it can't be read now). Throws when git fails (a fetch, a clone).
 */
export async function checkRepo(project: Project, repo: ProjectRepo, { manual = false } = {}): Promise<UpdateJob | null> {
  const where = await locate(project, repo, manual);
  if (!where) return null;
  const { git, branch } = where;
  const sha = (await git(["rev-parse", "--verify", "--quiet", `${where.ref}^{commit}`])).stdout.trim();
  if (!sha) return null;
  const last = repoHeads.get(project.id, repo.name);
  // The first look (or another branch now): where it is becomes the baseline.
  if (!last || last.branch !== branch) {
    repoHeads.set(project.id, repo.name, branch, sha);
    return null;
  }
  if (last.sha === sha) {
    repoHeads.touch(project.id, repo.name);
    return null;
  }
  const ancestor = (await git(["merge-base", "--is-ancestor", last.sha, sha])).code === 0;
  let log: string;
  let files: ReturnType<typeof parseNumstat> = [];
  if (ancestor) {
    const tips = await landedTips(project, repo, git);
    const not = tips.length ? ["--not", ...tips] : [];
    const range = `${last.sha}..${sha}`;
    const count = Number((await git(["rev-list", "--count", "--no-merges", range, ...not])).stdout.trim()) || 0;
    repoHeads.set(project.id, repo.name, branch, sha);
    if (!count) return null;
    log = (await git(["log", "--no-merges", "--format=%h %s", `-n${MAX_COMMITS}`, range, ...not])).stdout;
    files = parseNumstat((await git(["-c", "core.quotePath=false", "diff", "--numstat", "--no-renames", last.sha, sha])).stdout);
  } else {
    // Rewritten (a force push), or the old head is gone: its newest commits, for what they say.
    repoHeads.set(project.id, repo.name, branch, sha);
    log = (await git(["log", "--no-merges", "--format=%h %s", "-n20", sha])).stdout;
  }
  const material = movedMaterial(repo.name, branch, last.sha, sha, log, files, !ancestor);
  const short = sha.slice(0, 7);
  return {
    key: `moved:${project.id}:${repo.name}:${sha}`,
    projectId: project.id,
    trigger: manual ? "manual" : "base-moved",
    repoName: repo.name,
    taskId: null,
    after: `${repo.name} moved to ${short}`,
    subject: `Knowledge: ${repo.name} moved to ${short}`,
    factSource: "tot",
    material: async () => material,
  };
}

/** How often each repo is checked. */
export const CHECK_EVERY_MS = 6 * 60 * 60_000;
const tried = new Map<string, number>();

/**
 * Checks a project's repos (all of them for Check now; on the timer, those not checked in 6 hours), one after
 * another. A repo that can't be checked is told about on the console and doesn't stop the others.
 */
export async function checkProject(project: Project, { manual = false, now = Date.now() } = {}): Promise<{ checked: number; jobs: UpdateJob[]; errors: string[] }> {
  const jobs: UpdateJob[] = [];
  const errors: string[] = [];
  let checked = 0;
  for (const repo of projectRepos(project)) {
    const key = `${project.id}:${repo.name}`;
    if (!manual) {
      const last = Math.max(repoHeads.get(project.id, repo.name)?.checkedAt ?? 0, tried.get(key) ?? 0);
      if (now - last < CHECK_EVERY_MS) continue;
    }
    tried.set(key, now);
    try {
      checked++;
      const job = await checkRepo(project, repo, { manual });
      if (job) jobs.push(job);
    } catch (err) {
      errors.push(`${repo.name}: ${errorText(err)}`);
      console.warn(`[tot] couldn't check ${project.name}/${repo.name} for new commits:`, errorText(err));
    }
  }
  return { checked, jobs, errors };
}

/** Every project's repos that are due (the 6-hour timer). */
export async function checkDue(): Promise<UpdateJob[]> {
  const jobs: UpdateJob[] = [];
  for (const project of projects.list()) jobs.push(...(await checkProject(project)).jobs);
  return jobs;
}
