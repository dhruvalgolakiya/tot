TOT's agents can do real things: run code, push branches, send email. So some things they never do, some they always ask about first, and some are off until you turn them on. Here they are, and how each one is kept: by TOT's code, or by the agent's instructions.

## What TOT never does

- **Merge a pull request on GitHub.** Agents have no tool to merge, and Mission control only opens *draft* pull requests. Merging is yours, on GitHub.
- **Merge into your folder without you.** **Merge into main** in Mission control runs only when you press it, only when your folder has no uncommitted changes, and only when there are no conflicts.
- **Push anything but its own branches from Mission control.** Draft PRs push only `tot/…` branches, never your main branch, and never force-push.
- **Change your checked-out files.** In a folder project, agents can read the folder and make branches, but the sandbox stops them from writing to your files.
- **Store secrets in memory.** Anything that looks like a password, token or key is refused.
- **Print your secrets.** Tokens are scrubbed from logs, errors and tool output.

## What it asks first

- **Sending email.** Every email and reply shows you a card first, "Send this email as …?", with who it's to, the subject and a preview. Nothing goes out until you press **Approve**.
- **App actions that change things.** New apps start at **Ask me**. You can set each action to **Allowed**, **Ask me** or **Blocked**.
- **Folders on your Mac.** Agents can't see a folder until you add it as a project and say **Allow**.

Approval cards wait about a minute. If you don't answer, the answer is no.

## What's off until you turn it on

- **GitHub writes.** **Agents can push and open pull requests** in **Settings → GitHub** is off by default. While it's off, GitHub tools are read-only and pushes are blocked.
- **Remote access.** Until you set it up in **Settings → Devices**, only this computer can open TOT.
- **Memory backup.** Nothing leaves your Mac except to your own paired devices, unless you turn on **Back up to a git remote**.

## Pushing to your main branch

With GitHub writes on, agents are told never to push to the default branch, force-push, delete branches or merge, unless you asked for that exact action. That's an instruction to the agent, not a lock in the code. If you need a hard guarantee, keep writes off, or connect a read-only token.

## Who can reach TOT

- **This computer** never signs in. Every other device needs your password, or a one-time code from your phone's QR scan.
- **Wrong guesses are slowed down**: too many, and TOT makes you wait.
- **You can sign out** any phone or browser in **Settings → Devices**, and it's out at once.
- **TOT listens only where you chose**: your Tailscale or home network address, never everywhere. Turn remote access off and it stops listening.
- **Paired Macs** can use each other's agents, but can't change each other's device settings or pairings.

## Your files and computers

- Agents run commands on their own computer, not on your Mac. A local computer is sandboxed by macOS: it writes only inside its own folder, and can't read your personal files.
- Each coding task works in its own copy of the code (a worktree), on its own `tot/…` branch.
- Files you list to copy into worktrees, like `.env`, are copied but never shown.
- Discarding a task never deletes a branch that was pushed.

## Your subscriptions

TOT is for your own, personal use of your Claude and ChatGPT plans, the way Claude Code and Codex use them. It doesn't host your plans for other people.
