A project is something you're working on: a GitHub repo, a folder on your Mac, or just a topic, like a client or a launch. Projects aren't owned by an agent. Pick any agent, pick a project, and talk.

**Why you'd use it:** with one repo, a flat list of chats is fine. With three, it falls apart. A project keeps its chats, tasks, instructions and knowledge in one place, shared by every agent — and a **Lead** chat to run it from.

## Three kinds of project

- **A GitHub repo**: yours, or any `owner/name`. Each agent that works on it gets its own copy (a clone) on its computer, like teammates with their own laptops.
- **A folder on this Mac**: a project folder you already have, used in place, with your OK.
- **Something else**: no code. A topic, a client, a launch. It gets a shared folder for drafts and notes.

## Make a project

1. In the sidebar, under **Projects**, press **New project**.
2. Answer "What are you working on?": **A GitHub repo**, **A folder on this Mac** or **Something else**.
3. For a repo, search your repos (when GitHub is connected) or type `owner/name`. For a folder, pick one; TOT suggests recent git folders in your home folder.
4. Check the **Name**. TOT fills it in.
5. Leave **Learn it now** on, and an agent studies the code and builds the project's knowledge.
6. Press **Create**. For a folder, press **Continue**, then answer the question below.

### Your OK for a folder

The first time you add a folder, TOT asks:

> **Let agents work in this folder?** They can read everything in this folder and make branches (`tot/…`) in its git repo. They can't change your checked-out files, push, or see anything outside this folder.

That's enforced by the sandbox, not just by asking nicely. TOT refuses your home folder itself, hidden folders like `~/.ssh`, `~/Library` and TOT's own data, and links that point outside the folder.

## The project page

Click a project's name to open its page: your **Lead** chat, and nothing else. The project's other chats and tasks are in the sidebar under its name, and every task is in [Mission control](/docs/mission-control).

The **…** menu at the top holds the rest:

- **New chat**: a chat in the project, apart from the Lead. The **+** on the project's row in the sidebar does the same, and on any new chat the picker in the message box chooses its project.
- **Repos**: the project's repos — see below.
- **Knowledge**: opens the Knowledge page on the project: its facts, pages, repo docs and history. See [Project knowledge](/docs/memory#project-knowledge).
- **Instructions**, **Subscriptions**, **Settings** and **Archive** — plus, for a project with code, **Learn this project** and **Worktree setup**.

An agent's home screen — what you see with no chat open — lists everything in flight under the composer: what **Needs you**, what's **Working**, what's **Ready to land**, what's **Coming up** (the agent's next routines), your **Projects** and what's **Done today**. A project's row shows what needs you, what's working and what's ready to land; click it to open the project's Lead.

## The Lead

Each project has one pinned chat, titled **Lead**, that you run the project from. It's listed first under the project in the sidebar. TOT makes it the first time you open the project, and opens it every time after.

- It plans the work, and can start a task in each of the project's repos.
- It watches every task in the project, not only the ones it started, and wakes up when one finishes or needs you. It can also stop, pause or resume a task.
- It keeps the project's knowledge current as work lands.
- **It hears about things on its own.** A pull request's checks failing or passing, a review asking for changes, a comment, a merge or a conflict; a ticket from the project's Slack channels, Linear teams or GitHub issues; a schedule you set. It acts by starting or steering tasks, and tells you in the Lead chat.
- **It never lands or posts anything on its own.** Before a merge, a draft PR, or pushing review fixes to an open draft PR, it shows you a card: what, where, and why. The card waits for you, however long you take, even after the Lead has stopped typing. Only your **Approve** lands exactly the commit the card showed; **Deny** does nothing. It never comments on GitHub or posts to Slack or Linear.

Ask it things like "where do things stand?" or "land what's ready", or just tell it what you want built next. When you create a project, **What do you want built first?** goes straight to its Lead.

### Subscriptions

The project's **…** menu → **Subscriptions** sets what the Lead hears about:

- **Pull requests:** off, the draft PRs TOT opened (the default), or every open PR in the project's GitHub repos. TOT only reads them, using your GitHub connection. Comments and reviews from people who aren't collaborators on the repo are noted, but their text isn't passed on.
- **Tickets:** the project's Slack channels and Linear teams.
- **Schedules:** for example "every weekday at 9: what's stuck?". At its time, a schedule wakes the Lead with its prompt, in the Lead's chat rather than a new one.

The Lead wakes at most 12 times an hour for these. When its conversation gets long, it carries on in a fresh session from the project's current state, so it stays quick over months.

## More than one repo

A project can hold several repos, any mix of GitHub repos and folders on your Mac — say `web`, `api` and `mobile` for one product. One is the **primary**; add the rest from the **Repos** tab.

- Press **Add repo** and pick a GitHub repo (`owner/name`) or a folder on your Mac. A folder asks your OK, the first time, same as [adding a folder project](#your-ok-for-a-folder) does.
- A repo's **…** menu has **Learn this repo** (an agent studies it and writes up its docs, under **Repos** on the project's Knowledge page), **Rename…**, **Make primary**, and **Remove…**. Removing a repo leaves its files exactly where they are; it just stops tasks from working in it.
- **Each task works in one repo.** With more than one, mission control cards show which repo a task is in. The Lead splits work that spans repos into one task per repo.
- A topic project can gain a repo too: add one from **…** → **Repos**, and the project becomes a code project from then on.
- A GitHub repo you add is cloned next to the project's other clones, on each agent's computer. A folder repo stays exactly where it is, with its own grant.

## Chats in a project

- A chat belongs to one project, or to none. To file one, use **Move to project** in its **…** menu.
- Every chat in a project gets a short **Project** section in its instructions: its repos, where the files are, your instructions, and its knowledge.
- The rule for agents is simple: **look in the project folder, but change code in a task** (unless the chat works in the main checkout or its own worktree, below). Each task gets its own branch and its own copy of the code, in one of the project's repos. See [Tasks](/docs/tasks).
- An agent may file a chat that has no project, when it's clear which one it belongs to. A note says "Filed under …", and you can move it back. TOT never moves a chat out of a project.

### Where a chat works

A new chat in a project with code picks where it works, in the message box before you send the first message:

- **Main checkout** (the default): the chat works directly in the project's own files: your folder on this Mac, or the clone on the agent's computer for a GitHub project. Its commands start there and it can change files there, but not git's config or hooks. Keep it to small, careful changes; bigger or parallel work goes in a task.
- **New worktree**: on its first message the chat gets its own worktree on a new `tot/…` branch, set up like a task's (your copied files and setup command). It changes files only there; the main checkout stays read-only. Deleting the chat removes the worktree, and its branch too unless it has commits of its own or was pushed.

The chat's header shows which: **main checkout**, or the branch name. A chat that works in the project's files stays in that project. Chats from before this only read the project's folder and start a task to change it, and tasks work as they always have.

## Tickets

When a chat starts from a Linear issue or a GitHub issue or pull request (paste its link in your first message), the chat shows the ticket, like **ENG-123**. Tasks started from it are named after it: `tot/eng-123-fix-checkout-…`.

A project can also list where its work comes from: Slack channels and Linear teams. A request from one of those starts in that project, when exactly one project takes it. Issues from a GitHub project's own repo always count.

## Where the files are

- **The primary repo** lives where it always has: `~/projects/<name>` for a GitHub or topic project, on each agent's computer, or the folder itself for a folder project.
- **Other GitHub repos you add** are cloned next to it, at `~/projects/<name>.<repo>`, never nested inside another clone.
- **Other folder repos** stay exactly where they are on your Mac. The branches your agents make show up in your own repo (`git branch`), and you check one out when you want it.
- Your checked-out files are changed in place only by a chat you started in the **Main checkout**. Tasks change code on `tot/…` branches, in separate copies of a repo called worktrees.

## Limits

- Folders on your Mac need a local computer. An agent on a cloud computer can't open them yet.
- A folder without git is read-only: agents can read it, but no task can start in it.
- A project can have up to 20 repos.
- One task works in one repo. Work that spans several repos is one task per repo, not one task across them.
- A project belongs to the computer it was made on. Paired computers can use each other's projects, but nothing is copied between them.
- No sub-projects, and a chat can't be in two projects.
