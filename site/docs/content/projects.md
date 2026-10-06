A project is something you're working on: a GitHub repo, a folder on your Mac, or just a topic, like a client or a launch. Projects aren't owned by an agent. Pick any agent, pick a project, and talk.

**Why you'd use it:** with one repo, a flat list of chats is fine. With three, it falls apart. A project keeps its chats, tasks, instructions, brain and memory in one place, shared by every agent.

## Three kinds of project

- **A GitHub repo**: yours, or any `owner/name`. Each agent that works on it gets its own copy (a clone) on its computer, like teammates with their own laptops.
- **A folder on this Mac**: a project folder you already have, used in place, with your OK.
- **Something else**: no code. A topic, a client, a launch. It gets a shared folder for drafts and notes.

## Make a project

1. In the sidebar, under **Projects**, press **New project**.
2. Answer "What are you working on?": **A GitHub repo**, **A folder on this Mac** or **Something else**.
3. For a repo, search your repos (when GitHub is connected) or type `owner/name`. For a folder, pick one; TOT suggests recent git folders in your home folder.
4. Check the **Name**. TOT fills it in.
5. Leave **Learn it now** on, and an agent studies the code and builds the project's brain.
6. Press **Create**. For a folder, press **Continue**, then answer the question below.

### Your OK for a folder

The first time you add a folder, TOT asks:

> **Let agents work in this folder?** They can read everything in this folder and make branches (`tot/…`) in its git repo. They can't change your checked-out files, push, or see anything outside this folder.

That's enforced by the sandbox, not just by asking nicely. TOT refuses your home folder itself, hidden folders like `~/.ssh`, `~/Library` and TOT's own data, and links that point outside the folder.

## The project page

Click a project's name to open its page. It shows every chat and task in the project, from every agent, each with its mascot and status. Type at the top to start a new chat in it, with the agent you have selected.

The **…** menu holds the rest: **Instructions**, **Brain**, **Learn this project**, **Worktree setup** (for code), **Settings** and **Archive**. A **Memory** row shows how many facts agents have learned about the project.

## Chats in a project

- A chat belongs to one project, or to none. To file one, use **Move to project** in its **…** menu.
- Every chat in a project gets a short **Project** section in its instructions: the repo, the base branch, where the files are, your instructions, and its brain.
- The rule for agents is simple: **look in the project folder, but change code in a task.** Each task gets its own branch and its own copy of the code. See [Tasks](/docs/tasks).
- An agent may file a chat that has no project, when it's clear which one it belongs to. A note says "Filed under …", and you can move it back. TOT never moves a chat out of a project.

## Tickets

When a chat starts from a Linear issue or a GitHub issue or pull request (paste its link in your first message), the chat shows the ticket, like **ENG-123**. Tasks started from it are named after it: `tot/eng-123-fix-checkout-…`.

A project can also list where its work comes from: Slack channels and Linear teams. A request from one of those starts in that project, when exactly one project takes it. Issues from a GitHub project's own repo always count.

## Where the files are

- **GitHub and topic projects** live in `~/projects/<name>` on each agent's computer.
- **Folder projects** stay where they are on your Mac. The branches your agents make show up in your own repo (`git branch`), and you check one out when you want it.
- Your checked-out files are never changed in place. Code changes happen on `tot/…` branches, in separate copies of the project called worktrees.

## Limits

- Folders on your Mac need a local computer. An agent on a cloud computer can't open them yet.
- A folder without git is read-only: agents can read it, but no task can start in it.
- A project belongs to the computer it was made on. Paired computers can use each other's projects, but nothing is copied between them.
- No sub-projects, and a chat can't be in two projects.
