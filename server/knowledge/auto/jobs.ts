import type { KnowledgeRefreshResult, KnowledgeTrigger, KnowledgeUpdate, Project } from "../../../shared/types.ts";
import { HttpError } from "../../agent/orchestrator.ts";
import { defaultComplete, type Complete } from "../../agent/wiki-keeper.ts";
import { appEvents } from "../../app-events.ts";
import { conversations } from "../../data/conversations.ts";
import { settings } from "../../data/settings.ts";
import { quoted } from "../../memory/memory.ts";
import { projects } from "../../projects/projects.ts";
import { isTask, taskStore, type TaskRecord } from "../../tasks/store.ts";
import { scrub } from "../../trust/secrets.ts";
import { applyOps } from "./apply.ts";
import { knowledgeChanged, knowledgeLog, landingsPending } from "./log.ts";
import { landedMaterial } from "./material.ts";
import { buildPrompt, checkOps, parseOps, SYSTEM, type Material, type Refusal } from "./prompt.ts";
import { repoOfTask } from "./repos.ts";
import { checkDue, checkProject } from "./watch.ts";

/**
 * Module 11, lane C: a project's knowledge keeps itself up to date. When a task lands (merged, or opened as a
 * draft PR) and when a project repo's base branch moves (checked every 6 hours, or now with Check now), an
 * update runs: the keeper's light model (`defaultComplete`, never the chat's model) reads the change and the
 * repo's docs and answers with operations, which are checked and applied as one commit by "TOT" (prompt.ts,
 * apply.ts). Updates run one at a time, in the background: a failure (no provider, a usage limit, a bad reply)
 * waits and tries again, twice, then is logged; nothing here ever holds up landing.
 */

/** One update to run. */
export interface UpdateJob {
  /** The same change twice is queued once. */
  key: string;
  projectId: string;
  trigger: KnowledgeTrigger;
  repoName: string | null;
  taskId: string | null;
  /** What it comes after, for its one line: "“Fix cart”", "web moved to 3f2a9c1". */
  after: string;
  /** Its commit's subject. */
  subject: string;
  /** New facts' source. */
  factSource: string;
  /** Reads what changed (called when it runs, and again on a retry). */
  material: () => Promise<Material>;
}

const TICK_MS = 60_000;
const RETRY_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;
/** The 6-hour check looks for due repos this often, the first time a little after TOT starts. */
const WATCH_TICK_MS = 10 * 60_000;
const WATCH_FIRST_MS = 2 * 60_000;
/** Tasks landed this recently without an update (TOT stopped first) get one at startup. */
const CATCH_UP_MS = 24 * 60 * 60_000;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Whether project knowledge updates itself: with memory on (Settings → Memory), as the wiki keeper. */
const enabled = () => settings.get().memory.enabled;

/**
 * Runs one update now. Null when there's nothing to do (the project is gone or archived); throws when the model
 * can't be reached or answers nonsense, so the queue tries again.
 */
export async function runUpdate(job: UpdateJob, complete: Complete = defaultComplete): Promise<{ update: KnowledgeUpdate; refused: Refusal[] } | null> {
  const project = projects.get(job.projectId);
  if (!project || project.archived) return null;
  const material = await job.material();
  const { prompt, shown } = buildPrompt(project, job.repoName, material);
  const raw = parseOps(await complete(prompt, SYSTEM));
  // The project may have gone while the model was thinking.
  if (!projects.get(project.id)) return null;
  const { ops, refused } = checkOps(raw, shown);
  const applied = await applyOps(project, ops, shown, { subject: job.subject, conversationId: job.taskId, factSource: job.factSource, skipped: refused });
  const changed = applied.pages.length + applied.facts > 0;
  const update = knowledgeLog.record({
    projectId: project.id,
    trigger: job.trigger,
    repoName: job.repoName,
    taskId: job.taskId,
    sha: applied.sha,
    pages: applied.pages,
    facts: applied.facts,
    summary: `${changed ? "Updated" : "Nothing to update"} after ${job.after}`,
    error: null,
    undo: applied.undo,
  });
  const skipped = [...refused, ...applied.refused];
  if (skipped.length) console.log(`[tot] knowledge update for ${project.name} skipped ${skipped.length}: ${skipped.map((s) => s.reason).join(" ")}`);
  return { update, refused: skipped };
}

