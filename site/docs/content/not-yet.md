TOT is young. Here's what it doesn't do today, in plain words, grouped by area. Most of it is planned. A few things it will never do, on purpose; those are at the end.

## Pull requests, after they're open

TOT opens a draft pull request for you, and then stops. It doesn't yet:

- show the pull request's CI checks, or tell you when they fail;
- bring reviewers' comments back to the task and fix them;
- push updates to the branch when the main branch moves on;
- mark the pull request ready for review, or close it;
- offer keyboard shortcuts for all of that, or try one automatic fix when checks fail.

For now you do these on GitHub. **Update from main** works for tasks that haven't landed yet.

## Playbooks and automatic review

TOT has playbooks (step-by-step recipes like Bug fix, Feature and Refactor), a plan you approve before work starts, and an independent review by the other provider. They're set up in **Settings → Workflows**, but they don't drive tasks yet. Today, a finished task runs the project's own checks, and you review the changes.

## Coding

- **Stacked pull requests**, where one task builds on another's branch. Every task starts from the main branch.
- **Preview on cloud computers.** A task's Preview link works on local computers only.

## Projects and computers

- **Folders on your Mac, on cloud computers.** An agent with a cloud computer can't open a folder project yet. The plan is to send the folder over and bring each branch back.
- **Node in the Mac app's local computers.** In the Mac app, on a Mac without Node installed, agents on a local computer have no `node`.

## Your devices

- **A phone app.** There's no iPhone or Android app. TOT works in your phone's browser, and from your home screen as a web app.
- **Moving an agent** from one Mac to another.
- **Agents working across Macs**: an agent on one Mac starting a task for an agent on another.
- **Previews from other screens.** A task's Preview opens on its own Mac only.
- **Offline Macs.** While a paired Mac is off, you can't read its chats.
- **Project memory on more than one Mac.** Only your About you memory follows you.

## The Mac app

- **A public download**, signed and notarized by Apple. It needs an Apple Developer account first.
- **Auto-update.**
- **Intel Macs.** The app is for Apple silicon only.
- **A smaller app.** It's about 900 MB, mostly Claude Code and Codex.
- **Dictation.** The mic button is hidden in the app, because it has no speech service to use. It works in the browser.

## Smaller things

- Mascots don't act out thinking or talking yet; they show working, idle and asleep.
- **Search chats** looks at titles only.
- You can attach chats of the same agent only, and you can fork chats but not tasks.

## Platforms and hosting

- **Windows and Linux.** TOT runs on macOS only.
- **Public code.** TOT is in private preview.
- **A hosted TOT for other people.** It would need API keys for Claude, since Anthropic doesn't let other products use claude.ai logins without approval, and OpenAI's partner program for ChatGPT plans.

## Never, on purpose

- **Merging pull requests on GitHub.** Merging stays with you.
- **A Mac App Store version.** Its sandbox can't run Claude Code, Codex or the agents' local computers.
- **A TOT cloud, accounts or a relay.** Your devices talk to each other directly, ideally over Tailscale.
- **Sharing with other people.** TOT is for one person: you, on your own computers.
