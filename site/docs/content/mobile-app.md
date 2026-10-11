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
- [Available] **An agent's chats**: pinned first, then chats, then one section per project. Long-press a chat to pin or delete it.
- [Available] **Chat**: send a message and watch the reply stream in; tap a tool step or "Thought for…" to open it; stop a reply.
- [Available] **Approvals**: approve or decline right in the chat, including a project Lead's land and discard cards.
- [Not yet] Tasks and mission control: steer, pause, land.
- [Not yet] Projects, the model picker, and TOT's settings (models and accounts, memory, devices).
- [Not yet] Notifications when an agent needs you or a task is done.
