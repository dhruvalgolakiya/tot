# 12 · Coordinator: a Lead that keeps working, like Cursor Projects

**Lane:** worktree `tot-coord`, branch `feat/coordinator`, from `main` after "No Task mode" (587fb6c). Built in three parallel lanes (A–C) off the contract commit, merged by the lead. **Depends on:** 09 (landing, PRs), 11 (projects with repos, knowledge, the Lead). Read [README.md](README.md) first.

## Goal

Make a project feel like a Cursor Project (launched 2026-09-10): you describe what you want, one coordinator runs the work, and it keeps going on its own between your messages.

- **No modes.** You talk to the Lead; it decides what becomes a task (done in 587fb6c: no Task mode, each task keeps its own `PLAN.md`).
- **Subscriptions.** The Lead hears about the world without being asked: a pull request's checks failing or passing, a review asking for changes, a comment, a merge or close, a conflict; a ticket from the project's Slack channels, Linear teams or GitHub issues; a schedule ("every weekday at 9: what's stuck?"). It acts by starting or steering tasks.
- **Control.** The Lead can stop, pause and resume any task in its project.
- **Start with what you want.** Creating a project ends with "What do you want built first?", which goes straight to the Lead.
- **Lean over months.** The Lead never blocks on work, and when its conversation gets long it continues in a fresh session from the project's state (board, open signals, knowledge) instead of an ever-growing transcript.

Decided with the user (2026-10-07): no Task or Plan modes; tasks plan in `PLAN.md`; a Cursor-Projects-like experience.

## Rules

- **Nothing leaves without your OK.** The Lead never merges, pushes, opens or updates a pull request, or posts to GitHub, Slack or Linear on its own. Landing a task, and pushing a fix to a task's open draft PR, go through the Lead's card (`server/lead/asks.ts`, module 11). Signals only make the Lead start, steer, stop, pause or resume tasks and tell you.
- **Read-only watching.** Pull requests are polled with the GitHub connection's token, reading only; nothing is written to GitHub. No connection, no PR signals (said once on the project's Subscriptions).
- **Bounded.** Signals that arrive together wake the Lead once (batched like task wakes). At most 12 signal wakes per project per hour; beyond that they wait for the next. A signal already seen (same PR, same kind, same head commit or comment id) never wakes it twice. A schedule doesn't run again while its last wake is still running.
- **Nothing missed.** Signals are stored (`lead_signals`) until the Lead's turn has read them, across restarts; the Board shows the recent ones.
- Tests: `TOT_DATA_DIR=$(mktemp -d)`, first import `./test-data-dir.ts`, fake models, a fake GitHub on a local port via `TOT_GITHUB_API_URL`; never `~/.tot`, real GitHub, Slack or Linear, or ports 5173/8787/5190. DESIGN.md: Inter, light and dark, few visible actions, no colored side bars.

## Contract (committed first; lanes build on it)

`shared/types.ts`, "Coordinator (module 12)" block:

- `PullRequestWatch = "off" | "tot" | "all"` (PRs TOT opened for this project's tasks, or every open PR in its GitHub repos); `ProjectSubscriptions { pullRequests }`; `Project.subscriptions?: ProjectSubscriptions` (default `{ pullRequests: "tot" }`); `UpdateProjectSubscriptionsRequest`.
- `LeadSignalKind`, `LeadSignal { id, projectId, kind, title, detail, url, repoName, taskId, prNumber, at, readAt }`.
- `Routine.projectId?` / `RoutineInput.projectId?`: a project's schedule; it runs in the project's Lead.
- `CreateProjectRequest.firstMessage?`: sent to the new project's Lead.

`server/lead/inbox.ts` (lane A implements, B uses): `leadInbox.post(projectId, signal)` stores a signal, shows it in the Lead's chat as a notice, and wakes the Lead (batched, bounded). Returns the stored signal, or null when it was a duplicate or the project has no Lead yet.

Route files (each lane owns one), registered in `server/routes.ts`:

| Lane | File | Routes |
|---|---|---|
| A | `server/signals/routes.ts` | `GET /api/projects/:id/signals` → `LeadSignal[]` (newest first) · `GET`/`PATCH /api/projects/:id/subscriptions` → `ProjectSubscriptions` · `POST /api/projects/:id/signals/check` (look at PRs now) |
| B | `server/projects/schedules-routes.ts` | `GET`/`POST /api/projects/:id/schedules` → `Routine[]` / `Routine` · `PATCH`/`DELETE /api/projects/:id/schedules/:routineId` |

Component stubs: `src/components/projects/ProjectSignals.tsx` (A, on the Board tab), `src/components/projects/ProjectSubscriptionsDialog.tsx` (B, from the project's … menu). Client functions under the "Module 12 · lane A/B/C" anchors in `src/lib/api.ts`.

## Lane A · Signals

- `server/signals/`: a pull-request watcher. Every 2 minutes while TOT runs (and on `…/signals/check`), for each project with a Lead and PR watching on, read its GitHub repos' PRs (TOT's draft PRs from its tasks' landings, or all open ones) with the GitHub connection: checks (check runs and commit statuses on the PR's head), reviews and review comments, issue comments, merged/closed, mergeable state. New facts become signals: `ci-failed` (with the failing checks' names), `ci-passed`, `changes-requested`, `review-comment`/`comment` (author and first lines, never the user's own TOT bot), `pr-merged`, `pr-closed`, `pr-conflict`. Remember what was seen per PR (head sha, ids) so restarts don't repeat. Back off on errors and rate limits; a missing connection is quiet.
- A merged TOT PR also marks its task's landing merged (if it isn't), so the board and knowledge (module 11's base-move update) follow.
- **Tickets to the Lead:** module 06's intake (`server/projects/intake.ts`, used by Slack, mail and GitHub issues) gives work for a project with a Lead to the Lead as a `ticket` signal (who, where, the text, the link) instead of starting a separate chat. Without a Lead, as before.
- `leadInbox.post` (inbox.ts) and its wake: extend module 05/11 wakes (`server/tasks/wake.ts`) so unread signals wake the Lead with one auto turn listing them (as task results do); mark them read when the turn sees them. Bounded as in the Rules.
- `ProjectSignals`: the last signals on the Board, quiet rows (icon, title, repo, time, link), unread ones marked.
- Test: `server/signals.test.ts` (fake GitHub: a TOT draft PR goes red, then green, gets a change request and a comment, then merges; duplicates; restart; rate limit; tickets to the Lead; the hourly bound).

## Lane B · Schedules, control, first request, Subscriptions

- **Schedules:** `Routine.projectId` (a `project_id` column on routines). A project's schedule runs by posting a `schedule` signal (its name and prompt) to `leadInbox.post`, not by starting a new chat; it uses the Lead's agent. The schedules routes, and the existing routine screens leave project schedules out of an agent's list.
- **Lead control:** `task_stop`, `task_pause`, `task_resume` in `server/lead/tools.ts`, for any task in the project (`tasks.stop/pause/resume`). No card: they're reversible or harmless (a stopped task keeps its worktree until it's discarded).
- **Pushing a fix to an open draft PR** (a task that already landed as a PR got review fixes): `task_land` on such a task asks on the Lead's card "Push 2 new commits to draft PR #12?" and on yes pushes exactly the reviewed head (module 09's PR path, `headSha`).
- **First request:** `CreateProjectRequest.firstMessage`: after the project is made (and, for a folder, once it's allowed), TOT opens its Lead and sends the message as yours. The New project dialog gets an optional "What do you want built first?" field; creating it lands on the project page with the Lead working.
- `ProjectSubscriptionsDialog` (… menu → Subscriptions): pull requests (Off / TOT's PRs / All PRs, with "Connect GitHub" when there's no connection), the project's tickets (its Slack channels, Linear teams; module 06's intake settings), schedules (list, add, edit, pause, delete).
- Test: `server/lead-controls.test.ts`.

