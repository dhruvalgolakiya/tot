Every agent gets a computer of its own, where it runs commands, installs things, edits files and tests its work. That way it breaks its own computer, not yours.

**Why it matters:** Claude Code and Codex normally run commands on your Mac. In TOT, their own shell and file tools are turned off. Everything an agent does goes through TOT, onto the agent's computer.

## Pick a kind of computer

Open **Settings → Computer** and choose a **Computer mode**:

- **Local sandboxed folder.** Commands run in a folder on this Mac, inside macOS's own sandbox. The agent can only write inside its folder, and can't read your personal files. No account needed.
- **Boat cloud VM.** A Linux machine in the cloud from [boat.dev](https://boat.dev), with Docker, Node, Python, Chrome and a desktop. Paste your **Boat API key** and pick a **VM size** (small, default or large). Boat is a paid service, billed by the second while a machine runs.
- **Off.** No computer. Agents can still search the web and remember things.

## How it behaves

- **One computer per agent**, shared by all of its chats and tasks.
- **It starts when it's needed**: the first time the agent runs something.
- **It sleeps when it's idle**, after 10 minutes by default (**Stop idle computers after** in Settings → Computer), and wakes up the next time it's needed. Files and installed packages are kept. Servers that were running stop, and the agent is told to restart them.
- **Code lives in folders on it**: `~/projects/<name>` for projects, with a separate copy (a worktree) for each coding task.

## Watch it work

The header of a chat has a **Computer** button that says whether it's on, asleep or not started yet. It opens the computer panel:

- the state, with **Stop computer**;
- the latest screenshot, the shared web servers ("Exposed ports"), the workspace and the activity;
- on a cloud computer, **Open desktop**: the machine's live screen, in a new tab.

## Desktop control (cloud computers)

On a Boat computer, an agent can use the desktop like you would: look at the screen, click, type, press keys, scroll and open web pages. It's for sites that need a real browser: signing up for something, clicking through a dashboard, checking that a page looks right. Each step shows in the chat ("Clicked (412, 230)", "Typed …"), and you can watch it live with **Open desktop**.

## Share what it builds

When an agent starts a web server, it can share it with you:

- On a **cloud computer**, you get a public link that works from anywhere.
- On a **local computer**, you get a `localhost` link that works on this Mac.

For coding tasks in a project, the task's **Preview** link does the same; see [Mission control](/docs/mission-control).

## Your folders

A local computer can see a folder on your Mac only when you've added it as a project and said yes, and only while the agent works in that project. Even then, it can read the folder but only write to its own branches. See [Projects](/docs/projects).

## Limits

- The desktop, **Open desktop** and public links need a cloud computer.
- Cloud computers can't open folders on your Mac yet.
- The computer panel shows the latest screenshot, not a live view. The live view is **Open desktop**, on cloud computers.
- In the Mac app, on a Mac without Node installed, agents on a local computer have no `node` to run.
