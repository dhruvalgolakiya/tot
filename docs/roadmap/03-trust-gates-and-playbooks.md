# 03 · Trust gates & playbooks

**Lane:** worktree B, branch `feat/trust`. **Depends on:** nothing for M1–M4, which are built as standalone services. M5 wires them into tasks after 01 is merged: rebase on `main` first.

Read [README.md](README.md) first.

## Goal

Coding work you can trust in a big codebase, from start to finish. The agent:

- follows a known **playbook**;
- proves its work with **the repo's own checks**;
- gets an **independent review** from a fresh model, on the other provider by default;
- stays **inside agreed limits**: planned files, no protected paths, no surprise dependencies, a sane diff size.

By the time you see a PR, the evidence is attached. The model is poteto's pstack:

- a task is matched to a playbook;
- the playbook becomes the checklist before any work starts;
- each step runs its skills;
- behaviour is verified at runtime, because a green build alone isn't proof.

See [pstack explained](https://hustlecoding.github.io/pstack-explained/).

## Concepts

- **Repo profile:** what "correct" means for one repo. Stored per repo brain, editable by the user, drafted automatically.

  ```ts
  interface RepoProfile {
    brainId: string;               // the repo's brain (Learn a repo creates it)
    commands: {                    // run in the task's worktree on the agent's computer; empty = not used
      install?: string;            // e.g. "npm ci"
      typecheck?: string;          // e.g. "npx tsc --noEmit"
      lint?: string;
      test?: string;               // the full suite
      testFile?: string;           // e.g. "npx vitest run {file}"
      build?: string;
      e2e?: string;
    };
    conventions: string[];         // short rules, e.g. "Use the Result type for errors, never throw in handlers"
    protectedPaths: string[];      // globs agents must not change without asking, e.g. "migrations/**", ".github/**"
    definitionOfDone: string[];    // e.g. "Tests for new behaviour", "Docs updated for public APIs"
    limits: { maxChangedLines: number; maxChangedFiles: number; allowNewDependencies: boolean };
    updatedAt: number;
    updatedBy: "agent" | "user";
  }
  ```

- **Gate:** a check with a pass/fail result.
  - *Hard* gates block the next step: commands must pass, and protected paths must be untouched unless approved.
  - *Soft* gates ask the user: a diff over the limit, a new dependency, files outside the plan.

  ```ts
  interface GateResult {
    gate: "typecheck" | "lint" | "test" | "build" | "e2e" | "repro" | "scope" | "deps" | "size" | "review";
    status: "pass" | "fail" | "skipped" | "needs-approval";
    command?: string;
    exitCode?: number;
    outputTail?: string;           // last ~4 KB, secrets scrubbed
    baseline?: "pass" | "fail";    // the same check on the base branch: failures that already existed don't block
    durationMs?: number;
    note?: string;
  }
  interface GateReport { ok: boolean; results: GateResult[]; at: number; headSha: string | null }
  ```

- **Review:** an independent verdict on a diff.

  ```ts
  interface Review {
    verdict: "approve" | "changes-requested";
    findings: { file: string; line?: number; severity: "must-fix" | "should-fix" | "nit"; issue: string; suggestion?: string }[];
    summary: string;
    reviewer: { provider: ProviderId; model: string };
  }
  ```

- **Playbook:** an ordered list of steps with gates. Built-ins, editable copies, and custom playbooks.

  ```ts
  interface Playbook {
    id: string; name: string; description: string;
    match: string[];               // hints for automatic choice: "bug", "fix", "crash", "feature", "refactor"…
    steps: PlaybookStep[];
    builtIn: boolean; enabled: boolean;
  }
  interface PlaybookStep {
    id: string;
    kind: "understand" | "reproduce" | "plan" | "approve-plan" | "implement" | "verify" | "review" | "fix-loop" | "summarize" | "custom";
    instructions: string;          // what the agent is told for this step
    role?: Role; tier?: Tier;      // used when 02 is present; otherwise the task's own session runs it
    gates?: GateResult["gate"][];  // checks that must pass after the step
    maxRounds?: number;            // for fix-loop
  }
  ```

  Built-in playbooks:
  - **Bug fix:** understand → reproduce (a failing test or script; hard gate `repro`) → plan, citing file:line → *approve plan* (optional, Settings) → implement → verify (typecheck, lint, test; `repro` now passes) → review → fix-loop (≤ 3 rounds) → summarize.
  - **Feature:** understand → plan → approve plan → implement with tests → verify → review → fix-loop → summarize.
  - **Refactor:** understand → plan → implement in small commits → verify after each → review, checking that behaviour is unchanged → summarize.
  - **Investigate:** understand → answer with evidence (file:line, commands run). No code changes; the scope gate fails on any diff.
  - **Review a PR:** fetch the diff → review → summarize. Read-only.

## Anti-hallucination rules (enforced, not just prompted)

- **Plans cite code.** Every planned change names real paths, and preferably lines. The `plan` step's output is checked: every cited path must exist in the worktree (`git ls-files`). Unknown paths fail the step, and the agent is asked to fix the plan.
- **Look before using.** The implement step's prompt requires checking that a symbol or API exists (grep or read) before using it. The reviewer checks for invented APIs specifically: its prompt carries an explicit "invented or misused APIs" checklist item.
- **Scope gate.** After implement:
  - changed files are compared with the plan's files; extra files need a reason in the summary, or user approval;
  - `protectedPaths` changes need approval;
  - new dependencies (manifest or lockfile changes) need approval if `allowNewDependencies` is false;
  - diff size is checked against the limits.
- **No green-washing.** Gates run the real commands; the agent's word that tests pass doesn't count. A test step that deleted or skipped tests (`.skip`, `xit`, commented out, removed files) is flagged by a diff scan and fails `test` unless approved.
- **Baseline first.** Gates run once on the base branch at the start of a task (cached by base sha), so failures that already existed don't block, and so the agent is told about them.

## Server design (`server/trust/`)

- **`profile.ts`.**
  - Stored in a new `repo_profiles` table, plus a rendered "Repo profile" page in the repo brain so agents read it in context.
  - `draftProfile(brainId)` runs a short agent turn on the repo (or parses Learn a repo's run/test/deploy page) and returns a profile to confirm.
  - Learn a repo's "connect" step should call it at the end; that's a small hook in `server/agent/learn-repo.ts`.
- **`gates.ts`.**
  - `runGates({ agentId, cwd, profile, gates, baseRef })` returns a `GateReport`.
  - Commands run through the agent's computer (the same exec path as the `computer_exec` tool), each with a timeout from the profile (default 10 min) and output clipped and scrubbed (`redactGitHubTokens` and friends).
  - Baseline cached by `(brainId, baseSha, gate)`.
- **`scope.ts`.** `checkScope({ cwd, baseRef, plan, profile })` returns scope, deps and size results. Uses `git diff --numstat` and `--name-status` plus a manifest/lockfile list (package.json, lockfiles, pyproject, go.mod, Cargo.toml, Gemfile…), and the skipped-test scan.
- **`review.ts`.**
  - `reviewDiff({ agentId, cwd, baseRef, plan, profile, implementedBy })` returns a `Review`.
  - Runs a **fresh session with no shared transcript** on the other provider from `implementedBy`, unless the user picked a fixed reviewer.
  - Input: the plan, the diff (chunked when big), profile conventions and the latest gate report.
  - Output: structured JSON, validated; it's reasked once on invalid output.
  - Reuse provider plumbing via `sendMessage` on a hidden internal conversation (`kind: "task"` once 01 lands; a hidden chat before that), or a smaller direct provider call if one exists. Don't fork the provider code.
- **`playbooks.ts`.** Built-in definitions in code, user copies and custom playbooks in a `playbooks` table, and `matchPlaybook(goal, repo)`, which uses the `match` hints first and the fast-tier classifier second.
- **`engine.ts`** (M5): drives a task through its playbook steps.
  - Each step is a turn with the step's instructions; `freshSession` between steps, with the plan, progress and last gate report carried forward, the same way `learn-repo.ts` carries state.
  - After each step, its gates run; failures feed back into a fix turn (up to `maxRounds`) and then escalate to the user as `needs-input` with the failing output.
  - **Approve plan** is an approval card (reuse `server/agent/approvals.ts`) that shows the plan.
  - **Routes:** `server/trust/routes.ts`, mounted with one line:
    - `GET/PUT /api/brains/:id/profile`;
    - `POST /api/brains/:id/profile/draft`;
    - `GET/POST/PATCH/DELETE /api/playbooks`;
    - **dev only until M5:** `POST /api/trust/check { agentId, cwd, baseRef }` → `GateReport`, and `POST /api/trust/review { agentId, cwd, baseRef, plan? }` → `Review`. These let you exercise the services on any folder on the agent's computer before tasks exist.
    - **after M5:** `POST /api/tasks/:id/checks` (re-run gates) and `GET /api/tasks/:id/checks`.

## UI (`src/components/trust/`)

- **Repo profile editor:**
  - In the brain's settings (`BrainSettingsDialog.tsx`, or a "Profile" tab on a repo brain).
  - Command fields, each with a "Run now" test button that runs it on the agent's computer and shows the output tail.
  - Conventions and definition-of-done as editable lists; protected paths as chips; limits.
  - "Draft from code" button.
- **Settings → Workflows:**
  - The playbook list (name, description, steps as a compact stepper) with on/off toggles.
  - "Duplicate & edit" for built-ins; an editor for custom playbooks (steps as rows: kind via `Select`, instructions text, gates as chips, max rounds).
  - Defaults:
    - "Require my OK on plans" (on/off);
    - default reviewer: other provider / Claude / ChatGPT;
    - max fix rounds.
- **Checks tab** (M5, inside 01's task side panel):
  - A vertical timeline of playbook steps with status.
  - Under each, its gate results: name, pass/fail pill, duration, and output tail on expand.
  - The review card: verdict, findings grouped by severity, each with file:line.
  - Needs-approval items show **Approve / Reject** inline.
- **Before M5,** build the GateReport and Review components so they render from the dev routes, e.g. in a hidden dev page or Storybook-style fixture, so the UI is ready when tasks land.

## Milestones

- [x] **M1 · Repo profile.**
  - Table, routes, draft from code (and the Learn a repo hook), the editor UI with "Run now" per command, and the rendered brain page.
  - *Accept:* Learn a repo on a real-shaped fixture repo yields a correct draft profile (commands, protected paths); edits persist and show in the brain.
  - *Shipped:* `server/trust/profile.ts` drafts commands from the repo's own manifests (npm/pnpm/yarn/bun, Python, Go, Rust, Ruby, Makefile) and protected paths from its file tree; a light model only adds conventions, definition of done and missing commands from Learn a repo's notes. Brain menu → "Repo profile…" edits it, with Run now per command; it renders as the brain's "Repo profile" page.
- [x] **M2 · Gates.**
  - `runGates` with baseline caching, `checkScope` (scope, deps, size, skipped tests), the dev route, and the GateReport component.
  - *Accept:* on a temp repo with a failing test on base and a new failure on a branch, only the new failure blocks; adding a dependency is flagged needs-approval; `.skip` is caught.
  - *Shipped:* `server/trust/gates.ts` reruns a failing command on the base commit in a throwaway worktree (cached by commit) and blocks only on failure lines the base doesn't have; `server/trust/scope.ts` checks plan files, protected paths, dependencies (package.json by name), size and skipped/commented/deleted tests. `POST /api/trust/check` and the Checks lab at `/dev/trust` (with samples) render the GateReport.
- [ ] **M3 · Independent review.**
  - `reviewDiff` on the other provider, structured findings, the dev route, and the Review component.
  - *Accept:* on a fixture diff that calls a non-existent function and has an off-by-one, the review returns `changes-requested` with both as must-fix (asserted with a fake provider returning the structured JSON, plus one manual run with a real provider recorded in this doc).
- [ ] **M4 · Playbooks.**
  - Built-ins, the custom-playbook table, `matchPlaybook`, and Settings → Workflows.
  - *Accept:* "the checkout page crashes when the cart is empty" matches Bug fix, and "add CSV export" matches Feature; a duplicated playbook can be edited and saved.
- [ ] **M5 · Engine plus task integration** (after 01 is on `main`).
  - Tasks run their playbook; gates after each step; the fix-loop; plan approval; the Checks tab; `needs-input` escalation.
  - *Accept:* a Bug fix task on a fixture repo reproduces the bug with a failing test, fixes it, passes gates, gets an approving review, and ends with a summary that links the evidence. A task that changes a protected path stops for approval.

## Tests

`server/trust.test.ts`, first import `./test-data-dir.ts`. Cover:

- **Gates and scope:** baseline vs branch, and every scope/deps/size/skipped-test rule, against temporary git repos through the local computer backend.
- **Profile:** round-trip.
- **Playbooks:** matching, and validating custom playbooks.
- **Reviewer:** JSON validation and the re-ask, with a fake provider.
- **Engine (M5):** step order, the fix-loop limit, and escalation, with a fake sender.

## Out of scope

Pushing and PRs (04). Choosing reviewer and implementer models beyond "the other provider" (02's tiers).

## Open questions

- Should profile commands run with network access on local computers? Today's Seatbelt sandbox allows outbound traffic except TOT's own ports. Proposal: keep it, since installs need it.
- Should the plan-approval step default to on for big repos (more than 2,000 files) and off for small ones? Proposal: one setting, default on.
