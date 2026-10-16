import type { TaskLanding } from "@tot/shared/types";
import { HttpError } from "../agent/orchestrator.ts";
import { quote } from "../computer/github-login.ts";
import { GITHUB_API_URL } from "../config.ts";
import { github } from "../github.ts";
import type { AgentGitHub } from "../persona-github.ts";
import type { TaskRecord } from "../tasks/store.ts";
import { baseRefScript, gitWords, inWorktree, onComputer, sectionsOf } from "./git.ts";

/**
 * A draft pull request for a finished task (module 09, lane A; 04's M1): its tot/* branch pushed
 * from the worktree through the agent's computer (the computer's GitHub login does the pushing,
 * so it only works while GitHub writes are on), then a draft PR opened with the REST API as the
 * agent's account. Only that branch is pushed, never with force; nothing is merged on GitHub.
 */

const PUSH_TIMEOUT_MS = 5 * 60_000;
const MAX_BODY = 60_000;
const MAX_FILES = 60;

const bullets = (items: string[]) => items.map((item) => `- ${item}`).join("\n");

/** The PR's description: goal, summary, files changed, checks, open questions, and who it's for. */
export function prBody(task: TaskRecord, files: string[]): string {
  const { goal, summary, checks, result } = task.task;
  const user = github.identity()?.login;
  const sections = [
    goal.trim(),
    summary?.trim() && summary.trim() !== goal.trim() ? `## Summary\n${summary.trim()}` : "",
    files.length ? `## Files changed\n${bullets(files.slice(0, MAX_FILES))}${files.length > MAX_FILES ? `\n- …and ${files.length - MAX_FILES} more` : ""}` : "",
    checks?.lines.length ? `## Checks\n${bullets(checks.lines)}` : "",
    result?.openQuestions.length ? `## Open questions\n${bullets(result.openQuestions)}` : "",
    `---\nOpened by TOT${user ? ` for @${user}` : ""}`,
  ];
  const body = sections.filter(Boolean).join("\n\n");
  return body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 1)}…` : body;
}

async function githubApi(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${GITHUB_API_URL}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "TOT",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new HttpError(409, "Couldn't reach GitHub. Check your connection and try again.");
  }
}

interface PullRequest {
  number: number;
  html_url: string;
}

/** The draft PR, or the open one GitHub already has for this branch (a retry after the push went through). */
async function createDraft(repo: string, token: string, request: { title: string; body: string; head: string; base: string }): Promise<PullRequest> {
  const res = await githubApi(`/repos/${repo}/pulls`, token, { method: "POST", body: JSON.stringify({ ...request, draft: true }) });
  if (res.ok) return (await res.json()) as PullRequest;
  const answer = (await res.json().catch(() => ({}))) as { message?: string; errors?: { message?: string }[] };
  const said = [answer.message, ...(answer.errors ?? []).map((error) => error.message)].filter(Boolean).join(": ");
  if (res.status === 422 && /already exists/i.test(said)) {
    const owner = repo.split("/")[0]!;
    const open = await githubApi(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${request.head}`)}`, token);
    const found = open.ok ? ((await open.json()) as PullRequest[])[0] : undefined;
    if (found) return found;
  }
  throw new HttpError(409, `GitHub didn't open the pull request (${res.status}${said ? `: ${gitWords(said)}` : ""}).`);
}

/**
 * Pushes the task's branch and opens a draft PR into `base`. The caller has checked that the
 * branch is a tot/* one, that the agent's account may write, and that nothing is left uncommitted.
 * With `headSha` (the commit the user reviewed) exactly that commit is pushed as the branch, so a
 * commit made after the check can't ride along.
 */
export async function openDraftPr(
  task: TaskRecord,
  { repo, base, access, title, body, headSha }: { repo: string; base: string; access: AgentGitHub; title?: string; body?: string; headSha?: string },
): Promise<Omit<TaskLanding, "at">> {
  const { branch } = task.task.repo!;
  const branchRef = `refs/heads/${branch}`;
  const source = headSha && /^[0-9a-f]{7,64}$/.test(headSha) ? headSha : branchRef;
  const pushScript = [
    `git push --porcelain -u origin ${quote(`${source}:${branchRef}`)} 2>&1 || exit 4`,
    // Pushing a commit (not the branch) sets no upstream: set it, so review fixes on the branch push as before.
    ...(source === branchRef ? [] : [`git config ${quote(`branch.${branch}.remote`)} origin && git config ${quote(`branch.${branch}.merge`)} ${quote(branchRef)}`]),
    baseRefScript(base, false),
    "echo '@@ head'; git rev-parse HEAD",
    `echo '@@ files'; git diff --numstat "$(git merge-base "$ref" HEAD)" HEAD | head -n ${MAX_FILES + 1}`,
  ].join("\n");
  const { cwd, script } = inWorktree(task.task.repo!, pushScript);
  const pushed = await onComputer(task, script, cwd, null, PUSH_TIMEOUT_MS);
  if (pushed.exitCode !== 0) {
    const words = gitWords(pushed.stdout.split("\n@@ ")[0]! || pushed.stderr);
    throw new HttpError(409, `Couldn't push ${branch}: ${words || `exit code ${pushed.exitCode}`}`);
  }
  const found = sectionsOf(pushed.stdout);
  const head = found.head?.trim() || null;
  const files = (found.files ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added = "0", removed = "0", ...path] = line.split("\t");
      return added === "-" ? `\`${path.join("\t")}\` (binary)` : `\`${path.join("\t")}\` (+${added} −${removed})`;
    });
  const pr = await createDraft(repo, access.token, { title: title?.trim() || task.title, body: body?.trim() || prBody(task, files), head: branch, base });
  return { kind: "pr", target: base, sha: head, pr: { number: pr.number, url: pr.html_url } };
}

/**
 * A pull request as GitHub has it now (read only): open or not, merged, and its head commit. Null when GitHub
 * couldn't be asked; "gone" when it doesn't know the PR.
 */
export async function readPullRequest(repo: string, number: number, token: string): Promise<{ open: boolean; merged: boolean; headSha: string } | "gone" | null> {
  try {
    const res = await githubApi(`/repos/${repo}/pulls/${number}`, token);
    if (res.status === 404 || res.status === 410) return "gone";
    if (!res.ok) return null;
    const pr = (await res.json()) as { state?: string; merged?: boolean; merged_at?: string | null; head?: { sha?: string } };
    return { open: pr.state === "open", merged: Boolean(pr.merged || pr.merged_at), headSha: pr.head?.sha ?? "" };
  } catch {
    return null;
  }
}

/**
 * Module 12: pushes a draft PR's branch forward to `headSha`, the commit the user approved on the Lead's card (review
 * fixes made after the PR was opened). Exactly that commit goes up as the branch, never with force: a branch GitHub
 * has moved on from, or one rewritten here, is refused by git and nothing changes.
 */
export async function pushToDraftPr(task: TaskRecord, headSha: string): Promise<void> {
  const { branch } = task.task.repo!;
  const { cwd, script } = inWorktree(task.task.repo!, `git push --porcelain origin ${quote(`${headSha}:refs/heads/${branch}`)} 2>&1 || exit 4`);
  const pushed = await onComputer(task, script, cwd, null, PUSH_TIMEOUT_MS);
  if (pushed.exitCode !== 0) {
    const words = gitWords(pushed.stdout || pushed.stderr);
    throw new HttpError(409, `Couldn't push ${branch}: ${words || `exit code ${pushed.exitCode}`}`);
  }
}
