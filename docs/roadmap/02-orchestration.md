# 02 · Orchestration: auto-spawn, model tiers, handoff, failover

**Lane:** worktree A, branch `feat/orchestration`, created from `main` **after 01 is merged**. **Depends on:** 01 (task sessions, `task_start`, the run loop, the queue).

Read [README.md](README.md) first.

> **Changed since (2026-10-03):** the composer's Auto / Inline / Task menu, the dispatcher (`dispatch.ts`: rules, then a classifier) and the decision chip were removed. Every message, whether typed in TOT, sent from Slack or emailed, goes to the chat's model. The model starts tasks itself with `task_start` / `task_spawn_many`, passes follow-ups to running tasks with `task_message`, and keeps the plan for bigger work in a markdown file. Tiers, roles, handoffs, failover and fan-in are unchanged. The dispatch parts below (M2, the composer pill, the chip) describe what was built then.

## Goal

TOT decides how to run each request, so the user doesn't have to.

- **Answer inline:** quick questions and small edits stay in the chat.
- **Continue the task:** follow-ups to running work go to that task.
- **Spawn one or more sessions,** each with a **role** and the right **model tier**: e.g. a fast model for searching, the strongest model for the hard change, and the other provider for review.

Work moves between providers through a **handoff packet**, so a task can:

- continue on ChatGPT when Claude hits its usage limit (and the other way round);
- be reviewed by a different model with fresh context.

This works for non-coding work too. Research fans out to parallel searchers, then a writer, then a fact-checker.

## Concepts

- **Tier:** `fast`, `standard` or `deep`. Settings → Models maps each tier to a model per provider, using ids from the existing model list. Defaults:

  | Tier | Claude | ChatGPT |
  |------|--------|---------|
  | fast | Sonnet 5.5, effort low | the cheapest current GPT (e.g. GPT‑6 Luna) |
  | standard | Sonnet 5.5, effort high | GPT‑6 Sol |
  | deep | Opus 5.5, effort high (xhigh with "think harder") | the strongest GPT (e.g. GPT‑6.1 Sol) |

  Read the actual ids from the models list; don't hard-code them. `server/agent/router.ts` already has a two-level version of this (quick → Sonnet, complex → Opus). Turn it into tiers rather than adding a second router.
- **Role:** what a session is for. Each role has a default tier and a default provider preference:
  - `explorer`: fast. Reads code and docs, answers "where/how".
  - `planner`: deep. Writes the plan.
  - `implementer`: deep. Makes the change in the task's worktree.
  - `tester`: standard. Writes and runs tests.
  - `reviewer`: deep, **on the other provider** from the implementer.
  - `researcher`: fast/standard (non-coding).
  - `writer`: standard. Combines results into one answer.
- **Dispatch decision,** made for each user message (and each emailed or Slack request):

  ```ts
  type Dispatch =
    | { mode: "inline"; tier: Tier; reason: string }
    | { mode: "continue-task"; taskId: string; reason: string }
    | { mode: "spawn"; sessions: { role: Role; title: string; goal: string; tier: Tier; provider?: ProviderId; repo?: string }[]; then?: "synthesize"; reason: string };
  ```

- **Brief** (passed into a child) and **Result** (passed back up):
  - Children never get the parent's whole transcript. They get a brief: the goal, constraints, relevant brain pages and files, and what "done" means.
  - They return a result: summary, findings, files changed, open questions, and confidence.
- **Handoff packet:** everything another session or provider needs to continue, without the transcript:

  ```ts
  interface HandoffPacket {
    goal: string;
    doneSoFar: string[];          // concise, factual
    decisions: { decision: string; why: string }[];
    plan: { text: string; done: boolean }[];
    files: { path: string; change: string }[];
    repo?: { branch: string; headSha: string; worktree: string };
    tests: { command: string; status: "pass" | "fail" | "not-run"; note?: string }[];
    openQuestions: string[];
    nextStep: string;
    from: { provider: ProviderId; model: string };
    createdAt: number;
  }
  ```

  The current model writes it (a short structured-output turn) at four moments: a provider switch, a pause, a task finishing, and before failover. It's stored on the task and shown in the task view as "Handoff", collapsible.

## Server design (`server/orchestration/`)

