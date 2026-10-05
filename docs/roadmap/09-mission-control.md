# 09 · Mission control: many coding agents from one chat

**Lane:** worktree `tot-mission`, branch `feat/mission-control`, from `main` after 08. Built in three parallel lanes (A, B, C below), each on its own branch off the contract commit, merged into `feat/mission-control`. **Depends on:** 01 (tasks, worktrees), 02 (groups, providers), 03 (gates), 06 (projects, folder grants). **Absorbs 04 M1** (push + draft PR). Read [README.md](README.md) first.

## Goal

Run many coding agents on one project at once, Cursor 3 / Conductor style, and manage them all from the main chat:

- **Start them yourself.** A **Task** mode in the composer (⌘↩), `/parallel` (the agent splits the job into tasks) and `/best-of` (the same job on Claude and ChatGPT, compared side by side).
- **See them all.** **Mission control**: one board per project (or everything), "needs you" first, with each task's progress, lines changed, checks and conflicts with other tasks.
- **Land the code.** Review the diff, then **Merge into `main`** (a folder on this Mac) or **Open draft PR** (a GitHub project), **Update from `main`** when it fell behind, or **Discard**. The worktree goes away afterwards.
- **Worktrees that work.** Each new worktree is set up (`npm ci`, …), gets its own ports and a **Preview** link, and is cleaned up when it's no longer needed.

What already exists (01, 02, 05): the chat's agent starts tasks (`task_start`, `task_spawn_many`), each coding task gets `tot/<slug>-<hex>` in `<project>/.tot-worktrees/…`, live task cards, steer/pause/stop/queue, the parent chat wakes up when tasks finish, a Changes tab, and `POST /api/tasks` / `POST /api/conversations/:id/tasks` (no UI used them yet). Missing: everything after "the code is ready", a board, starting tasks from the UI, worktree setup/ports/cleanup. 03's gates exist but never run on tasks.

## Rules

- **Pushing only with GitHub writes on** for the agent's account (`githubAccessFor(agentId)` in `server/persona-github.ts`), and only `tot/*` branches. Never push the base branch, never force-push, never merge on GitHub (TOT links "Merge on GitHub ↗").
- **Merging into your folder only on your click,** done by TOT itself (not the sandboxed agent), only when your working tree is clean, never leaving a half-merged state: conflicts are found first with `git merge-tree`, and resolved in the task's worktree (Update from main), never in your checkout. Never pushes.
- **Nothing lost silently.** Discard and cleanup never delete a branch that was pushed; cleanup removes worktrees, keeps branches.
- **Files copied into worktrees** (e.g. `.env`) only when the user listed them for that project. TOT never prints their contents.
- **Tests never touch real GitHub or `~/.tot`.** Fake GitHub server (`server/github.test.ts`), local bare remotes, `TOT_DATA_DIR=$(mktemp -d)`, first import `./test-data-dir.ts`.
- DESIGN.md: light and dark, one primary action per place, the rest in a "…" menu or on hover, no colored side bars.

## Contract (committed first; lanes build on it)

`shared/types.ts`, "Mission control (module 09)" block: `TaskDiffStats`, `TaskChecks`, `TaskLanding`, `TaskLandOptions`, `LandTaskRequest`, `TaskSetup`, `TaskPorts`, `TaskPreview`, `TaskGroupKind`, `MissionTask`, `MissionOverview`, `BestOfRequest`; optional `TaskInfo` fields `stats`, `checks`, `landing`, `groupKind`, `setup`, `ports`, `preview`; optional `Project` fields `setupCommand`, `copyFiles`. Optional because old task rows don't have them.

Route files, registered in `server/routes.ts` (each lane owns one):

| Lane | File | Routes |
|---|---|---|
| A | `server/landing/routes.ts` | `GET /api/tasks/:id/land` → `TaskLandOptions` · `POST /api/tasks/:id/land` `LandTaskRequest` → `Conversation` · `POST /api/tasks/:id/update-from-base` · `POST /api/tasks/:id/discard` · `POST /api/tasks/:id/checks` |
| B | `server/mission/routes.ts` | `GET /api/mission?projectId=&agentId=&group=` → `MissionOverview` · `POST /api/tasks/best-of` `BestOfRequest` → `Conversation[]` |
| C | `server/worktrees/routes.ts` | `POST /api/tasks/:id/preview/stop` · `POST /api/worktrees/cleanup` → `{ removed: number }` (project setup fields go through the existing `PATCH /api/projects/:id`) |

