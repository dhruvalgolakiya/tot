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
- **Check for Updates…**: looks for a new version now and tells you what it found. It's in the **TOT** menu too.
- **Show log**: opens TOT's log in Console.
- **Quit TOT**: stops TOT. `⌘Q` does the same.

## Updates

TOT keeps itself up to date. It checks for a new version a few seconds after it opens and every 4 hours after that, and downloads it in the background while you work.

- When it's ready, **Update ready** appears at the bottom of the sidebar. **Restart to update** installs it and opens TOT again. Chats and tasks still running stop when TOT restarts.
- Not now? Close it with **×**. The update installs the next time you quit TOT anyway, and the prompt is back the next time TOT opens.
- **Check for Updates…** (menu bar menu or the **TOT** menu) checks right away and says "You're up to date", or what it found.
- TOT updates itself once it's in your Applications folder. Run straight from the disk image, it can't replace itself.
- No connection, or nothing new: nothing happens and nothing pops up. The log notes each check.

New versions are published as [GitHub releases](https://github.com/dhruvalgolakiya/tot/releases): a .dmg for a fresh install, plus the files the app updates from.

## Good to know

- You still log in to Claude and Codex once, in Terminal. See [Install](/docs/install).
- Links to other sites open in your default browser. TOT's own pages stay in the window.
- The window's size and place are remembered.
- Apps opened from Finder don't see your terminal's settings, so TOT reads your usual paths from your login shell. Tools you installed, like Homebrew's, still work.
- The log is at `~/Library/Logs/TOT/server.log`.

## Limits

- **Signed and notarized** with a Developer ID, so the .dmg opens on any Mac with no security warning. There's no public download yet.
- **Apple silicon only.** No Intel build yet.
- **No dictation.** The mic button is hidden in the app.
- **It's big**: about 900 MB on disk, mostly Claude Code and Codex.
- No Windows or Linux version, and no Mac App Store version.
