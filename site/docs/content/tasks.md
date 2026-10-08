A task is work that keeps going in the background. It's a chat that works on its own: it has a goal, a status, a plan it keeps as it goes, and, when it touches code, a branch of its own.

**Why you'd use it:** you keep chatting while the long work runs. A task keeps going when you close the tab, and picks up again after TOT restarts.

## How a task starts

- **Ask for real work in a chat.** "Fix the flaky checkout test" or "research these five vendors and compare them". The agent decides when to start a task, and can start several at once. Each one shows up in your chat as a live card.
- **/best-of**: type `/best-of` and a goal in the message box to run it twice, once per provider, then compare. See [Mission control](/docs/mission-control#best-of-two).
- **From a project's Lead.** A project's Lead chat plans and starts the project's tasks itself, across any of its repos, and watches every task in the project, not only the ones it started. See [Projects](/docs/projects#the-lead).
- **From Slack or email.** A request becomes a chat, and its agent starts tasks the same way.

Tasks aren't only for code. A research task gets everything except git. A coding task in a project with more than one repo works in just one of them.

## The task card

The card in your chat shows the task's title, its status, the latest line of progress, its branch, and how long it has run. It updates live. Press **Open** to see the task, or **View changes** when a coding task is done.

A task is always in one of these states: **Queued**, **Running**, **Needs input**, **Paused**, **Done**, **Failed**, **Stopped** or **Interrupted** (cut off by a restart).

## Inside a task

Open a task to see its conversation, like any chat. The header has **Pause** (or **Resume**) and **Stop**, and a button for the task's panel, with three tabs:

- **Plan**: the agent's own `PLAN.md`, kept on its computer and read here, plus its latest progress.
- **Changes**: every file it changed, for coding tasks. This is also where you land the code.
- **Activity**: what it did on its computer.

The **…** menu has **Rename**, **Copy worktree path**, **Open the computer**, **Continue on Claude** (or ChatGPT), **Turn back into a chat** and **Delete**.

## Steer, pause and stop

1. **Steer.** While a task runs, the message box says "Steer this task…". Type a note and send it. It reaches the agent mid-run, on Claude and on ChatGPT, without losing work.
2. **Pause** stops it for now. **Resume** carries on from where it was.
3. **Stop** ends it. Its worktree (its copy of the code) is kept.
4. **Pick it up again.** Reply to a finished or stopped task and it starts again with your reply.

When a task asks you something, its status turns to **Needs input** and the box says "Answer the task…".

## The queue

Each agent runs up to 4 tasks at once, and TOT runs up to 8 across all agents. Change these in **Settings → Tasks → Running at once**. More tasks wait their turn.

The sidebar's **Tasks** group shows **Queue · 3** when tasks are waiting. Open it to drag them into a new order, or press **Run now** to start one right away.

If a provider keeps failing, the queue pauses instead of failing every task in turn: "Queue paused: Claude kept failing." Press **Resume** when it's sorted. Usage limits never pause the queue.

## When you hear back

- **The chat hears back.** When its tasks finish, the agent reads the results and replies in the chat, even if it's in the middle of another reply. Turn this off in **Settings → Tasks → Tell the chat when its tasks finish**.
- **Notifications.** A toast when a task is done, failed or needs you, if you're not looking at it. If your browser allows notifications, you get those too while TOT is in the background.
- **Slack and email.** Tasks started there report back in the same thread. **Also tell me on Slack** in Settings → Tasks sends you a message too.
- **Nothing ends silently.** A stopped task, or one cut off by a restart, says so in its chat.

## After a restart

Tasks that were running when TOT stopped are marked **Interrupted**, then pick up again by themselves. That's **Resume interrupted tasks** in Settings → Tasks, on by default.

## Bigger jobs: many tasks at once

For a big job, the agent can split the work into several tasks, each with a role: explorer, planner, implementer, tester, reviewer, researcher or writer. Each role runs on a model tier (fast, standard or deep), and a reviewer always runs on the other provider from the work it reviews. They stack into one card in your chat ("6 tasks · 4 done · 2 paused"), a row each with its status icon, its latest line and how long it has run; click a row to open that task. As each one finishes, a one-line note under the card says so. When the tasks finish, their results come back to the chat as one answer.

A few limits keep this sane, all in **Settings → Tasks → Splitting work**:

- A chat or task can start up to 6 tasks.
- Tasks can start tasks, two levels deep.
- There's no token budget: a chat's tasks run until they're done.

### When a plan runs out mid-task

If Claude or ChatGPT hits its usage limit in the middle of a task, the task writes a short handoff note and carries on with the other provider. That's **Switch providers when one hits its limit**, on by default. Turned off, the task pauses ("Paused: Claude is at its usage limit until 7:30 AM. It resumes by itself.") and resumes when the limit resets.

You can also move a task yourself: **…** → **Continue on ChatGPT** (or Claude).

## Limits

- Playbooks (step-by-step recipes like Bug fix or Feature) don't drive tasks yet.
- Only chats can be forked, not tasks.
- An agent on one computer can't start a task for an agent on another computer.
