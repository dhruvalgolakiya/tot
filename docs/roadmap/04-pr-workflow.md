# 04 · PR workflow

**Lane:** worktree B, branch `feat/pr`, created from `main` **after 01 is merged**. Ideally after 03 too, so PRs can carry gate evidence. **Depends on:** 01 (tasks with branches and worktrees). Uses 03's `GateReport` / `Review` when present.

Read [README.md](README.md) first.

## Goal

Everything between "the task's code is ready" and "a human merges it", without leaving TOT, using buttons and shortcuts:

- **View diff**
- **Push branch**
- **Open draft PR**, with a generated description and the evidence
- **Checks** (CI status)
- **Address review comments**: pull reviewers' comments into the task and fix them
- **Update branch**: bring in base-branch changes, with the agent resolving conflicts
- **Ready for review**
- **Close**

**Merging is never done by TOT.** It's the user's job, on GitHub; TOT shows a "Merge on GitHub ↗" link.

## Rules (from the user's standing rules and TOT's existing GitHub design)

- **No pushes without write access.**
  - Pushes and PR actions only work when GitHub writes are allowed for the account the agent uses: the persona's account, or the app-wide connection (`githubAccessFor(agentId)` in `server/persona-github.ts`).
  - When writes are off, the buttons are disabled with an explanation and a link to the relevant settings.
- **Only when asked.** Every push and PR action happens because the user clicked it, or because a playbook step was explicitly enabled by the user (e.g. "Open draft PR when checks pass", off by default).
- **Never push to the base/default branch.** Only push `tot/*` branches.
- **Never merge or force-push.** No force-push except to the task's own `tot/*` branch after an "Update branch" rebase, and only with the user's click.
- **Tests never touch real GitHub.** Use the fake GitHub server in `server/github.test.ts`.

## Data model

Added to 01's `TaskInfo`:

```ts
pr: TaskPr | null;

interface TaskPr {
  number: number;
  url: string;
  state: "draft" | "open" | "closed" | "merged";
  title: string;
  checks: { state: "pending" | "success" | "failure" | "neutral" | "none"; total: number; failed: string[] } ;
  reviewDecision: "approved" | "changes-requested" | "review-required" | null;
  unresolvedComments: number;
  headSha: string;
  account: string;            // the GitHub login that opened it (persona or user)
  syncedAt: number;
}
```

## Server design (`server/prs/`)

- **`github-api.ts`:** thin REST helpers over the GitHub API using the agent's token from `githubAccessFor`. Reuse `server/github.ts`'s base URL and error handling so the fake server works. The calls needed:
  - create PR (draft);
  - get PR;
  - list check runs and combined status;
  - list review comments and reviews;
  - mark ready for review;
  - close;
  - reply to a review comment (only after a fix, and only when writes are on).