- **`dispatch.ts`.**
  - **Cheap first:** apply rules (`assessComplexity`, a repo/brain mentioned, the attachments, an explicit composer choice).
  - **Then a classifier** with structured JSON output, only when the rules aren't sure. It runs on the fast tier (Sonnet 5.5, effort low) with a short prompt that gets the user text, the chat's running tasks and the agent's repo brains.
  - **The user can always override:** the composer has Auto / Inline / Task (01 already added "Run as task"; extend it to a three-way choice).
  - **Recorded:** the decision and its reason go into the user message's metadata and show as a chip: "Auto · spawned 2 tasks: explorer (Sonnet), implementer (Opus)".
  - **Safe default:** if the classifier fails or times out (2 s), fall back to `inline`.
  - Replaces 01's keyword-only intake rule for Slack and email.
- **`tiers.ts`.** Tier → { provider, model, effort }, reading Settings and respecting `limits.ts` cooldowns. `router.ts` calls this instead of picking models directly.
- **`spawn.ts`.**
  - Extends 01's `task_start` with `role`, `tier`, `provider` and `brief`.
  - Adds `task_spawn_many` for fan-out.
  - **Depth limit:** 2 levels below the user's chat.
  - **Limits per parent:** at most 6 children; a per-mission token budget (Settings → Tasks).
  - **Fan-in:** when all children with `then: "synthesize"` finish, the parent gets one `writer` turn with their results. Results go in as structured parts, not pasted transcripts.
- **`handoff.ts`.**
  - `writeHandoff(taskId)` produces the packet (structured output, then validated).
  - `continueOn(taskId, provider)` starts a fresh provider session on the task with the packet in the preamble (`TurnOptions.freshSession`), and records the switch as a notice part.
- **`failover.ts`.**
  - **Today:** when a turn fails with a usage limit, `limits.ts` records a cooldown and Auto avoids that provider for *new* turns.
  - **With this:** a *running task* that hits the limit writes a handoff and continues on the other provider. That only happens if Settings → Tasks → "Switch providers when one hits its limit" is on (default on) and the other provider is signed in. Otherwise the task goes `paused` with "Claude limit until 7:30am", and resumes by itself when the cooldown ends.
- **Agent tools:**
  - `task_spawn_many`.
  - `handoff_write` for the agent's own checkpoints.
  - A prompt section telling the parent agent when to fan out: independent sub-questions, a search across many files or sources, or work bigger than one sitting. It also says when *not* to: small or sequential work, or when the user is mid-conversation.

## UI

- **Composer:** an Auto / Inline / Task segmented control. Keep it subtle, as a small pill next to the model picker, and remember the last choice per chat.
- **Decision chip** on the user message: "Auto → 2 tasks". Hovering explains why.
- **Task tree:**
  - In the parent chat, task cards for children can stack into a group card ("3 tasks · 2 running").
  - In the sidebar, children nest under their parent task, indented one step.
  - Keep it collapsible and quiet.
- **Task view:**
  - A **Handoff** section in the Plan tab.
  - A role/tier/provider line in the header, e.g. "implementer · deep · Opus 5.5".
  - "Continue on ChatGPT / Claude" in the "…" menu.
- **Settings → Models:** the tier table (a Select per tier per provider), and the default tier for each role.
- **Settings → Tasks:** the provider-switching option, the token budget per mission, and the max children per task.

## Milestones

