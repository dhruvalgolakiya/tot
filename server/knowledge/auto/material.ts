import type { Project, TaskChangedFile } from "../../../shared/types.ts";
import { folderGit } from "../../landing/git.ts";
import { grantFor } from "../../projects/checkout.ts";
import type { TaskRecord } from "../../tasks/store.ts";
import { worktrees } from "../../tasks/worktree.ts";
import { scrub } from "../../trust/secrets.ts";
import type { Material } from "./prompt.ts";
import { projectRepos } from "./repos.ts";

/**
 * Module 11, lane C: what changed, as an auto-update reads it. A landed task's diff (stat and patch, capped):
 * for a merge, the merge commit in the user's folder on this Mac (the task's worktree is gone by then); for a
 * draft PR, its worktree on the agent's computer (`worktrees.changes`); else the stats its last turn left. A
 * base branch's move is the commits and diff stat of the range (watch.ts). Secrets are scrubbed first.
 */

const STAT_BUDGET = 4000;
const PATCH_BUDGET = 20_000;
const LOG_BUDGET = 6000;

const attr = (text: string) => text.replace(/"/g, "'").replace(/\s+/g, " ").trim();

/** Keeps the start of a long text, saying how much was left out. */
export function capped(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n… (${(text.length - max).toLocaleString("en-US")} more characters left out)`, truncated: true };
}

/** "src/cart.ts | +12 −3" per file. */
const statLines = (files: Pick<TaskChangedFile, "path" | "additions" | "deletions">[]) => files.map((file) => `${file.path} | +${file.additions} −${file.deletions}`).join("\n");

interface Diff {
  files: Pick<TaskChangedFile, "path" | "additions" | "deletions">[];
  patch: string;
}

/** A merge commit's changes, from the user's folder (read only). */
async function mergedDiff(folder: string, sha: string): Promise<Diff | null> {
  const numstat = await folderGit(folder, ["-c", "core.quotePath=false", "diff", "--numstat", "--no-renames", `${sha}^1`, sha]);
  if (numstat.code !== 0) return null;
  const files = parseNumstat(numstat.stdout);
  // A diff past git's output limit is left out; the stat still says what changed.
  const patch = await folderGit(folder, ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--unified=2", "--no-renames", `${sha}^1`, sha]);
  return { files, patch: patch.code === 0 ? patch.stdout : "" };
}

/** The landed task's diff, from wherever it still is; never throws (a task without one still has its summary). */
async function landedDiff(task: TaskRecord, project: Project): Promise<Diff | null> {
  const { repo, landing } = task.task;
  if (!repo) return null;
  if (landing?.kind === "merged" && landing.sha && projectRepos(project).some((r) => r.kind === "folder" && r.source === repo.folder)) {
    const merged = await mergedDiff(repo.folder, landing.sha).catch(() => null);
    if (merged) return merged;
  }
  if (repo.headSha) {
    try {
      let grant = null;
      try {
        grant = grantFor(task);
      } catch {
        // A folder that can't be used now: the worktree can't be read either.
      }
      const changes = await worktrees.changes(task.agentId, repo, grant);
      return { files: changes.files, patch: changes.patch };
    } catch {
      // The worktree is gone; the stats below are all that's left.
    }
  }
  const stats = task.task.stats;
  if (!stats?.paths.length) return null;
  return { files: stats.paths.map((path) => ({ path, additions: 0, deletions: 0 })), patch: "" };
}

/** A landed task as an update reads it. */
export async function landedMaterial(task: TaskRecord, project: Project, repoName: string | null): Promise<Material> {
  const { landing, goal, summary, result } = task.task;
  const how = landing?.kind === "pr" ? `opened as draft PR #${landing.pr?.number ?? "?"} into ${landing.target ?? "main"}` : `merged into ${landing?.target ?? "main"}`;
  const diff = await landedDiff(task, project);
  const stat = capped(scrub(statLines(diff?.files ?? [])), STAT_BUDGET);
  const patch = capped(scrub(diff?.patch ?? ""), PATCH_BUDGET);
  const done = scrub(result?.summary || summary || "");
  const text = `<change kind="landed" task="${attr(task.title)}" how="${attr(how)}"${repoName ? ` repo="${attr(repoName)}"` : ""}>
<goal>${scrub(goal)}</goal>
${done ? `<summary>${done}</summary>\n` : ""}<files>
${stat.text || "(not known)"}
</files>
${patch.text ? `<patch${patch.truncated ? ' truncated="true"' : ""}>\n${patch.text}\n</patch>\n` : ""}</change>`;
  const paths = (diff?.files ?? []).map((file) => file.path);
  return { text, paths, words: [task.title, goal, done, ...paths.map((path) => path.split("/").pop())].join(" ") };
}

/** "12\t3\tsrc/cart.ts" lines (git diff --numstat) as files. */
export function parseNumstat(out: string): Pick<TaskChangedFile, "path" | "additions" | "deletions">[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [plus = "0", minus = "0", ...rest] = line.split("\t");
      return { path: rest.join("\t"), additions: Number(plus) || 0, deletions: Number(minus) || 0 };
    });
}

/** A base branch's move as an update reads it: the commits (newest first) and what they changed, per file. */
export function movedMaterial(
  repoName: string,
  branch: string,
  from: string,
  to: string,
  log: string,
  files: Pick<TaskChangedFile, "path" | "additions" | "deletions">[],
  rewritten: boolean,
): Material {
  const commits = capped(scrub(log.trim()), LOG_BUDGET);
  const stat = capped(scrub(statLines(files)), STAT_BUDGET);
  const text = `<change kind="base-moved" repo="${attr(repoName)}" branch="${attr(branch)}" from="${from.slice(0, 7)}" to="${to.slice(0, 7)}">
${rewritten ? "<note>The branch's history was rewritten; these are its newest commits.</note>\n" : ""}<commits>
${commits.text || "(none listed)"}
</commits>
<files>
${stat.text || "(not known)"}
</files>
</change>`;
  const paths = files.map((file) => file.path);
  return { text, paths, words: [log, ...paths.map((path) => path.split("/").pop())].join(" ") };
}
