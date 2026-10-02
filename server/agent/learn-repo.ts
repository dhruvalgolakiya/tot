import type { MessageStatus } from "../../shared/types.ts";
import { appEvents } from "../app-events.ts";
import { agents } from "../data/agents.ts";
import { conversations } from "../data/conversations.ts";
import { settings } from "../data/settings.ts";
import { wiki } from "../data/wiki.ts";
import { HttpError, sendMessage } from "./orchestrator.ts";
import { runRegistry } from "./runs.ts";

/**
 * "Learn a repo": a chat in which the agent clones a codebase onto its
 * computer, studies it, and writes it up in its workspace wiki (DeepWiki-style),
 * so later chats — e.g. one per ticket — start out knowing the code.
 *
 * Big repos don't fit in one turn, so the study runs in steps that TOT sends
 * one after another in the same chat, each with a fresh context:
 *   1. survey — clone, measure, split the code into areas, write a "Study plan" checklist page
 *   2. study  — repeated: take the next unchecked areas, read them properly, write a page each, tick them
 *   3. connect — architecture, data model, interfaces, config, run/test/deploy, playbooks, glossary, start-here page
 *   4. verify — check claims against the code, fill gaps, wrap up
 * The wiki is the only state carried between steps; TOT reads the checklist to decide what's next.
 * Learning the same repo again resumes an interrupted study, or re-studies only what changed.
 */

export const PLAN_TITLE = "Study plan";
/** Steps (model/tool calls) one study step may take; a step that runs out is simply picked up by the next. */
const STEP_LIMIT = 300;
/** Upper bound on study steps, however big the repo. */
const MAX_STUDY_STEPS = 80;
/** Give up after this many study steps in a row that ticked nothing, or failed. */
const MAX_STALLS = 2;

/** Repos being learned right now, by `${agentId}:${name}`, so two studies don't fight over one plan. */
const studying = new Set<string>();

