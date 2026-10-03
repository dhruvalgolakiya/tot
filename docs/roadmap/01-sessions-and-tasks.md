# 01 · Sessions & Tasks

**Lane:** worktree A, branch `feat/tasks`. **Depends on:** nothing. **Blocks:** 02, 04, and the last milestone of 03.

Read [README.md](README.md) first for the rules, ports and conflict-avoidance conventions.

> **Changed since (2026-10-03):** "Run as task" in the composer (and ⌘↩) and "Make this a task" in the chat menu were removed. The chat's model starts tasks itself (see [02](02-orchestration.md)). The routes behind them (`POST /api/tasks`, `POST /api/conversations/:id/tasks`, `POST /api/conversations/:id/convert`) remain. Slack and email requests become chats rather than tasks, and their model starts any tasks.

## Goal

Chats and tasks mix freely, like Grok Bot:

- **A chat can become a task.** "Ok, go fix it" turns this chat into a task with a branch.
- **A chat can start tasks.** The agent, or you, kicks off one or more tasks from a chat. Each one shows up in the chat as a **live task card**, and the result is reported back into the chat when it finishes.
- **Tasks are long-running.** They keep going with the tab closed and survive a server restart. You can **steer** them mid-run, **pause**, **resume** and **stop** them, and they wait in a **queue** when the agent is busy.
- **Code tasks get a branch.** A task that touches a repo gets its own branch and git worktree on the agent's computer, so parallel tasks never collide.
- **Non-code tasks exist too.** For example, "research these 5 vendors and write a comparison". They get everything except git.

## Concepts