- [x] **M1 · Tiers and roles.** Shipped: `server/orchestration/tiers.ts` (defaults read from each account's models), the router now tier-based, Settings → Models tier table and role tiers, `task_start` with role/tier/provider and a brief, structured results from `task_finish`, shown on cards and in the Plan tab.
  - `tiers.ts`; the router uses tiers; Settings → Models tier table; `task_start` takes `role` and `tier`; briefs and structured results.
  - *Accept:* an explorer child runs on the fast tier and returns a structured result; the parent shows it as a card, not a transcript dump.
- [x] **M2 · Automatic dispatch.** Shipped: `server/orchestration/dispatch.ts` (rules, then a 2 s fast-tier classifier, else inline), the Auto / Inline / Task pill (remembered per chat), the decision chip, and Slack/email intake through the dispatcher. The fixture table routes 36/36.
  - Rules plus classifier; the composer override; the decision chip; Slack and email intake use the dispatcher.
  - *Accept:* a fixture table of at least 30 prompts (quick question, small edit, "fix bug X in repo Y", "compare 4 vendors", follow-up to a running task…) routes as expected at least 90% of the time. The table lives in the test.
- [x] **M3 · Handoff packets.** Shipped: `server/orchestration/handoff.ts` (written on switch, pause, finish and failover; validated; a fallback from the task's state), `handoff_write`, the Handoff section, and "Continue on ChatGPT / Claude" (`POST /api/tasks/:id/continue-on`).
  - `handoff_write`, the packet UI, and "Continue on the other provider".
  - *Accept:* a task started on Claude continues on ChatGPT from the packet and finishes, without the transcript.
- [x] **M4 · Automatic failover.** Shipped: `server/orchestration/failover.ts` — switch with a handoff, or pause until the cooldown ends and resume by itself (re-armed after a restart).
  - A limit hit mid-task leads to a handoff and the other provider, or to pause and auto-resume at reset.
  - *Accept:* with a fake provider that throws a usage-limit error mid-run, the task carries on (switching on) or pauses and resumes at the given reset time (switching off).
- [x] **M5 · Fan-out / fan-in patterns.** (2026-10-08: the per-mission token budget was removed at the user's request; depth and children limits stay.) Shipped: `task_spawn_many`, depth/children/budget limits (`budget.ts`), group cards, nested sidebar rows, and fan-in (`fanin.ts`): one writer turn in the chat with the results as structured data, sent back to Slack/email when the chat came from there.
  - `task_spawn_many` and the writer synthesis; non-coding research works end to end.
  - *Accept:* "Compare Linear, Jira and Height for a 10-person team" spawns 3 researchers and 1 writer; the parent gets one combined answer with sources.

## Tests

`server/orchestration.test.ts`, first import `./test-data-dir.ts`. Cover:

- the dispatch fixture table (a fake classifier for the deterministic part, plus a real-shaped JSON validation test);
- tier mapping with a provider in cooldown;
- depth and child limits;
- handoff validation, including rejecting packets with missing fields;
- failover with a fake provider that throws a usage-limit error;
- fan-in ordering.

## Out of scope

Test gates and reviewer verdicts (03). The reviewer *role* and its tier/provider choice live here; what the review checks lives in 03.

## Open questions

- Should the classifier see the chat's last few messages, or only the new one? Proposal: the last 3 messages, truncated to stay cheap.
  **Answer:** as proposed (the last 3, 400 characters each, plus the chat's running tasks).
- When the user steers a parent, should the steer forward to its running children? Proposal: no. Ask "Also tell the 2 running tasks?" with one click.
  **Answer:** no forwarding. In a chat, the dispatcher already sends a follow-up that's clearly for a running task to that task (`continue-task`); the one-click "Also tell…" prompt isn't built yet.

## Notes from building

- **ChatGPT tier defaults:** deep = the account's default model (listed first, e.g. GPT‑6.1 Sol), standard = the newest other "sol" (GPT‑6 Sol), fast = the newest "luna" (GPT‑6 Luna). ChatGPT efforts are low / medium / high; Claude's low / high / high (xhigh with "Think harder"). Settings can pin any model per tier; a pinned model that disappears falls back to the default.
- **The writer is a turn, not a session:** when a group with `then: "synthesize"` finishes, the chat gets one auto turn on the writer's tier with every result as JSON (summary, findings, files, sources, confidence). A task that fans out doesn't get a writer turn; its loop waits for its children and its next turn starts with their results.
- **Handoffs are written by the current provider's fast-tier model** (cheap), from the task state and the last ~30k characters of its transcript; TOT fills `from`, `createdAt` and `repo` itself. When no model can write one (or it fails validation twice), the packet comes from the task's plan and state.
- **Failover vs. Auto:** Auto's existing switch for a turn that hits the limit before any output stays as it was; failover handles a task whose turn failed mid-way.
- **Limits:** depth 2 below the chat, 6 tasks per chat or task (Settings → Tasks), and a token budget for everything under one chat (Settings → Tasks, shown as "per request"; default 5M, 0 = none). Over budget, no new tasks start and running ones pause.
- **Not yet verified against the live providers.** One thing to watch: Claude's `complete()` starts the Claude Code CLI per call, so the 2 s classifier limit will often run out on Claude and fall back to inline. A warm process (or ChatGPT's app-server, which stays up) would fix that.