## Lane C · A lean, always-responsive Lead

- **Fresh sessions:** when a Lead's last turn used more than ~120k input tokens, its next turn starts a fresh provider session with a project-state preamble: the board (`projectBoardText`), unread and recent signals, the knowledge's `MEMORY.md` and Overview page summary, open land cards, and the last few exchanges (clipped). Like tasks' `FRESH_SESSION_TOKENS` (server/tasks/run-loop.ts) but for a chat.
- **Never blocks:** a Lead can't use `wait: true` on task tools (refused with a reason); its prompt says to delegate and stay free.
- **The Lead's prompt** (`server/lead/prompt.ts`): signals and what to do with each (a red check → message the task with the failing checks, or start a fix task; changes requested → hand the comments to the task, then propose pushing the fix; a ticket → decide, start a task, tell the user; a schedule → do what it asks), the control tools, that pushing and landing go through cards, and to keep the project's knowledge current.
- Test: `server/lead-session.test.ts`.

## Milestones

- [x] **M0 · Contract** (lead). Types, inbox and route stubs, component stubs, api anchors.
- [x] **M1 · Signals** (A). `server/signals/` (read-only PR watcher with ETag caching and rate-limit backoff; `lead_signals`, `lead_pr_seen`, `lead_signal_wakes`), `leadInbox.post`, signal wakes in `tasks/wake.ts`, tickets from intake to the Lead, merged TOT PRs mark their task, `ProjectSignals` on the Board (`server/signals.test.ts`).
- [x] **M2 · Schedules, control, first request, Subscriptions** (B). Project schedules post `schedule` signals; `task_stop`/`task_pause`/`task_resume`; pushing review fixes to a draft PR through the Lead's card; `firstMessage` (and `agentId`) on project creation; the Subscriptions dialog (`server/lead-controls.test.ts`).
- [x] **M3 · A lean Lead** (C). Fresh sessions past ~120k tokens of context per model call, from a project-state preamble (`server/lead/session.ts`); `wait` refused for Leads; the Lead's prompt for signals and controls (`server/lead-session.test.ts`).
- [x] **M4 · Merge, review, live run** (lead). Joined: one set of subscription client calls; the fresh preamble counts new signals instead of repeating them; a merged PR doesn't re-run the knowledge update. The independent review found, and these were fixed: outsiders' PR comments reaching tasks as instructions (signal text is now framed as quotes, escaped, and withheld from non-collaborators; wake messages use TOT's own words); the Lead having GitHub write tools (Leads get read-only GitHub); signals lost when a turn fails; a late check failure on the same commit going unreported; a wake's own signals shown as "already seen" in a fresh session; pushing a fix to a closed PR, or one someone else pushed to (now checked on GitHub first); old PRs replaying their whole history on the first look. The live run (real Claude turns, fake GitHub, a bare repo as origin) passed every step: a red check woke the Lead, it steered the task, the task fixed it, the Lead's card pushed exactly the reviewed commit as a fast-forward, checks went green; a schedule woke it; a fresh session carried on; a first request started a new project's Lead. It found a task picked up by a message losing that turn's branch head, now recorded (`runLoop.recordRun`).
- Not done: a wake per watcher pass instead of per signal batch; PRs that 404 before SSO is authorized stop being watched; the Lead can't manage project schedules itself (only the Subscriptions dialog).