Client functions go under the lane's anchor comment in `src/lib/api.ts`.

## Lane A · Land (`server/landing/`, `src/components/tasks/LandBar.tsx`)

- **Checks.** When a repo task finishes `done`, run 03's gates (`server/trust/gates.ts`) on its worktree if the repo has a profile; store `TaskInfo.checks` (state + one line per gate). `POST /checks` re-runs. No profile → `state: "none"`.
- **Land options** (`GET /land`), computed on demand:
  - `merge`: folder projects (granted) — target = the branch checked out in the folder. Unavailable with a reason when: the folder has uncommitted changes, it's on a `tot/*` branch or detached, or `git merge-tree --write-tree` reports conflicts ("Conflicts with main. Update from main first.").
  - `pr`: GitHub projects (and tasks whose repo is `owner/name`) — unavailable without GitHub writes ("Turn on GitHub writes in Settings → GitHub").
  - `behind`: commits on base since the branch's merge-base.
- **Merge** (`POST /land {method:"merge"}`): `git merge --no-ff -m "Merge <branch>: <title>"` in the user's folder, run by the server with `execFile` (cwd = the folder; re-check clean + no conflicts right before). Then remove the worktree and delete the merged branch; `landing = {kind:"merged", target, sha}`.
- **PR** (`POST /land {method:"pr"}`): push `tot/*` from the worktree through the agent's computer (`git push -u origin <branch>`), then create a **draft** PR via the GitHub REST API (reuse `server/github.ts`'s base URL so the fake server works). Body: goal, summary, files changed, checks lines, open questions, footer "Opened by TOT for @<user>". `landing = {kind:"pr", target: base, sha: head, pr}`. Keep the worktree (review fixes may follow).
- **Update from base:** in the worktree via the computer: fetch (GitHub projects) and `git rebase <base>`. Clean → done. Conflicts → `git rebase --abort`, then send the task a turn (the same path as `task_message`, which restarts finished tasks): "Rebase onto <base> and resolve the conflicts, keeping both sides' intent, then run the checks."
- **Discard:** stop it if running, remove the worktree, delete the local branch unless pushed; `landing = {kind:"discarded"}`.
- Every change publishes the `task` app event.
- **UI:** a Land bar in the task view (bottom of the Changes tab, and its primary action mirrored in `TaskHeader`'s area only if A owns that edit — coordinate: A owns `ChangesTab.tsx`, `TaskPanel.tsx`; C owns `TaskHeader.tsx`). One primary button ("Merge into main" / "Open draft PR"), with "Update from main", "Run checks", "Discard" in its "…" menu. Shows checks lines, "3 behind main", the unavailable reason, and after landing "Merged into main · abc1234" / "Draft PR #12 ↗".
- **Tests** `server/landing.test.ts`: merge into a temp folder project (clean, dirty refused, conflict refused, `tot/*` checkout refused); PR against the fake GitHub + a local bare remote (writes off → refused, nothing pushed; non-`tot/*` refused); update-from-base clean rebase and conflict → task turn queued (fake sender); discard keeps pushed branches; gates on finish store checks.

## Lane B · Mission control and spawning (`server/mission/`, `src/components/mission/`, Composer)

- **Stats after every turn:** a light `worktrees.stats()` (numstat against the merge-base, untracked files counted, at most 200 paths) called where the run loop records `headSha`; stored as `TaskInfo.stats`. Also refreshed when a task finishes.
- **Overview** (`GET /api/mission`): tasks that are open, or finished and not yet landed, plus those landed in the last 24 h; filtered by project/agent/group. `overlaps`: for unlanded tasks on the same repo folder, the shared `stats.paths`. `landOrder`: finished unlanded tasks, fewest overlaps first, then smallest diff.
- **Mission control page** (`/mission`, `?project=<id>`): sections **Needs you** (needs-input, failed), **Working** (running, queued, paused), **Ready to land** (done, unlanded, in `landOrder`), **Landed** (folded). Card: agent mascot, title, status + progress line, `branch`, `+a −r · n files`, checks state, overlap warning ("Also changes 2 files in 'Fix cart'"), Preview link (from C's `preview`), elapsed. Click opens the task. Live via `task` events (refetch the overview, debounced). Entry points: an icon in the sidebar Tasks group header, the project page header, and ⌘⇧M.
- **Task mode in the composer:** a "Task" toggle (and ⌘↩) sends the text as a task: from a chat → `POST /api/conversations/:id/tasks` (repo = the chat's project), from a project page or home → `POST /api/tasks` with `projectId`. Use `requestId` for double-click safety.
- **Slash commands** (small menu on `/`): `/task <goal>`, `/parallel <job>` (sent as a normal message with an instruction to split it into independent tasks with `task_spawn_many`, one branch each, and to synthesize when they finish), `/best-of <goal>`.
- **Best of N** (`POST /api/tasks/best-of`): one task per provider (`["claude","chatgpt"]` when both are logged in; otherwise two runs on the one available), same goal, repo and base, `group` shared, `groupKind: "best-of"`, provider pinned. Their individual wake-ups are skipped (`server/tasks/wake.ts`); when the last one finishes the parent chat gets one notice "Best of 2 finished · Compare". **Compare view** (`/tasks/compare/:group`): a column per task (provider, model, status, stats, checks, summary) and a per-file diff toggle; **Keep this one** lands it with A's API (`POST /land`) and discards the others (confirm first).
- **Tests** `server/mission.test.ts`: stats after a turn; overlaps and land order; best-of creates pinned tasks in one group and posts one notice when all finish.

## Lane C · Worktree lifecycle (`server/worktrees/`, project settings, Settings → Tasks)

- **Setup** right after a task's worktree is first created (`prepareTask`): the project's `setupCommand`, or detected from the lockfile when unset (`package-lock.json` → `npm ci`, `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `yarn.lock` → `yarn install --immutable`, `bun.lock`/`bun.lockb` → `bun install --frozen-lockfile`, `uv.lock` → `uv sync`), `""` = none. Runs in the worktree through the computer, 10-minute timeout; `TaskInfo.setup` records it; a failure is told to the agent in its first turn, never blocks it.
- **Copy files:** folder projects only, the project's `copyFiles` (relative paths, no `..`), copied by the server from the folder into the new worktree before setup.
- **Ports:** each task with a worktree gets a free block of 10 (from 41000; never TOT's own ports), `TaskInfo.ports`; commands the task runs get `PORT=<base>` and `TOT_PORTS=<base>-<base+9>` (the computer exec env), and the task prompt says so. Released when the task is landed, discarded or cleaned up.
- **Preview:** a tool inside tasks, `task_preview_start {command, port?, path?}`: TOT runs the command as a managed background process in the worktree (same sandbox and grant as the task's commands), keeps its output in a log, sets `TaskInfo.preview = {url: http://localhost:<port><path>, …}`, and stops it on discard/land/cleanup/stop and on TOT shutdown. `task_preview_stop`. Local computers only (Boat: a clear "needs a local computer" reply). UI: a **Preview ↗** chip in `TaskHeader`.
- **Cleanup:** worktrees of finished, unlanded tasks older than `tasks.worktreeCleanupDays` (default 14) are removed by a daily sweep (branches kept); `POST /api/worktrees/cleanup` runs it now. Settings → Tasks: the days, and "Clean up now".
- **Limits:** defaults `perAgentLimit` 2 → 4, `globalLimit` 4 → 8.
- **Project settings UI:** "Worktree setup" in the project's menu: the setup command (placeholder shows the detected one) and files to copy (folder projects).
- **Tests** `server/worktrees.test.ts`: setup detection and run; copy files (and `..` refused); port blocks unique and released; preview process started, URL set, stopped on discard; cleanup keeps branches.

## Milestones

- [ ] **M0 · Contract** (lead): types, stub route files, api anchors, this doc.
- [ ] **M1 · Land** (lane A).
- [x] **M2 · Mission control + spawning** (lane B). Diff stats after every turn and on finish; `GET /api/mission` (overlaps, land order; a best-of run's alternatives don't overlap each other); `/mission` board (sidebar Tasks and Projects headers, project page, ⌘⇧M); composer Task mode (⌘↩) and `/task` `/parallel` `/best-of` with request ids (`POST /api/tasks` dedupes them too); best-of with one "Best of N finished · Compare" notice; `/tasks/compare/:group` with Keep this one (lane A's land + discard).
- [ ] **M3 · Worktree lifecycle** (lane C).
- [ ] **M4 · Merge lanes, review, live run** (lead): one project, three parallel tasks from the composer, one best-of, land them in order, screenshots light/dark.

## Out of scope

- Merging on GitHub, review-comment loops and update-branch pushes (04 M2–M5 stay on the roadmap).
- Remote previews for Boat computers.
- Stacked PRs.
