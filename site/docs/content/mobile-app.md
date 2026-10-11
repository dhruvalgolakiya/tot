The TOT app for iPhone lets you manage every agent from your phone: on this Mac, and on every Mac paired with it. It's a window onto your own TOT, like a browser tab that stays signed in.

> The iPhone app is in development. It isn't on the App Store or TestFlight yet; for now it runs from the code, in the iOS Simulator or Expo Go. Until then, your phone can use TOT in the browser: see [Devices](/docs/devices).

## How it works

- **Nothing runs on your phone.** Every chat, reply and file stays on the Mac its agent lives on. The app keeps two things, in the iPhone's Keychain: your TOT's address and its sign-in.
- **One sign-in, every Mac.** The app signs in to one TOT. If that TOT is paired with others, you see their agents too, each under its Mac's name.
- **Signed in like a browser.** The app shows up in **Settings → Devices** as "TOT app on <your phone>", and you can sign it out there. It's out at once.

## Connect

1. On your Mac, turn on remote access: **Settings → Devices → Set up**, a password, then Tailscale (recommended) or this Wi‑Fi.
2. Open **Add a phone** there.
3. In the app, tap **Scan QR code** and point it at the code. That's it: no password needed. The code works once, for 5 minutes.

Or type the Mac's address (it's shown in **Settings → Devices**, e.g. `100.101.4.2:5173`) and the password.

## What you can do

- [Available] **Every agent**, on this Mac and on paired Macs, with a dot while one is working and **Needs you** when a chat waits for your OK.
- [Available] **An agent's chats**: pinned first, then chats, then one section per project (tap its name to open the project). Long-press a chat to pin or delete it.
- [Available] **Chat**: send a message and watch the reply stream in; tap a tool step or "Thought for…" to open it; stop a reply.
- [Available] **Approvals**: approve or decline right in the chat, including a project Lead's land and discard cards.
- [Available] **Tasks**: the layers button on the Agents screen opens every task from every Mac, sorted like mission control: Needs you, Working, Ready to land, Landed. A task's page shows its status, role and branch; type to add a note while it works, and use **…** to run it now, pause, resume or stop it. Long-press a task row for the same.
- [Available] **Landing**: a finished coding task shows its changes and checks, with **Merge into main** (or **Open draft PR** for a GitHub project) and **Discard**, each asking first.
- [Available] **Projects**: a project's page lists its chats from every agent, and starts a new chat in it, in the main checkout or a new worktree. Its **…** starts or opens the project's Lead, or archives it. A new chat can start in any project.
- [Available] **Models**: tap the chat's title to pick its model: TOT Auto, then each account's models under its name (Claude, Claude Mix, ChatGPT…). A new chat picks one above its composer.
- [Available] **Agents**: an agent's **…** opens its settings: name, tagline, island, mascot (color, shape, eyes, accessory), instructions, default model and where its computer stands, and **Delete agent**. **New agent** sits under each Mac's agents.
- [Available] **Settings**: General (theme, your name, custom instructions, default model, memory), Models & accounts (each sign-in and its **…**: make it the default, rename it, use its MCP servers, turn it off; the providers' options; model tiers and task roles), Tasks (limits, restarts, worktree cleanup), Memory (what agents know about you, Dreaming, the history with Undo) and Devices (this Mac, the browsers and phones signed in, with Sign out, and paired Macs). Changes save as you make them.
- [On the computer] Signing in to Claude or ChatGPT, adding accounts, GitHub, Slack, apps, personas and plugins: the app shows where each stands, and you set them up in TOT on your Mac.
- [Not yet] Notifications when an agent needs you or a task is done.
