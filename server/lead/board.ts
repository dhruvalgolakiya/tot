import type { HomeProject, MissionOverlap, Project, TaskChecks } from "../../shared/types.ts";
import { conversations } from "../data/conversations.ts";
import { db, type Row } from "../db.ts";
import { missionOverview, onBoard } from "../mission/overview.ts";
import { projects, tildePath } from "../projects/projects.ts";
import { isTask, type TaskRecord } from "../tasks/store.ts";

/**
 * A project's board in words and numbers (roadmap module 11, lane D): what the Lead's mission_overview
 * tool says (needs you, working, ready to land with checks and overlaps, in the order to land), the
 * project's repos as the Lead is told them, and Home's row for each project. Sections follow mission
 * control's board (src/lib/mission.ts), so the Lead, Home and the board agree.
 */

export type BoardSection = "needs-you" | "working" | "ready" | "done" | "landed";

/** Statuses a task can't move on from by itself. */
const FINISHED_STATUSES = new Set(["done", "failed", "stopped", "interrupted"]);

/** Where a task sits on the board: waiting on the user, working, finished with code to land, finished without code, or landed. */
export function boardSection(task: TaskRecord): BoardSection {
  const { status, landing, repo } = task.task;
  // A draft PR is landed, until its task works on it again (review fixes): then it's working, and once those new
  // commits wait to be pushed, ready to land again (module 12).
  const prWithNews = landing?.kind === "pr" && (!FINISHED_STATUSES.has(status) || (Boolean(repo?.headSha) && repo?.headSha !== landing.sha));
  if (landing && !prWithNews) return "landed";
  if (status === "needs-input" || status === "failed" || status === "interrupted") return "needs-you";
  if (status === "running" || status === "queued" || status === "paused") return "working";
  return repo?.headSha ? "ready" : "done";
}

/** The project's repos, one line each: "web (primary): GitHub acme/web · base main" ("(primary)" only when there are several). */
export function repoLines(project: Project): string[] {
  const base = (branch: string | null) => `base: ${branch ?? "the repo's default branch"}`;
  if (project.repos?.length) {
    const several = project.repos.length > 1;
    return project.repos.map((repo) => {
      const where = repo.kind === "github" ? `GitHub ${repo.source}` : `folder ${tildePath(repo.source)}${repo.folderGranted ? "" : " (the user hasn't allowed agents in yet)"}`;
      return `${repo.name}${several && repo.primary ? " (primary)" : ""}: ${where} · ${base(repo.defaultBranch)}`;
    });
  }
  // Before module 11's repos (or a project made before them): the project's one repo or folder.
  if (project.kind === "github" && project.source) return [`${project.slug}: GitHub ${project.source} · ${base(project.defaultBranch)}`];
  if (project.kind === "folder" && project.source) {
    return [`${project.slug}: folder ${tildePath(project.source)}${project.folderGranted ? "" : " (the user hasn't allowed agents in yet)"} · ${base(project.defaultBranch)}`];
  }
  return [];
}

