import type { LeadSignal, LeadSignalKind, Project } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { conversations } from "../data/conversations.ts";
import { githubFullName } from "../data/brains.ts";
import { personas } from "../data/personas.ts";
import { db, parseJson, type Row } from "../db.ts";
import { github } from "../github.ts";
import { leadInbox } from "../lead/inbox.ts";
import { projects } from "../projects/projects.ts";
import { projectRepos } from "../projects/repos.ts";
import { isTask, taskStore, type TaskRecord } from "../tasks/store.ts";
import { cloneUrl } from "../tasks/worktree.ts";
import { scrub } from "../trust/secrets.ts";
import { GitHubReadError, RateLimited, readGitHub } from "./github.ts";

/**
 * Module 12 (docs/roadmap/12-coordinator.md), lane A: the pull-request watcher. Every 2 minutes while TOT runs (and
 * on Check now), for each project with a Lead and PR watching on, it reads the project's pull requests with the
 * GitHub connection, read only: the draft PRs TOT opened for its tasks ("tot"), or every open PR in its GitHub repos
 * too ("all"). New facts go to the Lead's inbox as signals: checks failing (with their names) or passing, changes
 * requested, reviews and comments (never by TOT's own persona accounts), merged, closed, conflicts.
 *
 * What it has seen of each PR is kept (lead_pr_seen: its head, the head's checks, the reviews and comments, whether it
 * conflicts), so a restart repeats nothing, and every signal has a key besides. A PR TOT didn't open is looked at once
 * first without a word (only what changes after is news); TOT's own are news from the start. Checks are read only
 * until they settle for a head, comments only when the PR changed; a merged TOT PR marks its task merged. GitHub's
 * rate limit, or GitHub out of reach, pauses the watcher (backing off); no connection, and it's quiet.
 */

const POLL_MS = 2 * 60_000;
const FIRST_POLL_MS = 20_000;
/** A head with no checks at all after this long has none. */
const NO_CHECKS_AFTER_MS = 10 * 60_000;
/** A failure is news this long after the head came, even while other checks still run. */
const FAIL_EARLY_AFTER_MS = 15 * 60_000;
/** Open PRs read per repo when watching all of them, the most recently updated first. */
const MAX_OPEN = 30;
/** Comment and review ids remembered per PR. */
const MAX_IDS = 400;
/** How far back a comment counts as new, from the last look (GitHub's clocks, and a look that took a while). */
const SINCE_MARGIN_MS = 30 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
/** A repo GitHub won't show is tried again after this long. */
const REPO_RETRY_MS = 60 * 60_000;

const FAILING = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// --- What GitHub answers (the fields used) ----------------------------------------------------------------------

interface User {
  login: string;
  type?: string;
}

interface Pull {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  closed_at?: string | null;
  updated_at?: string;
  mergeable?: boolean | null;
  mergeable_state?: string;
  head: { sha: string; ref?: string };
  base: { ref: string };
  user?: User | null;
  merged_by?: User | null;
}

interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

interface CommitStatus {
  context: string;
  state: string;
}

interface Review {
  id: number;
  user: User | null;
  state: string;
  body: string | null;
  html_url: string;
  submitted_at?: string | null;
}

interface Comment {
  id: number;
  user: User | null;
  body: string;
  html_url: string;
  created_at: string;
  path?: string;
  line?: number | null;
  pull_request_review_id?: number | null;
}

// --- What the watcher remembers of a PR --------------------------------------------------------------------------

type Outcome = "failed" | "passed" | "none";

interface Seen {
  head: string | null;
  /** When the watcher first saw this head (its checks get time to show up). */
  headAt: number;
  /** The head's checks, once they settled; null while they run (or before the first look). */
  checks: Outcome | null;
  /** The last settled outcome on any head: green after red is news on any PR. */
  lastChecks: Outcome | null;
  conflict: boolean;
  /** Merged, closed or gone: not watched any more. */
  done: boolean;
  closedAt: string | null;
  /** The PR's updated_at when its reviews and comments were last read. */
  updatedAt: string | null;
  /** When they were last read. */
  readAt: number;
  reviews: number[];
  comments: number[];
}