/** The update a landed task gets: merged into a folder, or opened as a draft PR. Null for anything else. */
export function landedJob(task: TaskRecord): UpdateJob | null {
  const landing = task.task.landing;
  if (!landing || (landing.kind !== "merged" && landing.kind !== "pr") || !task.task.repo) return null;
  const project = projects.get(task.projectId);
  if (!project || project.archived) return null;
  const repoName = repoOfTask(project, task.task.repo)?.name ?? null;
  return {
    key: `landed:${task.id}:${landing.at}`,
    projectId: project.id,
    trigger: "landed",
    repoName,
    taskId: task.id,
    after: quoted(task.title, 60),
    subject: `Knowledge: after ${quoted(task.title)}`,
    factSource: `tot://c/${task.id}`,
    material: async () => landedMaterial(taskStore.get(task.id) ?? task, projects.get(project.id) ?? project, repoName),
  };
}

// --- The queue ----------------------------------------------------------------------------------------------------

interface Queued {
  job: UpdateJob;
  at: number;
  attempts: number;
  retryAt: number;
  error: string | null;
}

const queue: Queued[] = [];
let draining: Promise<void> | null = null;
/** Tests: a fake model, and retries without the wait. */
let completeOverride: Complete | null = null;
let retryMs = RETRY_MS;

function remove(item: Queued): void {
  const at = queue.indexOf(item);
  if (at >= 0) queue.splice(at, 1);
  if (item.job.trigger === "landed" && item.job.taskId && !queue.some((other) => other.job.taskId === item.job.taskId)) landingsPending.delete(item.job.taskId);
}

/** Queues an update (unless the same change is queued already) and starts the queue. */
export function enqueue(job: UpdateJob): boolean {
  if (queue.some((item) => item.job.key === job.key)) return false;
  queue.push({ job, at: Date.now(), attempts: 0, retryAt: 0, error: null });
  if (job.trigger === "landed" && job.taskId) landingsPending.add(job.taskId);
  knowledgeChanged(job.projectId);
  void drain();
  return true;
}

/** Runs what's due, one at a time, until nothing is (a failed one waits for its retry). */
function drain(): Promise<void> {
  if (draining) return draining;
  draining = (async () => {
    for (let next = queue.find((item) => item.retryAt <= Date.now()); next; next = queue.find((item) => item.retryAt <= Date.now())) {
      const item = next;
      try {
        await runUpdate(item.job, completeOverride ?? defaultComplete);
        remove(item);
      } catch (err) {
        item.attempts++;
        item.error = scrub(errorText(err)).slice(0, 300);
        console.warn(`[tot] a knowledge update failed (try ${item.attempts} of ${MAX_ATTEMPTS}):`, item.error);
        if (item.attempts >= MAX_ATTEMPTS) {
          remove(item);
          knowledgeLog.record({
            projectId: item.job.projectId,
            trigger: item.job.trigger,
            repoName: item.job.repoName,
            taskId: item.job.taskId,
            sha: null,
            pages: [],
            facts: 0,
            summary: `Couldn't update after ${item.job.after}`,
            error: item.error,
          });
        } else {
          item.retryAt = Date.now() + retryMs * item.attempts;
        }
      }
      knowledgeChanged(item.job.projectId);
    }
  })().finally(() => {
    draining = null;
  });
  return draining;
}

