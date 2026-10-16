Agents get more done when they can reach your other tools: your code on GitHub, your team in Slack, your inbox, your calendar. You connect each one once, in **Settings**, and decide what agents may do with it.

## GitHub

Connect GitHub so agents can read issues and pull requests, clone private repos, and, if you allow it, push branches and open pull requests.

1. Open **Settings → GitHub**.
2. Press the button TOT offers: **Connect as @you** (if the GitHub command-line tool is already logged in on this Mac), **Sign in with GitHub**, or **Use a token**.

**Writes are off by default.** The switch **Agents can push and open pull requests** decides:

- **Off**: GitHub tools are read-only, and pushes are blocked.
- **On**: agents work on branches and open pull requests when you ask. They're told never to push to the main branch, force-push or merge, unless you ask for that exact action — but that's an instruction, not something the code enforces. See [Safety](/docs/safety#pushing-to-your-main-branch).

Whatever the switch says, agents have no tool to merge a pull request. You merge on GitHub yourself. For a hard guarantee against pushes to the main branch, connect a read-only token.

## Slack

Message your agents from Slack. Each Slack thread becomes a chat in TOT, with the thread so far as context.

1. Open **Settings → Slack** and press **Create the Slack app**. It uses a ready-made app definition.
2. In the app's **Basic Information**, create an app-level token with the `connections:write` scope.
3. **Install to Workspace**, then copy the bot token.
4. Paste both tokens and press **Connect**.

Then DM the bot, or @mention it in a channel. Start with an agent's name to pick one ("Puddin: summarize this thread"); otherwise the **Default agent** answers.

- **Only people you allow** can use it. Anyone else is told so, and shows up under **Requests** for you to **Allow**.
- **Approvals come to Slack too**: "Needs your OK" with **Approve** and **Deny** buttons.
- When the agent's tasks finish, the result lands back in the thread.

## Email and personas

A persona gives an agent its own email address and GitHub account, so its sign-ups, emails and commits show up as the agent, not as you.

1. Open **Settings → Personas** and press **New persona**. Give it a **Name** (shown as the sender and the git author) and an **Email**: a real mailbox, like a free Gmail account made for the agent.
2. Connect its mailbox. For Gmail: turn on 2-Step Verification, create an app password, and paste it.
3. In the agent's settings, set **Works as** to the persona.
4. Optional: give the persona its own GitHub account and token, under **GitHub** on its page.

**Sending email always asks you first.** The agent shows a card, "Send this email as …?", with who it's to, the subject and a preview, and **Approve** and **Deny**. Nothing is sent until you approve.

**Email tasks.** Under **Email tasks**, list the **Allowed senders**. Only authenticated mail from those addresses becomes a chat and gets an answer. Everything else, including a faked "From", is just stored for the agent to read.

## Apps: Gmail, Linear, Notion and more

**Settings → Apps** connects other services once, for every agent. It's powered by Executor, an open-source tool TOT installs on this Mac (about 90 MB) when you press **Set up**.

1. Press **Set up** and wait for it to install and start.
2. Under **Add apps**, search for an app and connect it: some need you to **Sign in**, some an **API key**. Google apps need an OAuth app of your own; TOT walks you through it.
3. Open a connected app to set its **Approval rules**: for all actions, or each one, choose **Allowed**, **Ask me** or **Blocked**.

New apps start at **Ask me**: actions that change things show you a card first, with **Approve** and **Deny**. Signing in to an app finishes on the Mac that runs TOT; once connected, it works from every device.

## Connectors you already have

If you set up connectors on claude.ai, or apps on your ChatGPT account, TOT can use them. Turn on **Use my claude.ai connectors** or **Use my ChatGPT connected apps** in **Settings → Models & accounts**.

## Plugins (MCP)

Plugins add tools from any MCP server, the standard way to give AI models extra tools. TOT's own computer, memory and GitHub tools are built in.

1. Open **Settings → Plugins** and press **Add plugin**.
2. Pick a **Plugin type**: **HTTP** (a remote server's URL, plus any headers) or **stdio** (a command TOT starts on this Mac, with arguments and environment).
3. Under **Available to**, choose Claude, ChatGPT or both.

## Approvals, in short

When an agent wants to do something that needs you, its chat shows a card with **Approve** and **Deny** (or a form to fill in). It waits about a minute. If you don't answer, it's declined. The exception is a project's Lead: its cards to land or discard a task wait for you as long as it takes; see [Projects](/docs/projects#the-lead).

## Limits

- Each computer keeps its own logins: GitHub, Slack, email and apps are set up per Mac. If two paired Macs connect the same Slack bot or mailbox, both would answer, and **Settings → Devices** warns you.
- TOT doesn't follow your pull requests after they're open: no CI checks, review comments or merges from TOT.
- Approval cards expire after about a minute.
