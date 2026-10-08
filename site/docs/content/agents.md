An agent is a helper with a name, a mascot, standing instructions, a default model and a computer of its own. Tot is your first one. Make as many as you like: a researcher, a coder, one that only writes your weekly recap.

Each agent has its own chats, its own notebook and its own routines. What any agent learns about you is shared with all of them.

## Make an agent

1. Press **+** (**New agent**) at the bottom of the agent rail, the column of mascots on the left.
2. Build its **Mascot**: a shape, a color, eyes and an accessory, or press **Surprise me**. TOT suggests a name to match.
3. Write its **Instructions**: its personality and how it should work. They're added to every chat with this agent.
4. Pick a **Default model**. New chats with this agent start there.
5. Optional: set **Works as** to a persona, so it has its own email and GitHub account. See [Apps and plugins](/docs/apps).
6. Press **Create agent**.

To change an agent later, click its name above its chat list and choose **Settings**.

### The mascots

Shapes: blob, cloud, pear, star, heart, droplet, bot, ghost, frog and cat. Twelve colors (or your own), four kinds of eyes, and accessories from glasses and a bow tie to headphones, a crown or a scarf.

A mascot is more than decoration. It shows how its agent is doing: busy while it works, idle when it's free, and asleep when its computer is stopped. In a chat, a line under the reply says what the agent is doing right now, like "Tot is using the computer…".

## Chat with an agent

Type in the box at the bottom and press Enter. Replies appear as they're written. If you reload the page mid-reply, it picks up where it was.

- **Attach files.** Press **+**, paste, or drop files on the chat. Up to 10 files, 25 MB each. The model sees images, reads text and code files, and anything else is copied to the agent's computer, in `~/uploads`.
- **Talk instead of typing.** The mic button turns your voice into text. It needs a secure connection (HTTPS, or TOT on this computer) and a browser that supports it, so it doesn't show in Firefox or in the Mac app.
- **Find a chat.** **Search chats** at the top of the list filters by title. Your agent can also search what was said in earlier chats.
- **Tidy up.** Each chat's **…** menu has **Rename**, **Pin**, **Move to project** and **Delete**.

### Fork a chat, and bring it back

Want to chase an idea without derailing a chat? Choose **Fork chat** in the chat's **…** menu, or **Fork from here** on any reply. You get a copy, "Fork of …", that knows everything up to that point. When you're done, choose **Bring back to …** in the fork's menu: the original chat gets a note with what the fork found, which its agent reads before its next reply.

### Point at another chat

Type `@` in the message box to attach up to 3 of this agent's other chats as reference, or drag a chat from the sidebar onto the box. The agent reads them as background, not as new instructions: "what did we decide there?" just works.

## Models

Pick a model from the menu at the top of the chat.

- **TOT Auto** (the default) picks for you, message by message. Quick asks go to Claude Sonnet 5.5, which is fast. Coding, debugging, research, analysis and long messages go to Claude Opus 5.5. When Claude isn't connected, or your plan is at its limit, it uses ChatGPT. Hover the model name under a reply to see why it was picked, like "Auto · coding task → Opus 5.5".
- **Claude**: Claude Opus 5.5 for the deepest reasoning, Claude Sonnet 5.5 for everyday work, and Claude Fable 5.1 when your account offers it.
- **ChatGPT**: the models your ChatGPT account offers, listed live, with its default first.

### When a plan runs out

Claude and ChatGPT plans have usage limits. When one hits its limit, TOT remembers until when, and **TOT Auto** moves to the other one. The chat says so, like "Claude is at its usage limit (resets 7:30am) — switched to ChatGPT." If you picked a model yourself, the reply stops with a note instead. Background tasks can switch too; see [Tasks](/docs/tasks).

### Model tiers (optional)

TOT runs each turn on a tier: **Fast** for quick asks, **Standard** for most work, **Deep** for the hard change. **Settings → Models → Model tiers** lets you choose the model behind each tier, for Claude and for ChatGPT. You don't have to touch it.

**Settings → Models** also has two switches: **Use my claude.ai connectors** and **Use my ChatGPT connected apps**. They let each model use the connectors (like Gmail or Drive) you already set up on those accounts.

## Brains: your agents' wiki

Memory holds short facts (see [Memory](/docs/memory)). Brains hold longer notes: pages in a wiki.

- **Every agent has a private Notebook.** Its pinned **Overview** page goes into every chat with that agent.
- **Shared brains** cover a repo or a topic, and you choose which agents can read or write them (**Brain settings…**: No access, Can read, Can read & write). A shared brain's Overview is shown to the agent when you mention one of its keywords.
- **Open them** from the agent's name → **Brains**, or a project's **…** menu → **Brain**.

To teach an agent a codebase, open a brain's page list, press **+** and choose **Learn a repo…**. The agent clones it, studies every part, and writes it up as the repo's own brain, which your other agents can share. Learning it again later only re-studies what changed. It needs a computer.

Every page has **Edit** and **History**, and a box at the bottom to ask the agent about it.

**The wiki keeper.** When a chat has been quiet for a few minutes, TOT reads it and files anything worth keeping into the agent's brains. The chat gets a small note, "Updated the wiki: …". It never copies secrets.

## Routines

A routine is something an agent does on a schedule, without you asking: "every weekday at 9, brief me on AI news".

1. Just ask in chat, and the agent schedules it. Or click the agent's name → **Routines** → **New routine**.
2. Give it a **Name**, a **Prompt** (what to do each time) and a schedule: **Daily** at a time on chosen days, or every so many minutes or hours (at least 15 minutes).

Each run starts a new chat, marked with a clock, so you can read it whenever you like. A routine's menu has **Run now**, **Edit** and **Delete**, and a switch to pause it. If TOT was off when a routine was due, it runs once soon after TOT starts.

## Limits

- Mascots show working, idle and asleep. They don't act out thinking or talking in the app yet.
- **Search chats** matches titles only.
- You can attach chats of the same agent only, and you can't fork a task (only a chat).
- No voice input in the Mac app or in Firefox.
