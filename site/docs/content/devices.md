TOT runs on your Mac, but you can use it from anywhere: your phone on the couch, your laptop on a trip. And if you run TOT on two Macs, you can pair them, so each can use the other's agents.

Two words help here:

- A **device** is a computer running TOT. It keeps its own agents, chats, projects and logins.
- A **screen** is anywhere you look at TOT: a device's own window, a browser, your phone. A screen keeps nothing.

## This computer never signs in

TOT only answers this computer until you turn on remote access. The computer it runs on never asks for a password. Other devices do.

## Use TOT from your phone

1. On your Mac, open **Settings → Devices** and press **Set up**.
2. **Choose a password.** Other browsers sign in with it once. Your phone can scan a code instead.
3. **Pick how other devices reach this Mac:**
   - **Anywhere, with Tailscale** (recommended). [Tailscale](https://tailscale.com) is an app that links your devices privately, wherever they are. Install it on your Mac and your phone, signed in to the same account. It's private and encrypted.
   - **Only on this Wi‑Fi.** Your phone must be on the same network. It isn't encrypted, so use it only on networks you trust.

   If your Mac asks whether to accept incoming connections, choose **Allow**.
4. **Add your phone.** Point your phone's camera at the code. It opens TOT signed in, no password needed. The code works once, for 5 minutes; press **New code** for another.
5. **Keep it on your home screen.** In Safari, choose **Add to Home Screen** from the Share menu (in Chrome, it's in the ⋮ menu). TOT then opens full screen, with its own icon.

## Manage who's signed in

**Settings → Devices** shows:

- **This device**: its name, its address, and the **Remote access** switch. Turn it off and only this computer can open TOT again. Your password is kept.
- **Signed in**: every phone and browser signed in, with **Sign out** on each, and **Sign out all others**. A device you sign out is out at once.
- Changing the password signs out every other browser and phone.

Forgot the password? Set a new one on the Mac that runs TOT. It never asks for it.

## Pair two Macs

Install TOT on your other Mac (see [Install](/docs/install)). Then pair them once, and each shows the other's agents in its rail, with a small laptop badge.

1. Turn on remote access on **both** Macs: **Settings → Devices → Set up**, a password each, and Tailscale on both (or the same Wi‑Fi, at home only).
2. On one Mac, open **Settings → Devices → Pair a device** and press **Copy link**. The link works once, for 5 minutes.
3. On the other Mac, open the same **Pair a device** dialog and paste the link into **Paste the link from the other device**. Press **Pair**.

One paste pairs them both ways: "Paired with … Its agents are in your rail." Don't copy one Mac's `.env` file to the other: tokens and keys belong to one computer.

### What pairing does

- **An agent lives on one Mac.** When you chat with your MacBook's agent from your Mac mini, the work runs on the MacBook: its model login, computer, folders and files. The Mac mini just shows it, live, and so does the MacBook's own window.
- **Nothing is copied.** Each Mac keeps its own agents, chats, projects and settings. Your **About you** memory is the one thing that follows you; see [Memory](/docs/memory).
- **Logins stay put.** Claude, ChatGPT, Boat, GitHub, Slack, email and apps are set up on each Mac itself.
- **When a Mac is off**, its agents fade in the rail. Their chats are safe on it; you just can't reach them until it's back.
- **Unpair from either side**, and both forget each other. Nothing is deleted.

If one Mac can't reach the other's address, pairing still works one way, and TOT says so. Tailscale on both fixes it.

## Limits

- There's no iPhone or Android app. Your phone uses TOT in the browser, or from your home screen as a web app.
- Voice input needs HTTPS. Over a plain `http://` address, the mic button hides.
- Agents can't move from one Mac to another yet.
- An agent on one Mac can't start a task for an agent on another.
- An agent's **Preview** links work on its own Mac; they don't open from your other screens yet.
- While a Mac is off, you can't read its chats from another device.
- Pairing doesn't chain: a Mac shows only the Macs it paired with itself.
- TOT is for you alone. Pairing is for your own computers, not for sharing with other people.
