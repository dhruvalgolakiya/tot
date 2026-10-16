import { randomUUID } from "node:crypto";
import type { GateName, Playbook, PlaybookInput, PlaybookMatch, PlaybookPatch, PlaybookStep, PlaybookStepKind } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { db, parseJson, type Row } from "../db.ts";
import { COMMAND_GATES } from "./gates.ts";
import { trustModel } from "./model.ts";
import { workflows } from "./settings.ts";

/**
 * Playbooks, in the spirit of pstack: a coding task is matched to one, and its
 * steps become the task's checklist before any work starts — each step a turn
 * with its own instructions, each followed by the checks that must pass. The
 * built-ins live here in code; the user can turn them off, duplicate and edit
 * them, or write their own (stored in the playbooks table).
 */

export const STEP_KINDS: PlaybookStepKind[] = ["understand", "reproduce", "plan", "approve-plan", "implement", "verify", "review", "fix-loop", "summarize", "custom"];
const GATES: GateName[] = [...COMMAND_GATES, "repro", "scope", "deps", "size", "review"];
const VERIFY_GATES: GateName[] = ["typecheck", "lint", "test", "build", "scope", "deps", "size"];

// ---------------------------------------------------------------------------
// Step instructions shared by the built-ins. Each is what the agent is told for that step.

const UNDERSTAND =
  "Read the task, then find the code it's about before deciding anything: search the repo (rg or grep) for the names, messages, routes and screens it mentions, and read those files and their tests. Note the files and functions involved with file:line. Don't change anything yet.";
const PLAN =
  "Write the plan: what you'll change and why, citing file:line for the code involved, and the exact path of every file you'll touch — check each one exists (git ls-files or ls); a plan that names a file that isn't there goes back to you. Say which tests will prove it works. Keep it to what the task needs.";
const APPROVE_PLAN = "Wait for the user's OK on the plan. If they ask for changes, update the plan and ask again; don't start implementing before they agree.";
const IMPLEMENT =
  "Make the changes the plan describes, and nothing else. Before using a function, method, type, option or flag, check it exists with that signature: grep for it or read its definition — never guess at an API. Follow the repo's conventions in its profile. If the plan turns out to be wrong, stop and say so instead of improvising.";
const VERIFY =
  "Run the repo's checks — typecheck, lint, the tests — and fix what this change broke. Checks that already failed on the base branch are listed for you and don't count against you. Don't skip, weaken or delete tests to get them to pass.";
const REVIEW = "An independent reviewer on the other provider reads the diff, the plan and the latest checks. Wait for its findings.";
const FIX_LOOP =
  "Fix every failing check and every must-fix finding from the review, then run the checks again. Answer should-fix findings by fixing them or saying briefly why not. Don't skip, weaken or delete tests.";
const SUMMARIZE =
  "Summarize for the user: what changed and why (with file:line), the evidence — the checks that ran and their results, the review's verdict — anything you couldn't do, and any follow-ups. Only claim what the checks showed.";

const step = (kind: PlaybookStepKind, instructions: string, extra: Partial<PlaybookStep> = {}, id: string = kind): PlaybookStep => ({ id, kind, instructions, ...extra });

