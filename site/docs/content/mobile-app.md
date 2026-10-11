The TOT app for iPhone lets you manage every agent from your phone: on this Mac, and on every Mac paired with it. It's a window onto your own TOT, like a browser tab that stays signed in.

> The iPhone app is ready to build, but it isn't on the App Store or TestFlight yet: for now it runs from the code (the iOS Simulator, Expo Go, or your own TestFlight build; the steps are in the repo's `docs/roadmap/14-mobile.md`). Until then, your phone can use TOT in the browser: see [Devices](/docs/devices).

## How it works

- **Nothing runs on your phone.** Every chat, reply and file stays on the Mac its agent lives on. The app keeps your TOTs' addresses and sign-ins in the iPhone's Keychain, and the last lists it showed, so it can show them while your Mac can't be reached.
- **One sign-in, every Mac.** The app signs in to one TOT. If that TOT is paired with others, you see their agents too, each under its Mac's name.
- **Signed in like a browser.** The app shows up in **Settings → Devices** as "TOT app on <your phone>", and you can sign it out there. It's out at once.

- **When your Mac can't be reached** (asleep, or the phone is off its Wi‑Fi or Tailscale), the app says **Reconnecting to Mac mini…**, keeps showing what it loaded last, read-only, and picks up by itself when the Mac is back: replies that were streaming carry on. **Retry** tries at once.

## Connect

1. On your Mac, turn on remote access: **Settings → Devices → Set up**, a password, then Tailscale (recommended) or this Wi‑Fi.
2. Open **Add a phone** there.
3. In the app, tap **Scan QR code** and point it at the code. That's it: no password needed. The code works once, for 5 minutes.

Or type the Mac's address (it's shown in **Settings → Devices**, e.g. `100.101.4.2:5173`) and the password.

## What you can do

- [Available] **Every agent**, on this Mac and on paired Macs, with its mascot, a dot while one is working and **Needs you** when a chat waits for your OK. A paired Mac that's off keeps its agents on the list, asleep.
- [Available] **An agent's chats**: pinned first, then chats, then one section per project (tap its name to open the project). Long-press a chat to pin or delete it.
- [Available] **Chat**: send a message and watch the reply stream in; tap a tool step or "Thought for…" to open it; stop a reply. The **+** attaches photos from your library.
- [Available] **Approvals**: approve or decline right in the chat, including a project Lead's land and discard cards.
- [Available] **Tasks**: the layers button on the Agents screen opens every task from every Mac, sorted like mission control: Needs you, Working, Ready to land, Landed. A task's page shows its status, role and branch; type to add a note while it works, and use **…** to run it now, pause, resume or stop it, or to see its **Plan** and, for a coding task, its **Changes** (the files and the diff). Long-press a task row for the same.
- [Available] **Landing**: a finished coding task shows its changes and checks, with **Merge into main** (or **Open draft PR** for a GitHub project) and **Discard**, each asking first.
- [Available] **Projects**: a project's page lists its chats from every agent, and starts a new chat in it, in the main checkout or a new worktree. Its **…** starts or opens the project's Lead, or archives it. A new chat can start in any project.
- [Available] **Models**: tap the chat's title to pick its model: TOT Auto, then each account's models under its name (Claude, Claude Mix, ChatGPT…). A new chat picks one above its composer.
- [Available] **Agents**: an agent's **…** opens its settings: name, tagline, island, mascot (color, shape, eyes, accessory), instructions, default model and where its computer stands, and **Delete agent**. **New agent** sits under each Mac's agents.
- [Available] **Settings**: General (theme, your name, custom instructions, default model, memory), Models & accounts (each sign-in and its **…**: make it the default, rename it, use its MCP servers, turn it off; the providers' options; model tiers and task roles), Tasks (limits, restarts, worktree cleanup), Memory (what agents know about you, Dreaming, the history with Undo) and Devices (this Mac, the browsers and phones signed in, with Sign out, and paired Macs). Changes save as you make them.
- [Available] **Notifications**: when an agent needs your OK (a Lead's land card too), a task needs your input, is done or failed, or a reply finishes in a chat you aren't looking at. Tap one to open that chat or task. They come while the app is open or was just closed; when you open it again, it catches up on what you missed, once, and many at a time become one summary. **Settings → Notifications** turns each kind on or off, and shows the way to iOS Settings if notifications are off there.
- [Available] **Knowledge**: an agent's **…** opens its notebook, a project's **…** its knowledge. Tap the title to switch between the agent's notebook, the shared knowledge it uses and the projects. Search, read pages (and each repo's docs), see a project's **Facts** (add one, or tap one to delete it) and its **History** (open the pages a change touched, or undo it). Pages are edited on the computer.
- [Available] **Several Macs**: **Settings → TOT servers** keeps more than one TOT (say, home and work), shows which is open, opens another, removes one, and **Add a TOT** connects to another. Usually one is enough: it already shows its paired Macs' agents.
- [On the computer] Signing in to Claude or ChatGPT, adding accounts, GitHub, Slack, apps, personas and plugins: the app shows where each stands, and you set them up in TOT on your Mac.
- [On the computer] Editing knowledge pages, creating and setting up projects, form approvals, and a task's activity, checks and other tools.
- [Not yet] Notifications on a locked phone at any time (push): for now they come while the app is open or was just closed.
- [Not yet] The App Store and TestFlight, and Android (the app is built for it but hasn't been tried there).
