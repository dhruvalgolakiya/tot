Mission control is how you run many coding agents on one project at once, from one chat. You start the work, watch it on one board, then review each result and bring it into your code, one by one.

**Why you'd use it:** a big change rarely fits in one go. Split it into tasks, let them run side by side, and stay in charge of what lands.

Each coding task works in its own **worktree**: a separate copy of the project with its own branch, so agents don't edit over each other or over your files. Its branch is named `tot/…`.

## Start tasks yourself

The agent starts tasks on its own when you ask for real work. You can also start them directly from the composer (the box you type in):

- **Task**: turn on the **Task** toggle, or press `⌘↩`, and your message starts a task in the background instead of a reply. The placeholder changes to "Describe a task for …". On a project page, the task starts in that project.
- **/task**: type `/task` and your goal. Same as the toggle.
- **/parallel**: type `/parallel` and a bigger job. The agent splits it into independent tasks, one branch each, and sums up when they finish.
- **/best-of**: type `/best-of` and a goal. The same job runs twice, once on Claude and once on ChatGPT (or twice on the one you have), so you can compare and keep the better one.

Type `/` to see these in a small menu. Inside a running task, `⌘↩` sends a note to the task instead.

## The board

Open **Mission control** with `⌘⇧M`, or the board icon in the sidebar's **Tasks** or **Projects** header, or on a project page. It lists every task that's working or waiting for you, in four sections:

- **Needs you**: tasks that asked you something, failed, or were cut off by a restart.
- **Working**: running, waiting in line, or paused.
- **Ready to land**: finished and not yet merged, in the order to land them.
- **Landed**: merged, opened as a draft PR, or discarded. Folded away.

Each card shows the agent's mascot, the title, the latest progress, the branch, how much changed (`+a −r · n files`) and the checks. Pick a project at the top to see only its tasks.

### Overlaps and land order

When two unfinished tasks change the same files, their cards warn you, like "Also changes 2 files in “Fix cart”". **Ready to land** is sorted for you: fewest overlaps with other tasks first, then the smallest change. Landing in that order means fewer conflicts.

## Review and land the code

When a coding task finishes, its header shows **Review & land**. It opens the task's **Changes** tab: every file it changed, and the Land bar at the bottom.

What the main button does depends on the project:

- **Merge into main** (a folder on your Mac): TOT merges the task's branch into the branch you have checked out, in your own folder. The button names that branch. TOT checks for conflicts first and never leaves a half-done merge.
- **Open draft PR** (a GitHub project): TOT pushes the task's `tot/…` branch and opens a *draft* pull request with the goal, a summary, the files changed and the checks. You review and merge it on GitHub yourself. The worktree stays, in case you want fixes.

The **…** menu next to it has the rest:

- **Update from main**: brings in what changed on the main branch since the task started. If there are conflicts, the task's agent resolves them in its own worktree, then runs the checks again. Your folder isn't touched.
- **Run checks**: runs the checks again.
- **Discard**: removes the worktree and deletes the branch (unless it was pushed). The task and its chat stay. TOT asks first.

After landing, the bar says what happened, like "Merged into main · 3f2a9c1" or "Draft PR #12".

### When a button is greyed out

TOT tells you why, right under the button. The common ones:

- "Your folder has uncommitted changes. Commit or stash them, then merge."
- "Conflicts with main. Update from main first."
- "Turn on GitHub writes in Settings → GitHub." The switch there is called **Agents can push and open pull requests**, and it's off by default.
- "Wait for the task to finish, or stop it."

## Checks

When a coding task finishes, TOT runs the project's own checks in its worktree: commands like typecheck, lint, test and build, plus checks on what changed (new dependencies, the size of the change). The commands come from the project's **repo profile**: open the project's brain, then **Repo profile…** in the brain menu. With no profile yet, TOT works them out from the project's files. A test that already fails on the main branch doesn't count against the task; only new failures do.

You'll see "Checks passing", "Checks failing" or "No checks" on the card, and one line per check in the Land bar.

## Best of two

`/best-of` starts two tasks with the same goal, each on its own branch. When both finish, the chat gets one note, "Best of 2 finished", with a **Compare** link. The compare view puts the runs side by side: model, status, changes, checks and summary, and each file's change next to the other's. Press **Keep this one** on the run you like. TOT lands it and discards the other, after asking.

## Worktrees that are ready to work

Each new worktree is set up before its agent starts:

- **Setup command.** TOT runs `npm ci` (or the right install for the project's lockfile: pnpm, yarn, bun or uv). Change it in the project's **…** menu → **Worktree setup**. If it fails, the agent is told and starts anyway.
- **Files to copy.** For a folder on your Mac, list files like `.env` to copy into each new worktree. TOT never shows what's in them.
- **Ports.** Each task gets its own block of ports, so two tasks can run their dev servers at the same time.
- **Preview.** When a task starts a dev server, its header shows a **Preview** link that opens it.
- **Cleanup.** Worktrees of finished tasks that were never landed are removed after 14 days. Branches are kept. Change the days, or **Clean up now**, in **Settings → Tasks**.

## Limits

- TOT never merges on GitHub. You merge pull requests yourself.
- Once a draft PR is open, TOT doesn't follow it yet: it doesn't show the PR's CI checks, fix review comments, push updates to it, or mark it ready for review.
- Playbooks (Bug fix, Feature, Refactor…) and an automatic independent review are set up in **Settings → Workflows**, but they don't drive tasks yet.
- **Preview** works on local computers only, not on cloud computers.
- No stacked PRs: every task branches from the main branch.