export const BUILT_IN_PLAYBOOKS: Omit<Playbook, "enabled">[] = [
  {
    id: "bug-fix",
    name: "Bug fix",
    description: "Reproduce the bug with a failing test, fix the root cause, and prove the test passes.",
    match: ["bug", "fix", "crash", "broken", "error", "fail", "exception", "regression", "doesn't work", "not working", "wrong"],
    builtIn: true,
    steps: [
      step("understand", UNDERSTAND),
      step(
        "reproduce",
        "Prove the bug before fixing it: write a failing test (best) or a small script that shows the reported behaviour, and run it with the repo's one-file test command. Make sure it fails for the reason in the report, not because of a typo or setup. Note the exact command that runs it.",
        { gates: ["repro"] },
      ),
      step("plan", `${PLAN} Name the root cause, not just the symptom.`),
      step("approve-plan", APPROVE_PLAN),
      step("implement", IMPLEMENT),
      step("verify", `${VERIFY} The reproduction must pass now.`, { gates: [...VERIFY_GATES, "repro"] }),
      step("review", REVIEW, { gates: ["review"] }),
      step("fix-loop", FIX_LOOP),
      step("summarize", `${SUMMARIZE} Include the root cause and the reproduction failing before the fix and passing after.`),
    ],
  },
  {
    id: "feature",
    name: "Feature",
    description: "Plan it against the code, build it with tests, and have it checked and reviewed.",
    match: ["add", "feature", "implement", "build", "create", "support", "introduce", "allow", "enable"],
    builtIn: true,
    steps: [
      step("understand", UNDERSTAND),
      step("plan", PLAN),
      step("approve-plan", APPROVE_PLAN),
      step("implement", `${IMPLEMENT} Write tests for the new behaviour as you go, next to the existing tests and in their style.`),
      step("verify", VERIFY, { gates: VERIFY_GATES }),
      step("review", REVIEW, { gates: ["review"] }),
      step("fix-loop", FIX_LOOP),
      step("summarize", SUMMARIZE),
    ],
  },
  {
    id: "refactor",
    name: "Refactor",
    description: "Change the structure in small, checked commits without changing what the code does.",
    match: ["refactor", "clean up", "cleanup", "restructure", "rename", "extract", "simplify", "reorganize", "tidy", "split", "dedupe"],
    builtIn: true,
    steps: [
      step("understand", `${UNDERSTAND} Note which tests cover the code, and add tests first where behaviour isn't covered.`),
      step("plan", `${PLAN} Break it into small steps that each leave the code working.`),
      step(
        "implement",
        `${IMPLEMENT} Work in small commits, one plan step each, and run the tests after every commit. Behaviour must not change: no new features, no bug fixes mixed in — note those for later.`,
      ),
      step("verify", VERIFY, { gates: VERIFY_GATES }),
      step("review", `${REVIEW} It checks specifically that behaviour is unchanged.`, { gates: ["review"] }),
      step("fix-loop", FIX_LOOP),
      step("summarize", SUMMARIZE),
    ],
  },
  {
    id: "investigate",
    name: "Investigate",
    description: "Answer a question about the code with evidence. Changes nothing.",
    match: ["investigate", "why", "how does", "explain", "find out", "look into", "figure out", "where is", "what does", "diagnose"],
    builtIn: true,
    steps: [
      step("understand", `${UNDERSTAND} You may run read-only commands (tests, scripts, logs) to see behaviour; don't edit files.`, { gates: ["scope"] }),
      step(
        "summarize",
        "Answer the question with evidence: cite file:line for every claim, show the commands you ran and what they printed, and say plainly what you couldn't confirm. Nothing in the repo may change.",
        { gates: ["scope"] },
      ),
    ],
  },
  {
    id: "review-pr",
    name: "Review a PR",
    description: "Fetch a pull request's diff, review it independently, and summarize. Read-only.",
    match: ["review", "pull request", "pr", "code review"],
    builtIn: true,
    steps: [
      step(
        "understand",
        "Fetch the pull request without changing your working copy (gh pr diff, or git fetch and git diff), read its description and linked issue, and read the code around every change.",
        { gates: ["scope"] },
      ),
      step("review", REVIEW, { gates: ["review"] }),
      step("summarize", "Summarize the review for the user: the verdict, the must-fix findings with file:line, then the rest briefly.", { gates: ["scope"] }),
    ],
  },
];

/** Playbooks without implement or fix-loop steps change nothing: any diff fails their scope gate. */
export const isReadOnly = (playbook: Pick<Playbook, "steps">) => !playbook.steps.some((s) => s.kind === "implement" || s.kind === "fix-loop");

// ---------------------------------------------------------------------------
// Validation

const MAX_NAME = 60;
const MAX_DESCRIPTION = 300;
const MAX_INSTRUCTIONS = 4000;
const MAX_STEPS = 20;
const MAX_HINTS = 20;