const NEW_SEEN: Seen = { head: null, headAt: 0, checks: null, lastChecks: null, conflict: false, done: false, closedAt: null, updatedAt: null, readAt: 0, reviews: [], comments: [] };

const seenStore = {
  get(projectId: string, repo: string, number: number): Seen | null {
    const row = db.prepare(`SELECT state FROM lead_pr_seen WHERE project_id = ? AND repo = ? AND number = ?`).get(projectId, repo, number) as Row | undefined;
    return row ? { ...NEW_SEEN, ...parseJson<Partial<Seen>>(row.state, {}) } : null;
  },

  set(projectId: string, repo: string, number: number, seen: Seen): void {
    const state = { ...seen, reviews: seen.reviews.slice(-MAX_IDS), comments: seen.comments.slice(-MAX_IDS) };
    db.prepare(
      `INSERT INTO lead_pr_seen (project_id, repo, number, state, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, repo, number) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
    ).run(projectId, repo, number, JSON.stringify(state), Date.now());
  },

  /** PRs of a repo still watched (seen open last time), for noticing when one closes. */
  open(projectId: string, repo: string): number[] {
    const rows = db.prepare(`SELECT number, state FROM lead_pr_seen WHERE project_id = ? AND repo = ?`).all(projectId, repo) as Row[];
    return rows.filter((row) => !parseJson<Partial<Seen>>(row.state, {}).done).map((row) => Number(row.number));
  },
};

// --- Helpers -------------------------------------------------------------------------------------------------------

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** A comment's first lines, secrets hidden. */
function firstLines(text: string | null | undefined, lines = 3, max = 500): string {
  const kept = (text ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const shown = kept.slice(0, lines).join("\n");
  return scrub(clip(kept.length > lines ? `${shown}\n…` : shown, max));
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "draft PR #12 “Fix cart”". */
const prLabel = (pr: Pull) => `${pr.draft ? "draft PR" : "PR"} #${pr.number} “${clip(pr.title.trim(), 80)}”`;

/** "acme/web" from a PR's link ("https://github.com/acme/web/pull/12"). */
function repoOfUrl(url: string | null | undefined): string | null {
  const match = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/\d+/i.exec(url ?? "");
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The project's GitHub repos: full name → the repo's name in the project. */
function githubRepos(project: Project): Map<string, string> {
  const repos = new Map<string, string>();
  const list = project.repos?.length ? project.repos : project.kind === "github" && project.source ? [{ name: project.slug, kind: "github" as const, source: project.source }] : [];
  for (const repo of list) {
    if (repo.kind !== "github") continue;
    const full = githubFullName(cloneUrl(repo.source) ?? "");
    if (full) repos.set(full.toLowerCase(), repo.name);
  }
  return repos;
}

/** The GitHub repo a task's draft PR is in: from its link, else the task's repo. */
function taskPullRepo(task: TaskRecord): string | null {
  const fromUrl = repoOfUrl(task.task.landing?.pr?.url);
  if (fromUrl) return fromUrl;
  const own = projectRepos.forTask(task);
  const source = own?.kind === "github" ? own.source : task.task.repo?.source;
  return source ? githubFullName(cloneUrl(source) ?? "") : null;
}

/** GitHub accounts that are TOT itself (personas' own): what they say isn't news to the Lead. */
function totLogins(): Set<string> {
  const logins = new Set<string>();
  for (const persona of personas.list()) {
    const login = personas.githubAccount(persona.id)?.login;
    if (login) logins.add(login.toLowerCase());
  }
  return logins;
}

/** Whether the checks on a head are settled: failed (which), passed, none at all, or still running (null). */
function verdict(runs: CheckRun[], statuses: CommitStatus[], headAge: number): { outcome: Outcome | null; failing: string[]; total: number } {
  const failing = [
    ...runs.filter((run) => run.status === "completed" && FAILING.has(run.conclusion ?? "")).map((run) => run.name),
    ...statuses.filter((status) => status.state === "failure" || status.state === "error").map((status) => status.context),
  ];
  const running = runs.some((run) => run.status !== "completed") || statuses.some((status) => status.state === "pending");
  const total = runs.length + statuses.length;
  if (failing.length && (!running || headAge >= FAIL_EARLY_AFTER_MS)) return { outcome: "failed", failing, total };
  if (running) return { outcome: null, failing, total };
  if (total) return { outcome: "passed", failing, total };
  return { outcome: headAge >= NO_CHECKS_AFTER_MS ? "none" : null, failing, total };
}

/** "build, test (ubuntu) and 3 more". */
function names(list: string[], max = 6): string {
  const unique = [...new Set(list)];
  const shown = unique.slice(0, max).join(", ");
  return unique.length > max ? `${shown} and ${unique.length - max} more` : shown;
}

// --- One PR ---------------------------------------------------------------------------------------------------------

interface Watched {
  repo: string;
  number: number;
  /** TOT's own draft PR: the task it landed. */
  task: TaskRecord | null;
}

interface Look {
  project: Project;
  token: string;
  logins: Set<string>;
  repos: Map<string, string>;
  posted: LeadSignal[];
}

/** One PR, looked at now: its new facts posted to the Lead, what was seen saved. */
async function lookAt(look: Look, watched: Watched): Promise<void> {
  const { project, token, logins } = look;
  const { repo, number, task } = watched;
  const before = seenStore.get(project.id, repo, number);
  if (before?.done) return;
  const seen: Seen = { ...(before ?? NEW_SEEN), reviews: [...(before?.reviews ?? [])], comments: [...(before?.comments ?? [])] };
  // A PR TOT didn't open is looked at once without a word: only what changes after is news.
  const quiet = !before && !task;
  const now = Date.now();

  let pr: Pull;
  try {
    pr = await readGitHub<Pull>(`/repos/${repo}/pulls/${number}`, token);
  } catch (err) {
    if (err instanceof GitHubReadError && (err.status === 404 || err.status === 410)) {
      seenStore.set(project.id, repo, number, { ...seen, done: true });
      return;
    }
    throw err;
  }

  const label = prLabel(pr);
  const post = (kind: LeadSignalKind, key: string, title: string, detail: string | null = null, url = pr.html_url) => {
    if (quiet) return;
    const signal = leadInbox.post(
      project.id,
      { kind, title: capitalized(title), detail, url, repoName: look.repos.get(repo.toLowerCase()) ?? repo, taskId: task?.id ?? null, prNumber: pr.number },
      { key: `pr:${repo.toLowerCase()}#${pr.number}:${key}` },
    );
    if (signal) look.posted.push(signal);
  };

  if (pr.merged || pr.merged_at) {
    const by = pr.merged_by?.login ? ` by @${pr.merged_by.login}` : "";
    post("pr-merged", "merged", `${label} was merged into ${pr.base.ref}${by}`);
    if (task) markMerged(task, pr);
    seenStore.set(project.id, repo, number, { ...seen, done: true });
    return;
  }
  if (pr.state === "closed") {
    post("pr-closed", `closed:${pr.closed_at ?? ""}`, `${label} was closed without merging`);
    seenStore.set(project.id, repo, number, { ...seen, closedAt: pr.closed_at ?? null, done: true });
    return;
  }

  // A new head: its checks start over.
  if (pr.head.sha !== seen.head) Object.assign(seen, { head: pr.head.sha, headAt: now, checks: null });

  // Checks, until they settle for this head.
  if (seen.checks === null) {
    const [runs, status] = await Promise.all([
      readGitHub<{ check_runs?: CheckRun[] }>(`/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`, token),
      readGitHub<{ statuses?: CommitStatus[] }>(`/repos/${repo}/commits/${pr.head.sha}/status`, token),
    ]);
    const { outcome, failing, total } = verdict(runs.check_runs ?? [], status.statuses ?? [], now - seen.headAt);
    if (outcome === "failed") {
      post("ci-failed", `ci-failed:${pr.head.sha}`, `Checks failed on ${label}`, `Failing: ${names(failing)} (${failing.length} of ${total} checks).`, `${pr.html_url}/checks`);
    } else if (outcome === "passed" && (task || seen.lastChecks === "failed")) {
      post("ci-passed", `ci-passed:${pr.head.sha}`, `Checks passed on ${label}`, `${total} check${total === 1 ? "" : "s"} passed.`, `${pr.html_url}/checks`);
    }
    if (outcome) Object.assign(seen, { checks: outcome, lastChecks: outcome === "none" ? seen.lastChecks : outcome });
  }

  // Conflicts with the base (GitHub works this out in the background: null until it has).
  const conflict = pr.mergeable_state === "dirty" || pr.mergeable === false ? true : pr.mergeable === true ? false : null;
  if (conflict && !seen.conflict) {
    post("pr-conflict", `conflict:${pr.head.sha}`, `${label} has conflicts with ${pr.base.ref}`, `Its branch needs updating from ${pr.base.ref} before it can merge.`);
  }
  if (conflict !== null) seen.conflict = conflict;

  // Reviews and comments, when the PR changed since they were last read.
  if (!before || pr.updated_at !== seen.updatedAt) {
    // TOT's own PR, first look: what came before TOT opened it isn't news. Later: what came since the last look.
    const since = before ? seen.readAt - SINCE_MARGIN_MS : task ? (task.task.landing?.at ?? now) - 60_000 : 0;
    const sinceIso = new Date(Math.max(since, 0)).toISOString();
    const [reviews, reviewComments, comments] = await Promise.all([
      readGitHub<Review[]>(`/repos/${repo}/pulls/${number}/reviews?per_page=100`, token),
      readGitHub<Comment[]>(`/repos/${repo}/pulls/${number}/comments?per_page=100&since=${encodeURIComponent(sinceIso)}`, token),
      readGitHub<Comment[]>(`/repos/${repo}/issues/${number}/comments?per_page=100&since=${encodeURIComponent(sinceIso)}`, token),
    ]);
    const fresh = (at: string | null | undefined) => !at || Date.parse(at) >= since;
    const ours = (user: User | null) => !user || logins.has(user.login.toLowerCase());
    const reviewIds = new Set(seen.reviews);
    const commentIds = new Set(seen.comments);
    // A review still being written (only its author sees it) is news once it's submitted, with its comments.
    const drafts = new Set(reviews.filter((review) => review.state === "PENDING").map((review) => review.id));
    const lineOf = (comment: Comment) => `${comment.path ?? "a file"}${comment.line ? `:${comment.line}` : ""}: ${firstLines(comment.body, 1, 200)}`;

    // A review, with its line comments.
    for (const review of reviews) {
      if (reviewIds.has(review.id) || drafts.has(review.id)) continue;
      reviewIds.add(review.id);
      if (ours(review.user) || !fresh(review.submitted_at)) continue;
      const lines = reviewComments.filter((comment) => comment.pull_request_review_id === review.id);
      const said = [firstLines(review.body, 4, 600), ...lines.slice(0, 5).map(lineOf), lines.length > 5 ? `…and ${lines.length - 5} more comments` : ""].filter(Boolean).join("\n");
      for (const comment of lines) commentIds.add(comment.id);
      const who = `@${review.user!.login}`;
      if (review.state === "CHANGES_REQUESTED") post("changes-requested", `review:${review.id}`, `${who} asked for changes on ${label}`, said || null, review.html_url);
      else if (review.state === "APPROVED") post("review-comment", `review:${review.id}`, `${who} approved ${label}`, said || null, review.html_url);
      else if (review.state === "COMMENTED" && said) post("review-comment", `review:${review.id}`, `${who} reviewed ${label}`, said, review.html_url);
    }
    // Line comments outside a new review (a reply in a thread).
    for (const comment of reviewComments) {
      if (commentIds.has(comment.id) || drafts.has(comment.pull_request_review_id ?? -1)) continue;
      commentIds.add(comment.id);
      if (ours(comment.user) || !fresh(comment.created_at)) continue;
      post("review-comment", `review-comment:${comment.id}`, `@${comment.user!.login} commented on ${comment.path ?? "the code"} in ${label}`, firstLines(comment.body), comment.html_url);
    }
    // The conversation (not bots: deploy previews and coverage reports aren't news).
    for (const comment of comments) {
      if (commentIds.has(comment.id)) continue;
      commentIds.add(comment.id);
      if (ours(comment.user) || comment.user?.type === "Bot" || !fresh(comment.created_at)) continue;
      post("comment", `comment:${comment.id}`, `@${comment.user!.login} commented on ${label}`, firstLines(comment.body), comment.html_url);
    }
    Object.assign(seen, { reviews: [...reviewIds], comments: [...commentIds], updatedAt: pr.updated_at ?? null, readAt: now });
  }
  seenStore.set(project.id, repo, number, seen);
}

/** A merged TOT PR: its task's landing says merged (if it doesn't), so the board and knowledge follow. */
function markMerged(task: TaskRecord, pr: Pull): void {
  const landing = taskStore.get(task.id)?.task.landing;
  if (landing?.kind !== "pr" || landing.pr?.number !== pr.number) return;
  taskStore.patch(task.id, { landing: { kind: "merged", at: Date.now(), target: pr.base.ref || landing.target, sha: pr.merge_commit_sha ?? landing.sha, pr: landing.pr } }, true);
}

// --- A project ------------------------------------------------------------------------------------------------------

/** Repos GitHub wouldn't show (no access, gone): repo → when to try again. */
const refusedRepos = new Map<string, number>();

/** The PRs to look at: TOT's own draft PRs (and, watching all, every open PR in the project's GitHub repos). */
async function watchedPulls(project: Project, look: Look): Promise<Watched[]> {
  const mode = project.subscriptions?.pullRequests ?? "tot";
  const found = new Map<string, Watched>();
  const add = (watched: Watched) => {
    const key = `${watched.repo.toLowerCase()}#${watched.number}`;
    if (!found.has(key) || watched.task) found.set(key, watched);
  };
  for (const conversation of conversations.inProject(project.id)) {
    if (!isTask(conversation)) continue;
    const landing = conversation.task.landing;
    if (landing?.kind !== "pr" || !landing.pr) continue;
    const repo = taskPullRepo(conversation);
    if (repo) add({ repo, number: landing.pr.number, task: conversation });
  }
  if (mode === "all") {
    for (const [full] of look.repos) {
      if ((refusedRepos.get(`${project.id} ${full}`) ?? 0) > Date.now()) continue;
      try {
        const open = await readGitHub<Pull[]>(`/repos/${full}/pulls?state=open&sort=updated&direction=desc&per_page=${MAX_OPEN}`, look.token);
        for (const pr of open) add({ repo: full, number: pr.number, task: null });
      } catch (err) {
        if (!(err instanceof GitHubReadError) || err.status === 0 || err.status >= 500 || err.status === 401) throw err;
        refusedRepos.set(`${project.id} ${full}`, Date.now() + REPO_RETRY_MS);
        console.warn(`[tot] couldn't read the pull requests of ${full} for ${project.name}:`, errorText(err));
        continue;
      }
      // Those open last time and not now: closed or merged since.
      for (const number of seenStore.open(project.id, full)) add({ repo: full, number, task: null });
    }
  }
  return [...found.values()];
}

/** Looks at one project's PRs now. Throws when GitHub's rate limit is used up, or GitHub is out of reach. */
async function lookAtProject(project: Project, token: string, logins: Set<string>): Promise<LeadSignal[]> {
  const look: Look = { project, token, logins, repos: githubRepos(project), posted: [] };
  for (const watched of await watchedPulls(project, look)) {
    try {
      await lookAt(look, watched);
    } catch (err) {
      if (err instanceof RateLimited || !(err instanceof GitHubReadError) || err.status === 0 || err.status >= 500 || err.status === 401) throw err;
      console.warn(`[tot] couldn't read ${watched.repo}#${watched.number} for ${project.name}:`, errorText(err));
    }
  }
  return look.posted;
}

/** The projects whose Lead hears about pull requests. */
function watchingProjects(): Project[] {
  return projects.list().filter((project) => (project.subscriptions?.pullRequests ?? "tot") !== "off" && conversations.leadOf(project.id) !== null);
}

// --- The timer, backing off, and Check now ----------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let first: NodeJS.Timeout | null = null;
/** The watcher waits until then: GitHub's rate limit, or backing off after errors. */
let pausedUntil = 0;
let pauseReason: "rate-limit" | "errors" | null = null;
let failures = 0;
/** Looks happen one at a time (the timer's and Check now's). */
let chain: Promise<unknown> = Promise.resolve();

function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.catch(() => {}).then(work);
  chain = next.catch(() => {});
  return next;
}

/** What a failed look means for the next one: wait for the rate limit, or back off a little more each time. */
function pauseFor(err: unknown): void {
  if (err instanceof RateLimited) {
    if (pauseReason !== "rate-limit" || pausedUntil < err.until) console.warn(`[tot] watching pull requests: ${err.message} Looking again then.`);
    pausedUntil = err.until;
    pauseReason = "rate-limit";
    return;
  }
  failures++;
  const wait = Math.min(POLL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
  pausedUntil = Date.now() + wait;
  pauseReason = "errors";
  if (failures === 1 || failures % 5 === 0) console.warn(`[tot] watching pull requests failed (${errorText(err)}); trying again in ${Math.round(wait / 60_000)} min.`);
}

function resume(): void {
  failures = 0;
  pausedUntil = 0;
  pauseReason = null;
}

/** Every watching project, unless paused or there's no GitHub connection (then quietly nothing). */
async function tick(): Promise<void> {
  return exclusive(async () => {
    const who = github.identity();
    if (!who || Date.now() < pausedUntil) return;
    const logins = totLogins();
    try {
      for (const project of watchingProjects()) await lookAtProject(project, who.token, logins);
      resume();
    } catch (err) {
      pauseFor(err);
    }
  });
}

export const prWatch = {
  /** Looks every 2 minutes while TOT runs (the first time shortly after it starts). */
  start(): void {
    if (timer) return;
    first = setTimeout(() => void tick(), FIRST_POLL_MS);
    timer = setInterval(() => void tick(), POLL_MS);
    first.unref();
    timer.unref();
  },

  stop(): void {
    if (first) clearTimeout(first);
    if (timer) clearInterval(timer);
    first = timer = null;
  },

  /**
   * POST /api/projects/:id/signals/check: looks at the project's pull requests now (the user asked, so after errors
   * too; not before GitHub's rate limit resets). Returns the signals it posted.
   */
  async check(projectId: string): Promise<LeadSignal[]> {
    const project = projects.get(projectId);
    if (!project) throw new HttpError(404, "Project not found.");
    if ((project.subscriptions?.pullRequests ?? "tot") === "off") throw new HttpError(409, "This project doesn't watch pull requests. Turn it on in the project's Subscriptions.");
    if (!conversations.leadOf(project.id)) throw new HttpError(409, "Open the project's Lead first: it's the one that hears about pull requests.");
    const who = github.identity();
    if (!who) throw new HttpError(409, "Connect GitHub in Settings → GitHub to watch pull requests.");
    return exclusive(async () => {
      if (pauseReason === "rate-limit" && Date.now() < pausedUntil) {
        throw new HttpError(409, `GitHub's rate limit is used up. TOT looks again at ${new Date(pausedUntil).toLocaleTimeString()}.`);
      }
      try {
        const posted = await lookAtProject(projects.get(projectId) ?? project, who.token, totLogins());
        resume();
        return posted;
      } catch (err) {
        pauseFor(err);
        throw new HttpError(409, err instanceof RateLimited ? `${err.message} TOT looks again then.` : `Couldn't read the pull requests: ${errorText(err)}`);
      }
    });
  },

  /** Tests: one look at every watching project now, as the timer does. */
  tick,

  /** Tests: whether the watcher is waiting, and until when. */
  paused(): { until: number; reason: "rate-limit" | "errors" | null } {
    return { until: pausedUntil, reason: Date.now() < pausedUntil ? pauseReason : null };
  },

  /** Tests: as if TOT restarted (what's kept in the database stays). */
  reset(): void {
    resume();
    refusedRepos.clear();
  },
};