/** "https://github.com/acme/web.git" → "web"; "~/repos/api/" → "api". Safe as a folder name. */
export function repoName(source: string): string {
  const last = source.replace(/[/\\]+$/, "").split(/[/:\\]/).pop() ?? "";
  return last.replace(/\.git$/i, "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "") || "repo";
}

export function validateRepoSource(source: unknown): string {
  const text = typeof source === "string" ? source.trim() : "";
  if (!text) throw new HttpError(400, "Enter a git URL or a folder on the agent's computer.");
  if (text.length > 500 || /[\r\n]/.test(text)) throw new HttpError(400, "That doesn't look like a repo URL or folder.");
  // Credentials belong in Settings → Connections, not in a URL that ends up in chats and the wiki.
  if (/^[a-z][a-z0-9+.-]*:\/\/(?!git@)[^/@\s]+@/i.test(text)) {
    throw new HttpError(400, "Leave the login out of the URL. Connect GitHub in Settings → Connections instead.");
  }
  return text;
}

/** Areas ticked and in total on a Study plan page ("- [x] …" / "- [ ] …" lines). */
export function planProgress(content: string): { done: number; total: number } {
  const boxes = content.match(/^\s*[-*] \[[ xX]\]/gm) ?? [];
  return { done: boxes.filter((box) => /\[[xX]\]/.test(box)).length, total: boxes.length };
}

/** The repo's start-here page (top level preferred) and its Study plan, if they exist. */
function findPages(agentId: string, name: string) {
  const root = wiki.withTitle(agentId, name, null)[0] ?? wiki.withTitle(agentId, name)[0] ?? null;
  const plan = root ? (wiki.withTitle(agentId, PLAN_TITLE, root.id)[0] ?? null) : null;
  return { root, plan };
}

function readPlan(agentId: string, name: string): { done: number; total: number; left: number } | null {
  const { plan } = findPages(agentId, name);
  if (!plan) return null;
  const progress = planProgress(plan.content);
  return progress.total ? { ...progress, left: progress.total - progress.done } : null;
}

// ---------------------------------------------------------------------------
// Instructions for each step. Each one stands alone: the step starts with a fresh context.

function layout(source: string, name: string): string {
  return `Repository: ${source}
Local copy: ~/repos/${name}
Wiki layout — everything nested under the top-level page “${name}” (always pass parent when you wiki_write):
- “${name}” — the start-here guide for any agent working on this repo
  - “${PLAN_TITLE}” — the checklist that carries this study from step to step
  - “Architecture” and the other cross-cutting pages
  - one page per area of the code (under group pages when there are more than ~10 areas)`;
}

const PLAN_FORMAT = `Commit: <short hash> <subject> (<date>)
## Areas
- [ ] <Area name> — <paths or globs> — <files>, ~<lines> lines — <what it seems to do>
(one line per area, in study order; keep every checkbox on one line in exactly this form — TOT reads it to run the next steps)
## Skipped
<paths not studied and why: generated, vendored, fixtures…>
## Open questions
<things later steps should find out>`;

const STEP_HEADER = (step: string) =>
  `[${step} TOT runs the steps of this study one after another, each with a fresh context, so the wiki is the only thing carried between them — write down everything a later step needs. Take your time: accuracy and coverage matter more than speed. Keep command output short (head, tail, wc, sort | uniq -c) and never copy secrets into the wiki.`;

function surveyStep(source: string, name: string): string {
  return `${STEP_HEADER("Learn a codebase into your wiki — step 1: survey the repo and plan the study.")}

${layout(source, name)}

1. Get the code onto your computer: clone it into ~/repos/${name} (for very big repos, git clone --filter=blob:none); if it's already there, pull the latest; if the source is a folder already on your computer, use it in place. If cloning fails because it's private, stop and tell the user to connect GitHub in Settings → Connections (or, if it's connected, that this account can't see the repo). Note the commit: git log -1 --format='%h %s (%cs)'.
2. Measure it before reading it:
   - tracked files and line counts per top-level and second-level directory, and languages by extension (git ls-files, wc -l)
   - manifests and workspaces (package.json and workspace files, go.mod, Cargo.toml, pyproject.toml, Gemfile, pom.xml/build.gradle, Makefile, Dockerfile, compose files) and CI config
   - entry points (servers, CLIs, apps, workers, route tables), where tests live, and generated or vendored directories to skip
   - churn hot spots: git log --since=1.year --name-only --format= | sort | uniq -c | sort -rn | head -40
3. Read the docs that explain intent: README files, docs/, architecture notes and ADRs, AGENTS.md, CLAUDE.md, .cursorrules, CONTRIBUTING.
4. Split the code into areas: coherent units (a package, service, feature or layer), each small enough to study properly in one step — roughly up to 40 source files or ~8,000 lines; split bigger ones, merge tiny ones. A small repo may have 3–5 areas, a big monorepo 30 or more. Cover all real code; skip generated, vendored and fixture files. Order them core first.
5. Write these pages now (not the area pages yet):
   - “${name}” at the top level: a first draft — what it is, the stack, where it lives on your computer, the commit, and the planned page map. Summary: one line on what the repo is.
   - “${PLAN_TITLE}” under “${name}”, summary “What has been studied of ${name} so far”, in exactly this format:
${PLAN_FORMAT}
   - “Architecture” under “${name}”: a first sketch from what you've seen — the main parts and a \`\`\`mermaid diagram. Later steps refine it.
6. Reply in a few lines: how big the repo is, how many areas you planned, and that TOT will now study them one by one.]`;
}

function updateStep(source: string, name: string): string {
  return `${STEP_HEADER("Learn a codebase into your wiki — step 1: this repo was studied before; bring the study plan up to date.")}

${layout(source, name)}

1. wiki_read “${name}” and its “${PLAN_TITLE}”.
2. Get the latest code (pull in ~/repos/${name}, or clone it again if it's missing; if the source is a folder on your computer, use it in place). Compare with the commit in the plan: git diff --stat <old>..HEAD | tail -80. If that commit is gone, treat every area as changed.
3. Update “${PLAN_TITLE}” (keep its exact format):
   - set the Commit line to the new commit
   - keep areas an earlier, interrupted study didn't finish unchecked
   - uncheck (- [ ]) every area whose code changed in a way that matters, and drop its " → page" note
   - add areas for new code, split areas that grew too big, and remove areas whose code is gone (delete their pages)
4. If nothing meaningful changed and every area is still ticked, update the commit on “${name}” and say so — the study is done.
5. Reply in a few lines: what changed and how many areas will be studied.]`;
}

function missingPlanStep(name: string): string {
  return `[The “${PLAN_TITLE}” page under “${name}” is missing or has no checklist, and the rest of the study depends on it. Write it now with wiki_write (parent “${name}”) in exactly this format, then reply in one line:
${PLAN_FORMAT}]`;
}

function studyStep(source: string, name: string): string {
  return `${STEP_HEADER("Learn a codebase into your wiki — next step: study the next areas in depth.")}

${layout(source, name)}

1. wiki_read “${PLAN_TITLE}”, “Architecture” and “${name}”, so you know the plan, the page names and what's known so far.
2. Take the first unchecked area — or up to 3 if they're small — and study it properly, not by skimming:
   - list its files with line counts; read its entry points, public interfaces, core types and its biggest or most-changed files in full (computer_read_file, or sed -n ranges for huge files); skim the rest
   - find how it connects: search the repo (rg, or grep -rn) for its exports and imports to see who uses it and what it depends on
   - read its tests for the intended behavior and edge cases
   - follow one or two real flows through it end to end (a request, a job, a command)
3. Write one page per area with wiki_write (parent “${name}”, or a group page under it when there are many areas), with a one-line summary and this layout — leave out a section only when it truly doesn't apply:
   # <Area>
   What it's for and where it sits in the system (one paragraph).
   ## Key files — \`path\` — role, for every important file
   ## Main types & functions — exact names, signatures, what they do
   ## How it works — the flows step by step with file and function references; a \`\`\`mermaid diagram when a flow is worth drawing
   ## Data — models, schemas, tables, state and caches it owns
   ## Interfaces — routes, commands, events and exports other areas use
   ## Depends on / used by — other areas, by page title
   ## Config — env vars and settings it reads (names only)
   ## Tests — where they are and how to run just these
   ## Changing it safely — how to make the usual changes here, invariants, pitfalls
   _Studied at <commit>_
   Every fact must come from code you read: cite paths, copy identifiers exactly, don't guess. When unsure, say so and add it to Open questions.
4. Tick each area you finished in “${PLAN_TITLE}” with wiki_edit: change its "- [ ]" to "- [x]" and append " → <page title>". Add what you couldn't resolve under Open questions, and answer earlier ones you now can. If you learned something that changes the big picture, fix “Architecture”.
5. Reply in one or two lines: the areas you covered and how many are left.]`;
}

function connectStep(source: string, name: string): string {
  return `${STEP_HEADER("Learn a codebase into your wiki — next step: every area has a page; now write the pages that tie them together.")}

${layout(source, name)}

1. wiki_read “${PLAN_TITLE}”, “${name}”, “Architecture” and every area page under “${name}” (wiki_search with no query lists them all).
2. Write or update each of these with parent “${name}”, grounded in the area pages — check the code wherever they're vague or disagree — and cite paths:
   - “Architecture”: the system as a whole — components and their responsibilities, a \`\`\`mermaid component diagram, and sequence diagrams for the 2–4 most important flows (a request, a background job, a deploy…), linking area pages by title.
   - “Data model”: entities, tables or schemas and how they relate (a mermaid erDiagram when it helps), where each is defined and migrated.
   - “Interfaces”: the public surface — HTTP/RPC routes, CLI commands, events and queues, SDK exports — each with where it's handled.
   - “Configuration”: every env var and config file — name, purpose, default, where it's read (names only, never values).
   - “Run, test & deploy”: setup from a clean machine, and exact commands to run, test (everything, one file, one test), lint, build and deploy; the CI pipeline.
   - “Conventions & gotchas”: code style, patterns to copy, error handling, logging, naming, and the pitfalls found while studying.
   - “Playbooks”: step-by-step recipes for the changes people make most (add an endpoint, a table and migration, a screen, a job…), each pointing at a real example in the code.
   - “Glossary”: domain and project terms and what they mean in this code.
   Leave out a page only when it truly doesn't apply (say, a data model for a stateless CLI).
3. Rewrite “${name}” as the start-here guide for any agent about to work on this repo: what it is and who uses it, the stack, where it lives (~/repos/${name}), the commit studied, a page map (every sub-page with one line), and a "Where to look" table — task or concept → page → key paths.
4. Add or update one line about this repo on the Overview page: what it is, where it lives on your computer, and that “${name}” is its start-here page in the wiki.
5. Reply in one or two lines.]`;
}

function verifyStep(source: string, name: string): string {
  return `${STEP_HEADER("Learn a codebase into your wiki — last step: check the pages against the code, so other agents can trust them.")}

${layout(source, name)}

1. wiki_read “${name}” and “${PLAN_TITLE}”, then go through every page under “${name}”.
2. Check at least 40 concrete claims across the pages — file paths, function and type names, commands, env var names, routes — against the code (ls, rg or grep, the manifests). Fix every wrong or stale one with wiki_edit; remove what you can't support.
3. Fill the gaps: answer what's left under Open questions where you can, and compare git ls-files with the pages for important files or directories no page mentions — add them where they belong.
4. Make sure every page has a one-line summary, links related pages by title, and ends with “_Studied at <commit>_”. Split any page longer than ~15,000 characters.
5. In “${PLAN_TITLE}”, add “Status: complete at <commit>” under the Commit line, and list known gaps.
6. Reply to the user with a short summary: the pages written (a short list), how much of the repo they cover, notable findings, and known gaps.]`;
}

// ---------------------------------------------------------------------------

/** Resolves with how a run ended. */
function runEnd(runId: string): Promise<MessageStatus> {
  const run = runRegistry.get(runId);
  if (!run) return Promise.resolve("error");
  return new Promise((resolve) => {
    run.subscribe((_seq, event) => {
      if (event.type === "run-end") resolve(event.status);
    });
  });
}

async function step(conversationId: string, text: string, preamble: string, heavy: string): Promise<MessageStatus> {
  const { runId } = await sendMessage(conversationId, { text }, { preamble, keepTitle: true, heavy, freshSession: true, maxSteps: STEP_LIMIT });
  return runEnd(runId);
}

/** Runs the steps after the survey until the plan is done, the user stops a step, or it stops making progress. */
async function continueStudy(agentId: string, conversationId: string, source: string, name: string, updating: boolean, survey: string) {
  if ((await runEnd(survey)) === "stopped") return;

  let plan = readPlan(agentId, name);
  if (!plan) {
    if ((await step(conversationId, `Write the study plan for ${name}.`, missingPlanStep(name), "planning a codebase study")) === "stopped") return;
    plan = readPlan(agentId, name);
    if (!plan) return;
  }
  // A re-learn where nothing changed is already done.
  if (updating && plan.left === 0) return;

  let stalls = 0;
  for (let i = 0; i < MAX_STUDY_STEPS && plan.left > 0 && stalls < MAX_STALLS; i++) {
    const before = plan.done;
    const status = await step(
      conversationId,
      `Study the next part of ${name} (${plan.done} of ${plan.total} areas done).`,
      studyStep(source, name),
      "studying a codebase",
    );
    if (status === "stopped") return;
    plan = readPlan(agentId, name) ?? plan;
    stalls = plan.done > before ? 0 : stalls + 1;
  }
  if (plan.done === 0) return;

  if ((await step(conversationId, `Tie the ${name} pages together.`, connectStep(source, name), "writing up a codebase")) === "stopped") return;
  await step(conversationId, `Check the ${name} pages against the code and wrap up.`, verifyStep(source, name), "checking a codebase write-up");
}

export async function learnRepo(agentId: string, source: string): Promise<{ conversationId: string; runId: string }> {
  const agent = agents.get(agentId);
  if (!agent) throw new HttpError(404, "Agent not found.");
  if (settings.get().computer.mode === "off") {
    throw new HttpError(400, `${agent.name} needs a computer to study code. Turn one on in Settings → Computer.`);
  }
  if (!settings.get().memory.enabled) throw new HttpError(400, "The wiki is off. Turn on Memory in Settings → General.");
  const name = repoName(source);
  const key = `${agent.id}:${name.toLowerCase()}`;
  if (studying.has(key)) throw new HttpError(409, `${agent.name} is already learning ${name}. Follow along in its chat.`);

  const { root, plan } = findPages(agent.id, name);
  const updating = Boolean(root && plan);
  const conversation = conversations.create({ agentId: agent.id, modelId: agent.modelId, title: `Learn ${name}` });
  appEvents.agentChanged(agent.id);
  const { runId } = await sendMessage(
    conversation.id,
    { text: updating ? `Update what you know about ${source} in the wiki.` : `Learn ${source} and write it up in the wiki.` },
    {
      preamble: updating ? updateStep(source, name) : surveyStep(source, name),
      keepTitle: true,
      heavy: "studying a codebase",
      maxSteps: STEP_LIMIT,
    },
  );

  studying.add(key);
  continueStudy(agent.id, conversation.id, source, name, updating, runId)
    // A step can't start when the user is chatting there or the model is unavailable; the chat shows where it stopped.
    .catch((err) => console.warn(`[tot] learning ${name} stopped:`, err instanceof Error ? err.message : err))
    .finally(() => studying.delete(key));
  return { conversationId: conversation.id, runId };
}
