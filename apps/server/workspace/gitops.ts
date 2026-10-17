import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { WorkspaceCommit, WorkspaceGit, WorkspaceGitResult } from "@tot/shared/workspace";
import { HttpError } from "../agent/orchestrator.ts";
import { limits } from "../agent/limits.ts";
import { providers, providerStatuses } from "../agent/providers/index.ts";
import { GITHUB_API_URL } from "../config.ts";
import { githubFullName } from "../data/brains.ts";
import { hostGitEnv } from "../git-env.ts";
import { github } from "../github.ts";
import { gitWords } from "../landing/git.ts";
import { CLAUDE_SONNET } from "../orchestration/tiers.ts";
import { projectRepos } from "../projects/repos.ts";
import { gitBatch, gitOrThrow, gitRun } from "./git.ts";
import type { ChatSpace } from "./root.ts";

/**
 * The panel's git button: commit everything (with a message it suggests), push, open a draft pull request,
 * pull and sync, in the chat's folder, where its git runs (git.ts). It's the user's action, so commits carry
 * the user's own name and address from their git config when there is one. Pushing to the repo's default branch
 * needs `confirmDefault`, asked of the user first. Pull requests go through the GitHub connection (github.ts)
 * and only while it may write; pulls only fast-forward.
 */

const NETWORK_TIMEOUT_MS = 120_000;
const MAX_MESSAGE = 5000;
const PR_FOOTER = "Opened from TOT's workspace panel.";

const run = promisify(execFile);

/** The user's own git name and address (their global config), read once. */
let identity: Promise<{ name: string; email: string } | null> | null = null;
function userIdentity(): Promise<{ name: string; email: string } | null> {
  identity ??= (async () => {
    const read = async (key: string) => {
      try {
        return (await run("git", ["config", "--global", "--get", key], { cwd: tmpdir(), env: hostGitEnv(), timeout: 5000 })).stdout.trim();
      } catch {
        return "";
      }
    };
    const [name, email] = await Promise.all([read("user.name"), read("user.email")]);
    return name && email ? { name, email } : null;
  })();
  return identity;
}

/** A worktree of a folder on this Mac: its sandbox can't change git's config, so a push there can't set an upstream. */
const configLocked = (space: ChatSpace) => Boolean(space.grant?.task);