function cleanSteps(value: unknown): PlaybookStep[] {
  if (!Array.isArray(value) || !value.length) throw new HttpError(400, "A playbook needs at least one step.");
  if (value.length > MAX_STEPS) throw new HttpError(400, `Keep a playbook to ${MAX_STEPS} steps or fewer.`);
  const ids = new Set<string>();
  const steps = value.map((raw: Partial<PlaybookStep>, index): PlaybookStep => {
    const n = index + 1;
    if (!raw || typeof raw !== "object" || !STEP_KINDS.includes(raw.kind as PlaybookStepKind)) throw new HttpError(400, `Step ${n} needs a kind: ${STEP_KINDS.join(", ")}.`);
    const instructions = typeof raw.instructions === "string" ? raw.instructions.trim() : "";
    if (!instructions) throw new HttpError(400, `Step ${n} needs instructions: what the agent should do.`);
    if (instructions.length > MAX_INSTRUCTIONS) throw new HttpError(400, `Step ${n}'s instructions are too long (at most ${MAX_INSTRUCTIONS} characters).`);
    if (raw.gates !== undefined && (!Array.isArray(raw.gates) || raw.gates.some((gate) => !GATES.includes(gate)))) {
      throw new HttpError(400, `Step ${n}'s checks are some of: ${GATES.join(", ")}.`);
    }
    const gates = [...new Set(raw.gates ?? [])];
    if (gates.includes("review") && raw.kind !== "review") throw new HttpError(400, `Only a review step can wait for the review (step ${n}).`);
    let id = typeof raw.id === "string" && /^[a-z0-9-]{1,40}$/.test(raw.id) ? raw.id : raw.kind!;
    for (let k = 2; ids.has(id); k++) id = `${raw.kind}-${k}`;
    ids.add(id);
    const cleaned: PlaybookStep = { id, kind: raw.kind!, instructions, ...(gates.length ? { gates } : {}) };
    if (raw.kind === "fix-loop" && raw.maxRounds !== undefined) {
      if (!Number.isInteger(raw.maxRounds) || raw.maxRounds < 1 || raw.maxRounds > 10) throw new HttpError(400, `Step ${n}'s max rounds must be a whole number from 1 to 10.`);
      cleaned.maxRounds = raw.maxRounds;
    }
    return cleaned;
  });
  steps.forEach((s, index) => {
    const before = steps.slice(0, index);
    if (s.kind === "approve-plan" && !before.some((b) => b.kind === "plan")) throw new HttpError(400, "Approving the plan needs a plan step before it.");
    if (s.kind === "fix-loop" && !before.some((b) => b.kind === "verify" || b.kind === "review")) {
      throw new HttpError(400, "A fix loop needs a verify or review step before it: something to fix.");
    }
  });
  return steps;
}

function cleanInput(input: Partial<PlaybookInput>, ownId: string | null): Omit<Playbook, "id" | "builtIn" | "enabled"> {
  const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > MAX_NAME) throw new HttpError(400, `Playbook names need 1–${MAX_NAME} characters.`);
  if (playbooks.list().some((p) => p.id !== ownId && p.name.toLowerCase() === name.toLowerCase())) throw new HttpError(400, `There's already a playbook called “${name}”.`);
  const description = typeof input.description === "string" ? input.description.replace(/\s+/g, " ").trim() : "";
  if (description.length > MAX_DESCRIPTION) throw new HttpError(400, `Keep the description under ${MAX_DESCRIPTION} characters.`);
  if (input.match !== undefined && !Array.isArray(input.match)) throw new HttpError(400, "Match hints must be a list of words.");
  const match = [
    ...new Set(
      (input.match ?? [])
        .filter((hint): hint is string => typeof hint === "string")
        .map((hint) => hint.trim().toLowerCase())
        .filter((hint) => hint.length >= 2 && hint.length <= 40),
    ),
  ];
  if (match.length > MAX_HINTS) throw new HttpError(400, `Keep it to ${MAX_HINTS} match hints or fewer.`);
  return { name, description, match, steps: cleanSteps(input.steps) };
}

// ---------------------------------------------------------------------------

function toPlaybook(row: Row): Playbook {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    match: parseJson<string[]>(row.match, []),
    steps: parseJson<PlaybookStep[]>(row.steps, []),
    builtIn: false,
    enabled: Boolean(row.enabled),
  };
}