/** Updates queued or running for a project, as rows for the log (newest first). */
export function pendingUpdates(projectId: string): KnowledgeUpdate[] {
  return queue
    .filter((item) => item.job.projectId === projectId)
    .reverse()
    .map((item) => ({
      id: `run:${item.job.key}`,
      projectId,
      trigger: item.job.trigger,
      repoName: item.job.repoName,
      taskId: item.job.taskId,
      at: item.at,
      sha: null,
      pages: [],
      facts: 0,
      summary: `Updating after ${item.job.after}`,
      error: item.error ? `Trying again soon: ${item.error}` : null,
      running: true,
      undoneAt: null,
    }));
}

// --- Wiring -----------------------------------------------------------------------------------------------------

let unsubscribe: (() => void) | null = null;
let timers: NodeJS.Timeout[] = [];
let watching = false;
/** Task id → the landing already seen (its `at`). */
const handled = new Map<string, number>();

/** The 6-hour check: every due repo, then their updates queued. */
async function watchTick(): Promise<void> {
  if (watching || !enabled()) return;
  watching = true;
  try {
    for (const job of await checkDue()) enqueue(job);
  } catch (err) {
    console.warn("[tot] checking project repos for new commits failed:", errorText(err));
  } finally {
    watching = false;
  }
}

export const knowledgeAuto = {
  /** Listens for landings, picks up any missed while TOT was off, and starts the 6-hour check. */
  start(): void {
    if (unsubscribe) return;
    const now = Date.now();
    for (const conversation of conversations.tasks()) {
      const landing = conversation.task?.landing;
      if (!landing) continue;
      handled.set(conversation.id, landing.at);
      // Landed in the last day with no update (TOT stopped first): it gets one now.
      if (enabled() && now - landing.at < CATCH_UP_MS && isTask(conversation) && !knowledgeLog.landedRun(conversation.id)) {
        const job = landedJob(conversation);
        if (job) enqueue(job);
      }
    }
    unsubscribe = appEvents.subscribe((event) => {
      if (event.type !== "task") return;
      const id = event.conversation.id;
      const landing = event.conversation.task?.landing;
      if (!landing || handled.get(id) === landing.at) return;
      handled.set(id, landing.at);
      // After the change that published this is done.
      queueMicrotask(() => {
        const task = taskStore.get(id);
        const job = task && enabled() ? landedJob(task) : null;
        if (job) enqueue(job);
      });
    });
    timers = [setInterval(() => void drain(), TICK_MS), setInterval(() => void watchTick(), WATCH_TICK_MS), setTimeout(() => void watchTick(), WATCH_FIRST_MS)];
    for (const timer of timers) timer.unref();
  },

  stop(): void {
    unsubscribe?.();
    unsubscribe = null;
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  },

  /** The log as the UI shows it: runs in progress first, then the last 50. */
  list(projectId: string): KnowledgeUpdate[] {
    return [...pendingUpdates(projectId), ...knowledgeLog.list(projectId)];
  },

  /** Check now: every repo of the project, at once; an update is queued for each that moved. */
  async refresh(project: Project): Promise<KnowledgeRefreshResult> {
    if (!enabled()) throw new HttpError(400, "Memory is off. Turn it on in Settings → Memory to keep project knowledge up to date.");
    const { checked, jobs, errors } = await checkProject(project, { manual: true });
    for (const job of jobs) enqueue(job);
    if (!jobs.length && errors.length && errors.length === checked) throw new HttpError(409, `Couldn't check for new commits: ${errors.join(" ")}`);
    return { checked, moved: jobs.length, updates: knowledgeAuto.list(project.id) };
  },

  /** Tests: the model updates use, and how long a failed one waits. */
  useComplete(complete: Complete | null, opts: { retryMs?: number } = {}): void {
    completeOverride = complete;
    retryMs = opts.retryMs ?? RETRY_MS;
  },

  /** Tests: runs what's due now and waits for it. */
  drain,

  /** Tests: the 6-hour check, now. */
  watchTick,
};