export async function gitStatus(space: ChatSpace): Promise<WorkspaceGit> {
  if (!space.git) throw new HttpError(409, "This folder isn't a git repo.");
  const [branch, upstream, counts, status, origin, originHead, usual] = await gitBatch(space, [
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    ["rev-list", "--left-right", "--count", "@{u}...HEAD"],
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
    ["remote", "get-url", "origin"],
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    ["for-each-ref", "--format=%(refname:short)", "refs/heads/main", "refs/heads/master"],
  ]);
  const [behind = 0, ahead = 0] = counts!.code === 0 ? counts!.stdout.trim().split(/\s+/).map(Number) : [];
  const repo = githubFullName(origin!.code === 0 ? origin!.stdout.trim() : "");
  const project = projectRepos.primary(space.chat.projectId ?? "");
  // origin's own HEAD, else what the project or the worktree says, else a main or master the repo has.
  const defaultBranch =
    (originHead!.code === 0 ? originHead!.stdout.trim().replace(/^origin\//, "") : "") ||
    project?.defaultBranch ||
    space.baseBranch ||
    usual!.stdout.split("\n").find(Boolean) ||
    null;
  const access = github.identity();
  const prProblem = !repo
    ? "This repo isn't on GitHub."
    : !access
      ? "Connect GitHub in Settings to open pull requests."
      : !access.allowWrites
        ? "Turn on GitHub writes in Settings to open pull requests."
        : null;
  return {
    branch: branch!.code === 0 ? branch!.stdout.trim() : null,
    defaultBranch,
    upstream: upstream!.code === 0 ? upstream!.stdout.trim() : null,
    ahead: ahead || 0,
    behind: behind || 0,
    changes: status!.stdout.split("\0").filter((entry) => entry.length > 3).length,
    github: repo,
    canOpenPr: !prProblem,
    prProblem,
  };
}

/** A commit message for what's changed: written by a model in a few seconds when one is signed in, else plain. */
export async function suggestMessage(space: ChatSpace): Promise<string> {
  const [stat, diff, untracked] = await gitBatch(space, [
    ["diff", "HEAD", "--stat", "--no-color", "--no-ext-diff"],
    ["diff", "HEAD", "--no-color", "--no-ext-diff", "--no-textconv", "-U2"],
    ["ls-files", "--others", "--exclude-standard"],
  ]);
  const added = untracked!.stdout.split("\n").filter(Boolean);
  const changed = [...stat!.stdout.matchAll(/^ (\S.*?)\s+\|/gm)].map((match) => match[1]!.trim());
  const files = [...changed, ...added];
  if (!files.length) return "";
  const plain = files.length === 1 ? `Update ${files[0]!.split("/").pop()}` : `Update ${files.length} files`;
  const prompt = [
    "Write a git commit message for the change below: a subject line in the imperative mood, at most 60 characters, no",
    "trailing period; then, only if it helps, a blank line and a short body. Reply with the message only.",
    "",
    "<stat>",
    stat!.stdout.slice(0, 4000),
    added.length ? `New files: ${added.slice(0, 40).join(", ")}` : "",
    "</stat>",
    "<diff>",
    diff!.stdout.slice(0, 12_000),
    "</diff>",
  ].join("\n");
  try {
    const statuses = await providerStatuses();
    const limited = limits.active();
    for (const id of (["claude", "chatgpt"] as const).filter((each) => statuses.find((s) => s.id === each)?.loggedIn && !limited.has(each))) {
      try {
        const raw = await providers[id].complete(prompt, { model: id === "claude" ? CLAUDE_SONNET : undefined, signal: AbortSignal.timeout(20_000) });
        const message = raw.trim().replace(/^```\w*\n?|\n?```$/g, "").trim();
        if (message) return message.slice(0, MAX_MESSAGE);
      } catch {
        // The next one, or the plain message.
      }
    }
  } catch {
    // No provider to ask.
  }
  return plain;
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

/** A draft pull request of `head` into `base`, or the open one GitHub already has for it. */
async function openDraft(repo: string, token: string, request: { title: string; body: string; head: string; base: string }): Promise<{ number: number; url: string }> {
  const res = await githubApi(`/repos/${repo}/pulls`, token, { method: "POST", body: JSON.stringify({ ...request, draft: true }) });
  if (res.ok) {
    const pr = (await res.json()) as { number: number; html_url: string };
    return { number: pr.number, url: pr.html_url };
  }
  const answer = (await res.json().catch(() => ({}))) as { message?: string; errors?: { message?: string }[] };
  const said = [answer.message, ...(answer.errors ?? []).map((error) => error.message)].filter(Boolean).join(": ");
  if (res.status === 422 && /already exists/i.test(said)) {
    const owner = repo.split("/")[0]!;
    const open = await githubApi(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${request.head}`)}`, token);
    const found = open.ok ? ((await open.json()) as { number: number; html_url: string }[])[0] : undefined;
    if (found) return { number: found.number, url: found.html_url };
  }
  throw new HttpError(409, `GitHub didn't open the pull request (${res.status}${said ? `: ${said.slice(0, 200)}` : ""}).`);
}

async function push(space: ChatSpace, status: WorkspaceGit, confirmDefault: boolean): Promise<void> {
  if (!status.branch) throw new HttpError(409, "There's no branch checked out to push.");
  if (status.branch === status.defaultBranch && !confirmDefault) {
    throw new HttpError(409, `Pushing to ${status.branch}, the repo's default branch, needs your OK first.`);
  }
  const args = status.upstream ? ["push"] : configLocked(space) ? ["push", "origin", `HEAD:refs/heads/${status.branch}`] : ["push", "-u", "origin", "HEAD"];
  const pushed = await gitRun(space, args, { timeoutMs: NETWORK_TIMEOUT_MS });
  if (pushed.code !== 0) throw new HttpError(409, `Couldn't push ${status.branch}: ${gitWords(pushed.stderr || pushed.stdout) || `exit code ${pushed.code}`}`);
}

async function pullFastForward(space: ChatSpace): Promise<void> {
  const pulled = await gitRun(space, ["pull", "--ff-only", "--no-rebase"], { timeoutMs: NETWORK_TIMEOUT_MS });
  if (pulled.code === 0) return;
  const words = gitWords(pulled.stderr || pulled.stdout);
  if (/not possible to fast-forward|diverg/i.test(words)) throw new HttpError(409, "Your branch and its upstream have both moved on. Merge or rebase them in a terminal.");
  throw new HttpError(409, `Couldn't pull: ${words || `exit code ${pulled.code}`}`);
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export const workspaceGit = {
  status: gitStatus,
  suggestMessage,

  async commit(space: ChatSpace, input: WorkspaceCommit): Promise<WorkspaceGitResult> {
    const message = typeof input?.message === "string" ? input.message.trim() : "";
    const before = await gitStatus(space);
    const pushing = Boolean(input?.push || input?.pr);
    // Asked before anything happens, so a refusal leaves nothing half done.
    if (pushing && before.branch && before.branch === before.defaultBranch && !input.confirmDefault) {
      throw new HttpError(409, `Pushing to ${before.branch}, the repo's default branch, needs your OK first.`);
    }
    if (input?.pr && before.branch === before.defaultBranch) throw new HttpError(409, `A pull request needs a branch other than ${before.branch}.`);
    if (input?.pr && !before.canOpenPr) throw new HttpError(409, before.prProblem ?? "A pull request can't be opened from here.");
    const steps: string[] = [];
    if (before.changes) {
      if (!message) throw new HttpError(400, "Write a commit message.");
      if (message.length > MAX_MESSAGE) throw new HttpError(400, "That commit message is too long.");
      const who = await userIdentity();
      await gitOrThrow(space, ["add", "-A"]);
      await gitOrThrow(space, [...(who ? ["-c", `user.name=${who.name}`, "-c", `user.email=${who.email}`] : []), "commit", "--quiet", "-m", message]);
      steps.push(`Committed ${plural(before.changes, "file")}`);
    } else if (!pushing) {
      throw new HttpError(409, "There's nothing to commit.");
    }
    let pr: WorkspaceGitResult["pr"];
    if (pushing) {
      await push(space, before, Boolean(input.confirmDefault));
      steps.push(steps.length ? "pushed" : `Pushed ${before.branch}`);
      if (input.pr) {
        const access = github.identity()!;
        const [subject, ...rest] = (message || (await gitOrThrow(space, ["log", "-1", "--format=%B"])).trim()).split("\n");
        const base = space.baseBranch && space.baseBranch !== before.branch ? space.baseBranch : before.defaultBranch!;
        pr = await openDraft(before.github!, access.token, {
          title: subject!.trim() || before.branch!,
          body: [rest.join("\n").trim(), PR_FOOTER].filter(Boolean).join("\n\n"),
          head: before.branch!,
          base,
        });
        steps.push(`opened draft PR #${pr.number}`);
      }
    }
    return { git: await gitStatus(space), summary: steps.join(", "), ...(pr ? { pr } : {}) };
  },

  async push(space: ChatSpace, confirmDefault: boolean): Promise<WorkspaceGitResult> {
    const before = await gitStatus(space);
    await push(space, before, confirmDefault);
    return { git: await gitStatus(space), summary: `Pushed ${before.branch}` };
  },

  async pull(space: ChatSpace): Promise<WorkspaceGitResult> {
    const before = await gitStatus(space);
    if (!before.upstream) throw new HttpError(409, `${before.branch ?? "This branch"} doesn't track a branch to pull from yet.`);
    await pullFastForward(space);
    const after = await gitStatus(space);
    return { git: after, summary: before.behind ? `Pulled ${plural(before.behind, "commit")}` : "Already up to date" };
  },

  /** Pull (fast-forward only), then push what's left. */
  async sync(space: ChatSpace, confirmDefault: boolean): Promise<WorkspaceGitResult> {
    const before = await gitStatus(space);
    if (before.upstream) await pullFastForward(space);
    const middle = await gitStatus(space);
    if (middle.ahead || !middle.upstream) await push(space, middle, confirmDefault);
    return { git: await gitStatus(space), summary: "Synced" };
  },
};