export const playbooks = {
  /** Built-ins first, then custom playbooks by name. */
  list(): Playbook[] {
    const custom = (db.prepare(`SELECT * FROM playbooks ORDER BY name COLLATE NOCASE`).all() as Row[]).map(toPlaybook);
    return [...BUILT_IN_PLAYBOOKS.map((p) => ({ ...p, enabled: workflows.builtInEnabled(p.id) })), ...custom];
  },

  get(id: string): Playbook | null {
    return playbooks.list().find((p) => p.id === id) ?? null;
  },

  create(input: PlaybookInput): Playbook {
    const clean = cleanInput(input, null);
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
    const id = randomUUID();
    const now = Date.now();
    db.prepare(`INSERT INTO playbooks (id, name, description, match, steps, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      clean.name,
      clean.description,
      JSON.stringify(clean.match),
      JSON.stringify(clean.steps),
      input.enabled === false ? 0 : 1,
      now,
      now,
    );
    return playbooks.get(id)!;
  },

  update(id: string, patch: PlaybookPatch): Playbook {
    const current = playbooks.get(id);
    if (!current) throw new HttpError(404, "Playbook not found.");
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
    if (current.builtIn) {
      if (Object.keys(patch).some((key) => key !== "enabled")) throw new HttpError(400, "Built-in playbooks can't be edited. Duplicate one to make it your own.");
      if (patch.enabled !== undefined) workflows.setBuiltInEnabled(id, patch.enabled);
      return playbooks.get(id)!;
    }
    const clean = cleanInput({ ...current, ...patch }, id);
    db.prepare(`UPDATE playbooks SET name = ?, description = ?, match = ?, steps = ?, enabled = ?, updated_at = ? WHERE id = ?`).run(
      clean.name,
      clean.description,
      JSON.stringify(clean.match),
      JSON.stringify(clean.steps),
      (patch.enabled ?? current.enabled) ? 1 : 0,
      Date.now(),
      id,
    );
    return playbooks.get(id)!;
  },

  delete(id: string): void {
    const current = playbooks.get(id);
    if (!current) throw new HttpError(404, "Playbook not found.");
    if (current.builtIn) throw new HttpError(400, "Built-in playbooks can't be deleted. Turn it off instead.");
    db.prepare(`DELETE FROM playbooks WHERE id = ?`).run(id);
  },
};

// ---------------------------------------------------------------------------
// Matching a task to a playbook

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** How many of a playbook's hints a goal mentions, as whole words ("crash" also matches "crashes", "crashed"). */
export function hintScore(goal: string, hints: string[]): number {
  const text = goal.replace(/[‘’]/g, "'");
  return hints.filter((hint) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(hint)}(?:s|es|ed|d|ing)?(?![\\p{L}\\p{N}])`, "iu").test(text)).length;
}

/**
 * The playbook for a task: by its match hints when one playbook clearly leads, else by asking the fast
 * model to pick among the enabled ones, else the best hint match (or Feature) as a fallback.
 */
export async function matchPlaybook(goal: string): Promise<PlaybookMatch> {
  const text = goal.trim();
  if (!text) throw new HttpError(400, "Describe the task to match it to a playbook.");
  const enabled = playbooks.list().filter((p) => p.enabled);
  if (!enabled.length) throw new HttpError(400, "Every playbook is off. Turn one on in Settings → Workflows.");

  const scored = enabled.map((playbook) => ({ playbook, score: hintScore(text, playbook.match) })).sort((a, b) => b.score - a.score);
  if (scored[0].score > 0 && scored[0].score > (scored[1]?.score ?? 0)) return { playbook: scored[0].playbook, by: "hints" };

  try {
    const answer = await trustModel.ask({
      prompt: `Which playbook fits this coding task best? Reply with the playbook's id only.

Task: ${text.slice(0, 2000)}

Playbooks:
${enabled.map((p) => `- ${p.id}: ${p.name} — ${p.description}`).join("\n")}`,
      system: "You sort coding tasks into playbooks. Reply with one id from the list and nothing else.",
      heavy: false,
      timeoutMs: 60_000,
    });
    const picked = enabled.find((p) => new RegExp(`(?:^|[^\\w-])${escape(p.id)}(?![\\w-])`).test(answer.text));
    if (picked) return { playbook: picked, by: "classifier" };
  } catch (err) {
    console.warn("[tot] picking a playbook with the model failed:", err instanceof Error ? err.message : err);
  }
  const fallback = scored[0].score > 0 ? scored[0].playbook : (enabled.find((p) => p.id === "feature") ?? enabled[0]);
  return { playbook: fallback, by: "fallback" };
}