- **`push.ts`:** `git push -u origin <branch>` from the task's worktree on the agent's computer. The computer's git credentials are already synced, and the pushInsteadOf block is lifted only when writes are on. It refuses anything that isn't `tot/*`.
- **`pr.ts`.**
  - **`openDraftPr(taskId)`:** push if needed, then create a **draft** PR. Title from the task; the body is generated with:
    - the summary;
    - what changed, file by file;
    - how it was verified (03's GateReport: commands and results);
    - the review verdict;
    - open questions;
    - a footer line "Opened by TOT for @user".
  - **`sync(taskId)`:** refreshes `TaskPr`.
  - A poller syncs open PRs of active tasks every 2 minutes, and every 30 s while a task view is open. There are no webhooks, because TOT runs locally.
  - Publishes the `task` app event on change.
- **`comments.ts`.**
  - `addressComments(taskId)` fetches unresolved review comments (file, line, body, author) and sends them to the task as a steer/continuation turn: "Address these review comments; one commit per comment where sensible."
  - After the turn: gates (03) run, then push (only after the user's click, unless they enabled auto-push for this task), then optionally reply "Fixed in <sha>" on each addressed comment.
- **`update-branch.ts`.** `updateBranch(taskId)` fetches the base and tries `git rebase origin/<base>`. On conflicts it asks the agent to resolve them in the worktree, runs the gates, and leaves the result ready to push. The push is a force-with-lease to the task's own branch after the user clicks **Push**.
- **Routes** (`server/prs/routes.ts`):
  - `POST /api/tasks/:id/push`
  - `POST /api/tasks/:id/pr` (open draft)
  - `POST /api/tasks/:id/pr/ready`
  - `POST /api/tasks/:id/pr/close`
  - `POST /api/tasks/:id/pr/sync`
  - `POST /api/tasks/:id/pr/address-comments`
  - `POST /api/tasks/:id/update-branch`
  - `GET /api/tasks/:id/diff?file=` (if 01 hasn't already added it)

## UI (`src/components/prs/`)

- **PR tab** in the task side panel (01 left room for it):
  - **No PR yet:** "Push branch" and "Open draft PR". The second is primary once gates pass. A preview of the generated description can be edited before opening.
  - **PR open:** state pill, checks summary (expandable list of failing checks with "Ask Tot to fix"), review decision, the unresolved comments count with **Address comments**, **Update branch**, **Ready for review**, the "Merge on GitHub ↗" link, and **Close** in the "…" menu.
- **Task header:** a compact PR chip ("#142 · checks passing · 2 comments") that opens the PR tab.
- **Sidebar task rows:** a tiny PR state icon (draft, open, checks failing, approved).
- **Shortcuts.** Add a small shortcut registry if none exists; show the shortcuts in a "Keyboard shortcuts" help dialog, opened with `?`.

  | Shortcut | Action |
  |---|---|
  | ⌘⇧D | diff |
  | ⌘⇧P | open/update PR |
  | ⌘⇧K | checks |
  | ⌘⇧C | address comments |
  | ⌘⇧U | update branch |

- **Notifications** (via 01's `notify.ts`): checks failed, new review comments, PR approved, PR merged (the last marks the task `done` and offers to delete the worktree).
- **Settings → Tasks → PRs:**
  - "Open PRs as drafts" (on, locked for now);
  - "Reply on GitHub when a comment is fixed" (off by default);
  - "After checks fail, let Tot try one fix automatically" (off by default).

## Milestones

- [ ] **M1 · Diff, push and draft PR.**
  - Push from the worktree; draft PR with the generated body and evidence; `TaskPr` link; the PR tab's empty and open states; the write-access guard.
  - *Accept:* against the fake GitHub server, a finished task opens a draft PR from `tot/…` with a body containing the gate results; with writes off, the buttons are disabled and nothing is called.
- [ ] **M2 · Sync and checks.**
  - The poller, the checks summary, sidebar and header chips, and notifications.
  - *Accept:* the fake server flips checks to failure; within one poll the task shows "checks failing" and a notification fires.
- [ ] **M3 · Address review comments.**
  - Fetch, steer, gates, push on click, optional replies.
  - *Accept:* two fake review comments lead to fix commits on the branch, and with replies enabled each comment gets "Fixed in <sha>".
- [ ] **M4 · Update branch.**
  - Rebase, agent-resolved conflicts, gates, force-with-lease push on click, only to `tot/*`.
  - *Accept:* a conflicting change on base is resolved and pushed; an attempt to push a non-`tot/*` branch is refused.
- [ ] **M5 · Shortcuts and automation options.**
  - The shortcut registry and help dialog; the auto-fix-once option for failing checks.
  - *Accept:* all shortcuts work from the task view; auto-fix runs at most once per failing sha.

## Tests

`server/prs.test.ts`, first import `./test-data-dir.ts`. Uses the fake GitHub server from `server/github.test.ts`, extended with PR, checks and review endpoints, plus temporary git repos with a local bare remote. Cover:

- **Guards:** writes off; non-`tot/*` branches; base-branch pushes refused.
- **PR body:** the generated content.
- **Sync:** state changes.
- **Comments:** the address-comments flow.
- **Update branch:** conflict resolution with a fake sender.

## Open questions

- Should "Open draft PR" also request reviewers? Proposal: no. Leave that on GitHub for now.
- Should several tasks be able to stack PRs on each other's branches? Proposal: not yet. Every task branches from base.