const firstLine = (text: string | null | undefined, max = 160) => {
  const line = text?.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

function checksWords(checks: TaskChecks | null | undefined, headSha: string | null): string | null {
  if (!checks) return null;
  const state = { running: "checks running", passing: "checks passing", failing: "checks failing", none: "no checks" }[checks.state];
  const stale = checks.headSha && headSha && checks.headSha !== headSha ? " (for an older commit)" : "";
  const failed = checks.state === "failing" ? checks.lines.filter((line) => /fail/i.test(line)).slice(0, 2) : [];
  return `${state}${stale}${failed.length ? `: ${failed.join("; ")}` : ""}`;
}

/** Who started it: this Lead, another chat (by title), or nobody (started on its own). */
function startedBy(task: TaskRecord, leadId: string | null): string {
  if (!task.parentId) return "started on its own";
  if (task.parentId === leadId) return "started by you";
  const parent = conversations.get(task.parentId);
  return parent ? `from ${parent.kind === "task" ? "task" : "chat"} “${parent.title}”` : "started elsewhere";
}

/** A task's line on the board; `named` adds which repo it works in (a project with several). */
function taskLine(task: TaskRecord, leadId: string | null, overlaps: MissionOverlap[], titleOf: (id: string) => string, named: boolean): string {
  const { status, repo, stats, checks, landing, question, progress, queuePosition, plan, summary, result } = task.task;
  const parts = [`${task.id} · “${task.title}” · ${status}${status === "queued" && queuePosition ? ` (#${queuePosition} in line)` : ""}`];
  if (repo) parts.push(`${named && repo.repoName ? `repo ${repo.repoName} · ` : ""}branch ${repo.branch}`);
  if (stats) parts.push(`+${stats.added} −${stats.removed} · ${stats.files} file${stats.files === 1 ? "" : "s"}`);
  const checked = checksWords(checks, repo?.headSha ?? null);
  if (checked && !landing) parts.push(checked);
  parts.push(startedBy(task, leadId));
  const lines = [parts.join(" · ")];
  if (landing) {
    lines.push(
      landing.kind === "merged"
        ? `  merged into ${landing.target ?? "the folder"}${landing.sha ? ` · ${landing.sha.slice(0, 7)}` : ""}`
        : landing.kind === "pr"
          ? `  draft PR #${landing.pr?.number ?? "?"} against ${landing.target ?? "the base"}`
          : "  discarded",
    );
  } else if (status === "needs-input") {
    lines.push(question ? `  asks: ${firstLine(question, 400)}` : "  waiting for the user's OK on a card in the task");
  } else if (status === "running" || status === "paused") {
    const done = plan.filter((step) => step.done).length;
    if (progress) lines.push(`  now: ${firstLine(progress)}`);
    if (plan.length) lines.push(`  plan: ${done}/${plan.length} steps done`);
  } else if (status !== "queued") {
    const said = firstLine(result?.summary ?? summary);
    if (said) lines.push(`  result: ${said}`);
  }
  if (overlaps.length && !landing) {
    for (const overlap of overlaps.slice(0, 3)) {
      const files = overlap.paths.slice(0, 3).join(", ") + (overlap.paths.length > 3 ? ` and ${overlap.paths.length - 3} more` : "");
      lines.push(`  overlaps: also changes ${files} in “${titleOf(overlap.taskId)}” (${overlap.taskId})`);
    }
  }
  return lines.join("\n");
}

/** mission_overview: the project's board as text for its Lead. */
export function projectBoardText(project: Project, leadId: string | null): string {
  const overview = missionOverview({ projectId: project.id });
  const overlaps = new Map(overview.tasks.map((t) => [t.conversation.id, t.overlaps]));
  const all = overview.tasks.map((t) => conversations.get(t.conversation.id)).filter(isTask);
  const titleOf = (id: string) => conversations.get(id)?.title ?? "another task";
  const by = (section: BoardSection) => all.filter((task) => boardSection(task) === section);
  const named = (project.repos?.length ?? 0) > 1;
  const line = (task: TaskRecord) => taskLine(task, leadId, overlaps.get(task.id) ?? [], titleOf, named);
  const order = (task: TaskRecord) => {
    const at = overview.landOrder.indexOf(task.id);
    return at === -1 ? overview.landOrder.length : at;
  };
  const ready = by("ready").sort((a, b) => order(a) - order(b));

  const repos = repoLines(project);
  const out: string[] = [`Project “${project.name}”${repos.length ? `. Repos:\n${repos.map((r) => `- ${r}`).join("\n")}` : " (no repos: a topic project)."}`];
  const section = (title: string, list: TaskRecord[], numbered = false) => {
    if (!list.length) return;
    out.push(`${title} (${list.length})\n${list.map((task, i) => (numbered ? `${i + 1}. ${line(task)}` : `- ${line(task)}`)).join("\n")}`);
  };
  section("Needs you", by("needs-you"));
  section("Working", by("working"));
  section("Ready to land, in this order (fewest overlaps first, then the smallest)", ready, true);
  section("Finished, nothing to land", by("done"));
  section("Landed or discarded in the last day", by("landed"));
  if (!all.length) out.push("No tasks on the board: nothing open, waiting to land, or landed today.");
  else if (ready.length) out.push("Land a task with task_land (the user is asked first). A task behind its base: task_update_from_base.");
  return out.join("\n\n");
}

/** GET /api/home: every project's row, the most recently active first. */
export function homeProjects(now = Date.now()): HomeProject[] {
  const tasks = conversations.tasks().filter(isTask);
  const last = new Map(
    (db.prepare(`SELECT project_id, MAX(updated_at) AS at FROM conversations WHERE project_id IS NOT NULL GROUP BY project_id`).all() as Row[]).map((row) => [
      String(row.project_id),
      Number(row.at),
    ]),
  );
  const rows = projects.list().map((project): HomeProject => {
    const shown = tasks.filter((task) => task.projectId === project.id && onBoard(task, now));
    const count = (section: BoardSection) => shown.filter((task) => boardSection(task) === section).length;
    return {
      project,
      needsYou: count("needs-you"),
      working: count("working"),
      readyToLand: count("ready"),
      lastActivityAt: last.get(project.id) ?? null,
      leadChatId: project.leadChatId ?? null,
    };
  });
  return rows.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.project.name.localeCompare(b.project.name));
}
