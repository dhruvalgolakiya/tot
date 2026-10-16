TOT.app is TOT as a normal Mac app. Double-click it and TOT opens in its own window. No terminal, no browser tab.

**Why you'd use it:** your phone and your other Macs can only reach TOT while it's running. The app keeps it running quietly in the menu bar, and can start when you log in.

> The Mac app is in private preview. It isn't signed by Apple and there's no public download yet. See [Install](/docs/install).

## What it does

- **Starts TOT for you**, with its own copy of Node built in, and opens it in a window. This computer never asks you to sign in.
- **Lives in the menu bar.** Close the window and TOT keeps running, so your phone and paired devices keep working. The first time, a notification says "TOT is still running in the menu bar."
- **Uses the same TOT** as running it from a terminal: the same port (8787) and the same data folder (`~/.tot`). If a TOT is already running, the app opens that one instead of starting a second.
- **Cleans up when you quit.** Quit stops TOT and everything it started.
- **Gets back up.** If TOT's server stops by itself, the app restarts it once. If it stops again within five minutes, the window says "TOT stopped", with **Restart** and **Show log**.
- **Follows your Mac's look**, light or dark, with no white flash.

## The menu bar menu

Click the two rings in the menu bar:

- **Open TOT**: shows the window.
- A status line: "Remote access: off", "Remote access: on · this Wi‑Fi" or "Remote access: on · Tailscale".
- **Open at login**: starts TOT when you log in to your Mac, so it's always reachable. It waits in the menu bar until you open it. You'll also find this in **Settings → General**.
- **Show log**: opens TOT's log in Console.
- **Quit TOT**: stops TOT. `⌘Q` does the same.

## Good to know

- You still log in to Claude and Codex once, in Terminal. See [Install](/docs/install).
- Links to other sites open in your default browser. TOT's own pages stay in the window.
- The window's size and place are remembered.
- Apps opened from Finder don't see your terminal's settings, so TOT reads your usual paths from your login shell. Tools you installed, like Homebrew's, still work.
- The log is at `~/Library/Logs/TOT/server.log`.

## Limits

- **Signed and notarized** with a Developer ID, so the .dmg opens on any Mac with no security warning. There's no public download yet.
- **No auto-update.** It needs signing and public releases first.
- **Apple silicon only.** No Intel build yet.
- **No dictation.** The mic button is hidden in the app.
- **It's big**: about 900 MB on disk, mostly Claude Code and Codex.
- No Windows or Linux version, and no Mac App Store version.