- **Session** = a TOT conversation, unchanged. Every task is a session, so existing chat features keep working on tasks: transcript, attachments, approvals, model picker and computer.
- **Kind:** `chat` (today's behaviour) or `task`.
  - A task has a goal, a status, an origin, and optionally a repo/branch/worktree.
  - **Coding task** = a task with a repo. There is no separate "coding mode" flag.
- **Parent:** the session a task was started from (nullable). One level is enough here; deeper trees are 02's business.
- **Task status:** `queued` → `running` → one of:
  - `needs-input` (waiting for an approval or a question)
  - `paused`
  - `done`
  - `failed`
  - `stopped`
  - `interrupted` (the server restarted mid-run)
- **Queue:** per agent, because one agent has one computer. Each agent has a concurrency limit (default 2) and there's an app-wide cap (default 4). Order is first-in, first-out, with manual reorder.

## Data model (proposal; refine while building)

`shared/types.ts`. This module owns the changes to existing types.

```ts
// Conversation gains:
kind: "chat" | "task";
parentId: string | null;     // the chat/task it was started from
task: TaskInfo | null;       // null for chats

interface TaskInfo {
  goal: string;              // one or two sentences, shown on cards
  status: TaskStatus;
  progress: string | null;   // latest "what I'm doing" line, from the agent's task_update
  plan: { text: string; done: boolean }[];   // the agent's checklist, shown in the task view
  repo: TaskRepo | null;     // null = non-coding task
  origin: ConversationOrigin | null;  // chat, Slack, email, routine, Linear…
  queuePosition: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  summary: string | null;    // the result reported back to the parent
  usage: { inputTokens: number; outputTokens: number };
}

interface TaskRepo {
  source: string;            // GitHub "owner/name", a clone URL, or a path on the agent's computer
  folder: string;            // ~/repos/<name> on the computer (same convention as Learn a repo)
  baseBranch: string;        // e.g. "main"
  branch: string;            // "tot/<slug>-<4 chars>"
  worktree: string;          // ~/repos/<name>/.tot-worktrees/<branch-slug>
  headSha: string | null;
}
```

- **New message part**, `{ type: "task"; id; taskId }`: rendered as a live task card in the parent chat (title, status, progress, branch, elapsed time, "Open"). The card reads live state from the store, so the part only holds the id.
- **New app event**, `{ type: "task"; conversation }`: a task's state changed. It reuses the conversation payload.
- **Database:**
  - `conversations` gets columns `kind`, `parent_id` and `task` (JSON).
  - A `task_queue` table, or just `queue_position` inside `task` if that stays simple.
  - Add these in the module's own block at the end of `server/db.ts`.

## Agent tools (TOT MCP server, `server/tasks/tools.ts`)

- **`task_start({ title, goal, repo?, baseBranch?, model? })`** starts a child task from the current session and returns its id. It shows a task card in the current chat. When the agent is "doing real work" it should prefer this over working inline. 02 later makes that choice automatic; here the agent decides, guided by the system prompt.
- **`task_list()`** and **`task_status(id)`** show the children of this session and their status and summary.
- **`task_message(id, text)`** steers a child task (same path as the user's steer).
- **Inside a task session only:**
  - **`task_update({ progress?, plan? })`** reports what it's doing and ticks its checklist.
  - **`task_finish({ outcome: "done" | "failed", summary })`** ends the task. The summary is posted to the parent as a card update plus a short note part.

The task prompt section (in `prompts.ts`) tells the agent:

- it is working on a task;
- its goal;
- its branch and worktree, which it must use as `cwd` for every command;
- to keep `plan` updated;
- to call `task_finish` when done;
- never to touch other worktrees or the base branch.

## Server design (`server/tasks/`)

- **`tasks.ts`: lifecycle.**
  - `create`: a new conversation with `kind: "task"`; inherits the agent and, if set, the model.
  - `start`, `pause`, `resume`, `stop`, `finish`.
  - Status transitions with guards; publishes the `task` app event.
- **`queue.ts`.**
  - When a slot frees up, start the next queued task for that agent.
  - Enforce the per-agent and global limits.
  - Reorder on request.
  - On boot, mark tasks that were `running` as `interrupted`. Resume them automatically if Settings → Tasks → "Resume interrupted tasks" is on (default on).
- **`run-loop.ts`: long-running turns.**
  - One provider turn ends when the model stops. A task keeps going: after each turn, if the task hasn't called `task_finish` and the last turn made progress (it ticked the plan, changed files or called tools), send a continuation turn:
    - text such as "Continue the task. Plan so far: …";
    - `TurnOptions.maxSteps` raised;
    - `freshSession` when the transcript gets long, carrying the plan and progress forward.
  - Stop after N turns without progress and mark the task `failed` with "stalled".
  - Copy the stall handling from `server/agent/learn-repo.ts`.
- **`worktree.ts`.** All of this runs through the agent's computer (`computerManager`), never on the Mac directly:
  - make sure the repo exists in `~/repos/<name>` (clone if missing, using the agent's GitHub access via `githubAccessFor`), then `git fetch`;
  - `git worktree add -b <branch> <worktree> origin/<base>`;
  - record `headSha` after every turn;
  - when the task is deleted, `git worktree remove`; the branch is kept unless it was never pushed and the user says delete;
  - **never** run `git push` from here. Pushing belongs to 04 and to the agent's own tools under the GitHub write rules.
- **Steering** (`steer.ts`, route `POST /api/conversations/:id/steer { text }`). The note is saved as a user message marked `steered: true` and delivered:
  - **Claude (Agent SDK):** check whether the installed SDK accepts streaming input during a turn (an async-iterable prompt / `streamInput`). If it does, push the note as a user message mid-turn.
  - **ChatGPT (Codex app-server):** look for a mid-turn input method in the installed `codex app-server` protocol (e.g. `turn/steer`). Today `chatgpt.ts` only uses `turn/start` and `turn/interrupt`.
  - **Fallback for both:** `interrupt` at the next tool boundary, then start a new turn with "The user added: <note>. Continue the task with this in mind."

  Write down which path each provider uses in this doc when you know.

  **Delivery paths (as built):**
  - **Claude:** native. Steerable turns keep the Agent SDK's prompt stream open (an async-iterable prompt); a note is pushed as a user message with `priority: "next"` and a uuid. Claude Code folds it into the running turn at its next step and reports it in `user_message_uuids`; if the turn ends first, Claude Code runs it as one more turn, which TOT reads as part of the same turn. If neither happens within 5 s of the turn ending, the deliverer answers `false` and TOT falls back. (`server/agent/providers/claude.ts`, `PromptStream`.)
  - **ChatGPT:** native. Codex's app-server has `turn/steer { threadId, expectedTurnId, input }`; TOT calls it for the turn in flight and falls back when it fails (e.g. the turn already ended). (`server/agent/providers/chatgpt.ts`.)
  - **Fallback (both, and anything else):** the run is stopped as soon as its current tool call finishes (`run.stop("steer")`, so the reply is saved as complete, not stopped), and the task's next turn starts with "The user added: …". Notes sent between turns or while queued go with the next turn the same way. (`server/tasks/steer.ts`.)
  - Not yet verified against the live providers (that costs plan usage); the fallback is covered by `server/tasks.test.ts`.
- **Pause** = interrupt plus status `paused`. **Resume** = a continuation turn. **Stop** = interrupt plus `stopped`; the worktree is kept.
- **Persistence.** Runs are in memory (`server/agent/runs.ts`). Tasks must not depend on that: everything needed to continue is stored in the conversation, its `task` JSON and the provider session id. A restarted server resumes from there.
- **Notifications** (`notify.ts`). On `done`, `failed` or `needs-input`:
  - an app event, which the UI turns into a toast and a browser `Notification` if the user allowed it;
  - for Slack-origin tasks, a reply in the thread (reuse `server/slack.ts` posting);
  - for email-origin tasks, a reply email (reuse `server/mail/tasks.ts`);
  - otherwise, optionally a Slack DM to the user (Settings → Tasks → "Also tell me on Slack").

  None of these are sent in tests; use fakes.
- **Intake.** Slack (`server/slack.ts`) and email (`server/mail/tasks.ts`) today create plain chats. With this module:
  - When the request is clearly work ("fix…", "investigate…", a repo mentioned), they create a **task** in the queue. Otherwise they create a chat, as now.
  - Keep a simple, explicit rule here (keywords plus a repo/brain match). 02 replaces it with the dispatcher.
- **Routes** (`server/tasks/routes.ts`, mounted with one line):
  - `POST /api/conversations/:id/tasks`: start a task from a chat;
  - `POST /api/conversations/:id/convert`: turn a chat into a task;
  - `POST /api/tasks/:id/(pause|resume|stop)`;
  - `PATCH /api/tasks/:id` (title, goal, queue position);
  - `GET /api/tasks?agentId=&status=`;
  - `POST /api/conversations/:id/steer`.

  Document all of them in the route docs block.

## UI (`src/components/tasks/`)

- **Sidebar.**
  - A **Tasks** group above Chats for the selected agent: running, needs-input and queued tasks first, then recent done/failed ones (collapsed).
  - Each row shows: a status dot (pulsing while running), the title, `repo · branch` in muted text for coding tasks, and the elapsed time.
  - Chats with running child tasks show a small count badge.
  - Keep it flat and quiet (ChatGPT style). Finished tasks fold away.
- **Task card** (the `task` part in a chat):
  - Shows the title, status, latest progress line, branch, elapsed time, and an **Open** button.
  - When done, it shows the summary and "Open" / "View changes".
  - Live, via the `task` app event.
- **Composer.**
  - **Run as task** is a toggle or menu entry, plus the shortcut ⌘↩.
  - With a repo picker when the agent has repo brains or GitHub is connected: reuse the repo list from Learn a repo (`LearnRepoDialog.tsx` already lists the user's GitHub repos).
  - In a running task, the placeholder becomes "Steer this task…" and sending steers.
- **Header of a task view:**
  - title, status pill, `repo · branch` (copyable), model/provider, elapsed time, tokens used;
  - **Pause / Resume** and **Stop**;
  - the rest (rename, convert back, delete, open worktree on the computer) in the "…" menu.
- **Task side panel** (reuse `ui/SidePanel`). Tabs:
  - **Plan:** the checklist and progress.
  - **Changes:** `git diff --stat` plus a per-file diff viewer, read-only, from the worktree via a route that runs `git diff <base>...HEAD`.
  - **Activity:** the existing computer activity.
  - 03 and 04 later add **Checks** and **PR** tabs. Design the tab bar so they can be added without touching other tabs.
- **Chat header menu** gets **Make this a task**. It asks for the repo and branch when there's code involved, and keeps the transcript.
- **Queue:**
  - A small "Queue · 3" control in the Tasks group header.
  - It opens a popover list with drag-to-reorder and **Run now** (which skips the line if there's a free slot).
  - Settings → **Tasks** holds the concurrency limits, auto-resume and notification options.

## Milestones

Tick these as you ship, adding a one-line note.

- [x] **M1 · Tasks without git.** Shipped: `kind`/`parentId`/`task` on conversations, `server/tasks/` (store, run loop, tools, prompt), task cards, the sidebar Tasks group, the task header and panel, "Run as task" in the composer.
  - The data model and migration; task sessions; `task_start` / `task_update` / `task_finish` / `task_list` / `task_status`; start from a chat (tool and composer); task cards; the sidebar Tasks group; the task header; the long-running loop with stall detection.
  - *Accept:* in a chat, "research X and Y in parallel" makes the agent start two tasks whose cards update live and post summaries back; closing the tab doesn't stop them.
- [x] **M2 · Repo, branch and worktree.** Shipped: `server/tasks/worktree.ts` (clone, fetch, `git worktree add`, diff, remove, never push), repo picker, the worktree as default `cwd` for the task's computer tools, Changes tab.
  - Repo picker; worktree lifecycle on the agent's computer; the task prompt names the worktree; Changes tab with the diff.
  - *Accept:* two coding tasks on the same repo run at once on different branches without touching each other or `main`; the diff shows only each task's changes.
- [x] **M3 · Queue and restarts.** Shipped: `server/tasks/queue.ts` (per-agent and global limits, reorder, Run now), interrupted + auto-resume on boot, Settings → Tasks, the queue popover.
  - Per-agent and global limits, reordering, Run now; `interrupted` and auto-resume on boot; Settings → Tasks.
  - *Accept:* with a limit of 1, a second task waits as `queued` and starts by itself when the first finishes; restarting the server mid-task resumes it.
- [x] **M4 · Steer, pause, resume, stop**, for both providers, with the delivery path written down here for each. Shipped: native mid-turn delivery for Claude and ChatGPT plus the tool-boundary fallback (paths above), steer notes shown where they landed, Pause/Resume/Stop in the header.
  - *Accept:* a note sent mid-run changes what the agent does next, without losing work.
- [x] **M5 · Notifications and intake.** Shipped: toasts and browser notifications from the `task` event, Slack thread / email thread / Slack DM notices (`server/tasks/notify.ts`), and `server/tasks/intake.ts` turning work requests from Slack and email into queued tasks.
  - Toasts and browser notifications; Slack and email replies for tasks started there; Slack/email requests that are work land in the queue as tasks.
  - *Accept:* `@TOT fix the flaky test in tot` in Slack starts a queued coding task, and the thread gets the result when it finishes.

## Tests

`server/tasks.test.ts`, first import `./test-data-dir.ts`. Cover:

- **Lifecycle:** status transitions and their guards.
- **Queue:** ordering and limits.
- **Restarts:** resume after a simulated restart.
- **The run loop:** continuation and stall detection, with a fake sender in the same style as `slack.useSender`.
- **Worktrees:** create, diff and remove, against a temporary git repo through the local computer backend, with `TOT_DATA_DIR` in a temp folder.
- **Steering:** the fallback path at minimum.
- **Notifications:** with fake Slack and mail.

## Out of scope (other modules)

- Deciding automatically whether to spawn, model tiers, deeper trees and switching providers: **02**.
- Test gates, reviewers and playbooks: **03**.
- Pushing, PRs, checks and review comments: **04**.

## Open questions (decide while building, write the answer here)

- Should a converted chat keep its old transcript in context, or start fresh with a summary? Proposal: keep the transcript; the run loop moves to fresh sessions with a summary when it gets long.
  **Answer:** as proposed. The provider session carries on; the system prompt is rewritten with the task section on the next turn; a turn whose context passed ~150k tokens is followed by a fresh session carrying the goal, plan, progress and the last reply.
- Should non-coding tasks show a sidebar row, or only a card in the chat? Proposal: a row too, without the branch line.
  **Answer:** as proposed.

## Notes from building

- `TaskInfo` has no `origin`: the conversation's own `origin` (Slack, email) and `parentId` (a chat) already say where a task came from. It gained `question` (what a task asked the user) and `turns`.
- Extra routes beyond the list above: `POST /api/tasks` (a top-level task, e.g. "Run as task" on an agent's home screen), `POST /api/tasks/:id/run-now` and `POST /api/tasks/:id/to-chat` ("Turn back into a chat").
- A reply to a task that's waiting on the user (or paused, finished…) starts right away rather than waiting in the queue: the user is right there.
- Tasks with Auto use the strongest model (`heavy: "task"`); 02 replaces this with tiers.
- A chat's model hears about its finished tasks on its next turn (`child_results`), besides the note and the live card in the chat.
- Messages gained a `meta` column: `steered`, `steeredInto` (where in a reply a mid-turn note landed) and `auto` (TOT's own "Continue the task" turns, shown as a divider).
