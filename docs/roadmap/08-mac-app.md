# 08 · Mac app: TOT as an app you open from the Dock

**Lane:** worktree `~/playground/tot-mac`, branch `feat/mac-app`, created from `main`. **Depends on:** 07 (remote access, "this computer never signs in", `/.well-known/tot`). **Overlaps:** none on the server beyond one line in `server/index.ts`; the web-UI side (`src/lib/desktop.ts`, the title-bar inset, Open at login in Settings → General) was built in parallel against the bridge below.

Read [README.md](README.md) first.

## Goal

Today TOT is `git clone`, `npm install`, `npm run dev` and a browser tab. That's fine for a developer and a wall for everyone else, and it makes a device (module 07) only as reachable as the terminal it was started in.

This module packages TOT as **TOT.app**: double-click it, and TOT runs in its own window. Close the window and TOT keeps running in the menu bar, so your phone and paired devices keep working. Quit stops everything it started.

The bar, as in 06 and 07: **a new user should understand it on first sight.** One window, one menu bar icon, a six-item menu.

## How it works

```
 TOT.app (Electron main)
   │  spawns, with its own Node (ELECTRON_RUN_AS_NODE=1)
   ▼
 TOT server: dist-app/server.mjs (esbuild bundle of server/index.ts), cwd = the app folder with dist/
   │  codex, Claude Code, Executor … in the server's own process group
   ▼
 window ──▶ http://localhost:<TOT_PORT or 8787>/   (a loopback name: this computer never signs in)
```

- **Attach first.** Before starting a server the app asks `http://127.0.0.1:<port>/.well-known/tot`. A TOT there (`npm run dev`, `npm start`, another copy) is opened instead of starting a second one, and Quit leaves it running. Anything else on the port gets a "Port 8787 is in use" page.
- **One TOT per Mac.** The app uses the same port and data folder (`~/.tot`) as `npm start`, so it's the same TOT, not a second one.

## Decisions

**Server runtime: Electron's own Node.** Electron 44.5.1 ships Node 24.21.0 with `node:sqlite` (FTS5 included), above the 22.13 floor, so the app doesn't bundle a separate Node. The server runs as `process.execPath` with `ELECTRON_RUN_AS_NODE=1` on an esbuild bundle (ESM, `packages: "external"`: npm packages stay in `node_modules`, where the server finds codex and Claude Code by `createRequire`). `server/index.ts` deletes `ELECTRON_RUN_AS_NODE` at startup so its children don't inherit it.

**PATH for an app opened from Finder.** Finder gives apps launchd's `/usr/bin:/bin:/usr/sbin:/sbin`. At launch the app runs `$SHELL -ilc` (4 s limit) with markers around `$PATH`, adds `/opt/homebrew/bin` and `/usr/local/bin`, and **appends** `~/Library/Application Support/TOT/bin`. That folder holds three shims, rewritten at every launch (the app may have moved): `node` runs TOT.app as Node, `npm` and `npx` run the npm bundled with the app (a dependency, `npm@11`). The user's own Node, when there is one, comes first. Executor's install (`npm install`), its `#!/usr/bin/env node` programs and MCP plugins (`npx …`) work on a Mac with no Node at all.

**Lifecycle.**

- One copy at a time: opening TOT again shows the running window.
- Closing the window hides it and the Dock icon; TOT stays in the menu bar. The first time, a notification says "TOT is still running in the menu bar."
- Quit (Cmd+Q, the menu bar's Quit TOT, the Dock, logging out) sends SIGTERM to the server, waits up to 5 s, then SIGKILLs whatever is left of the server's process group. The server runs in a group of its own (`detached`), so nothing it started survives: codex, Executor, Claude Code.
- If the server stops unexpectedly, the app ends what it left behind and restarts it once; a second stop within five minutes shows "TOT stopped" with Restart and Show log.
- If the app itself dies (a crash, Force Quit), launchd adopts the server, which notices its parent changed and shuts itself down within 2 s (`electron/server-entry.ts`).

**Menu bar.** A template image of the two rings (black on transparent, @1x and @2x, macOS tints it), and a menu kept to six things: **Open TOT**, a status line from `GET /api/devices` → `access.mode` ("Remote access: off", "Remote access: on · this Wi‑Fi", "Remote access: on · Tailscale"), **Open at login**, **Check for Updates…**, **Show log**, **Quit TOT**. The menu is built on each click, so the status line is current.

**Window.**

- `titleBarStyle: "hiddenInset"`, traffic lights at `{ x: 14, y: 21 }`: centred in the web app's 80 px rail and level with its 56 px top bars.
- Minimum 800 × 520: the web app switches to its phone layout below 768 px, which has no room for the traffic lights.
- Size and place are remembered (`state.json` in the app's data folder) and moved back on screen if a display is gone.
- The background follows macOS (`#212121` dark, `#ffffff` light): no white flash.
- TOT's own pages stay in the window; every other link (another port too, e.g. Executor's) opens in the default browser.
- Edit, View and Window menus, so copy and paste work. DevTools only from a checkout or with `TOT_DEVTOOLS=1`.
- Web permissions: TOT's pages get notifications, clipboard writes and full screen; nothing else, and no other page. No microphone: dictation is hidden in the app (below).

**The bridge** (`electron/preload.ts`, sandboxed and context-isolated). Exactly this, and only TOT's own origin may call it:

```ts
window.totDesktop = {
  platform: "darwin", version: string,
  getOpenAtLogin(): Promise<boolean>, setOpenAtLogin(open: boolean): Promise<boolean>,
  pickFolder(): Promise<string | null>,
  updates: { onState(listener: (state: UpdateState) => void): () => void, install(): Promise<void>, dismiss(): Promise<void> },
}
```

`setOpenAtLogin` resolves to the new state. From a checkout (`npm run app:dev`) it changes nothing and resolves to `false`: it would register Electron's own app as a login item. Started at login, TOT stays in the menu bar until opened.

**Logs.** The server writes straight into `~/Library/Logs/TOT/server.log` (so it keeps logging even if the app crashes), with the app's own lines tagged `[app]`. The log is emptied at launch once it passes 10 MB. Show log opens it in Console.

**Packaging** (`electron/builder.config.ts`, electron-builder):

- Apple silicon only; a `.dmg` and a `.zip` in `release/`; app id `com.golakiya.tot`.
- No asar: the server's working directory, `dist/` and the binaries it spawns need real paths. It costs size (below).
- Signed ad hoc by default. With `CSC_LINK`/`CSC_NAME` set it signs with that Developer ID and turns on the hardened runtime. `npm run app:release` (`electron/release.sh`) does that with the Developer ID Application certificate in `~/.private_keys` (its password in the keychain item `tot-devid-p12`), notarizes the app through electron-builder with an App Store Connect API key, then notarizes and staples the signed .dmg and checks both with `spctl`. Done 2026-10-11. Codex's and Claude Code's own binaries keep their vendors' signatures (`signIgnore`).
- Publishes nothing itself (`--publish never`), but `publish` names the GitHub releases of `dhruvalgolakiya/tot`, so the build writes `app-update.yml` into the app and `latest-mac.yml` plus the zip's `.blockmap` into `release/` (below).

**Updates** (`electron/updates.ts`, electron-updater, GitHub provider; only the installed app, `app.isPackaged`):

- The app asks GitHub for the latest release 10 s after launch and every 4 hours (`releases.atom`, then that release's `latest-mac.yml`: no token, so the repo must be public). A newer version downloads in the background (`autoDownload`), Squirrel.Mac unpacks and verifies it, and it installs the next time TOT quits (`autoInstallOnAppQuit`). No check while one downloads or waits for a restart.
- Once Squirrel.Mac has it staged, the web app shows **Update ready · TOT 0.1.2** at the foot of the sidebar, with **Restart to update** and a dismiss (×), which hides it until TOT next starts (`src/components/UpdatePrompt.tsx`, through `window.totDesktop.updates`). Restart to update quits for real: the window closes instead of hiding, before-quit stops the server, and TOT opens again on the new version. In a browser nothing shows.
- **Check for Updates…** in the app menu and the menu bar menu is the only thing that answers in a dialog: "You're up to date", "Downloading TOT 0.1.3", "TOT 0.1.3 is ready to install" (Restart / Later), or why it couldn't check (no published release, offline, running from the disk image). Background checks never show anything; every check, download and failure is one `[app] Updates: …` line in the log.
- macOS updates from the `.zip`. The `.dmg` is for first installs and stays out of `latest-mac.yml` (`dmg.writeUpdateInfo: false`), since release.sh staples it after the build. Squirrel.Mac only installs an update signed with the same Developer ID as the running app, so ad hoc builds (`app:build`) must never be published.
- The pure parts (the prompt's state, the dialogs' words, one-line failures) are `electron/update-state.ts`, tested in `electron/updates.test.ts`.

**Releasing a version:**

1. Bump the version in `package.json` and `server/config.ts` (`VERSION`), commit, and push.
2. `npm run app:release`: the signed, notarized build. It ends by listing what to upload: `TOT-<version>-arm64.dmg`, `TOT-<version>-arm64-mac.zip`, its `.blockmap` and `latest-mac.yml`.
3. Try the build, then `npm run app:publish` (`electron/publish.sh`): `gh release create v<version>` on `dhruvalgolakiya/tot` as the `dhruvalgolakiya` gh login, titled "TOT <version> (Mac)", uploading those four files. It refuses unless `latest-mac.yml` matches this version and the zip's checksum, every file it names is uploaded under that exact, GitHub-safe name (no spaces), the app is Developer ID signed and the .dmg stapled, the tree is committed and HEAD pushed, and the release doesn't exist yet. `--notes-file <file>` for release notes, `--draft` for a draft (the apps don't see drafts until they're published). `electron/publish.sh --list` only checks and lists.

Installed apps pick the release up within 4 hours, or at once from Check for Updates…. 0.1.1 and older have no updater: install the first version with updates from its .dmg.

**The icon.** The two rings from `public/tot.svg` on a dark plate, on Apple's 1024 px grid (an 824 px superellipse, n = 5, the continuous corner of macOS icons), with a soft shadow, a faint glow under the rings, a hairline highlight that holds the edge on a dark Dock, and a faint grain so the plate's gradient doesn't band. `electron/icons.ts` draws the SVGs and renders the PNGs with headless Chrome.

## What's built

| File | What |
|------|------|
| `electron/main.ts` | Lifecycle, window, menu bar, app menu, the bridge's IPC, permissions |
| `electron/server-process.ts` | Starting, waiting for, stopping and sweeping the server; the log |
| `electron/server-entry.ts` | The bundled server's entry: `server/index.ts` plus the parent watch |
| `electron/probe.ts` | `/.well-known/tot` (attach, start or "port in use"), the status line |
| `electron/shell-env.ts` | Login-shell PATH, merging, the node/npm/npx shims |
| `electron/window-rules.ts` | Where the window opens; which links stay in it |
| `electron/pages.ts` | "Starting TOT…", "TOT stopped", "Port 8787 is in use", "Can't reach TOT" |
| `electron/preload.ts` | `window.totDesktop` |
| `electron/updates.ts`, `electron/update-state.ts` | Updates: checking, downloading, the prompt's state, Check for Updates… |
| `electron/release.sh`, `electron/publish.sh` | The signed, notarized build; the GitHub release |
| `electron/build.ts` | esbuild: `dist-app/main.cjs`, `preload.cjs`, `server.mjs` |
| `electron/builder.config.ts` | electron-builder |
| `electron/icons.ts`, `electron/resources/` | The icons (SVG sources and PNGs) |
| `electron/desktop.test.ts` | PATH, shims (run for real), attach decision (over real sockets), window placement, links, the log cap |
| `electron/updates.test.ts` | The update prompt's state, failure lines and wording, Check for Updates…'s answers |
| `src/components/UpdatePrompt.tsx`, `src/hooks/useAppUpdate.ts` | "Update ready" at the foot of the sidebar |
| `server/index.ts` | One line: forget `ELECTRON_RUN_AS_NODE` |

Scripts: `npm run app:dev` (build the bundles, run Electron from the checkout: it opens a running dev TOT or starts the bundled server, which needs `npm run build` once) and `npm run app:build` (web app, bundles, `release/TOT-<version>-arm64.dmg` and `.zip`, signed ad hoc), `npm run app:release` (the same, signed and notarized) and `npm run app:publish` (the GitHub release).

Size: TOT.app is 919 MB on disk (`node_modules` 618 MB, of which codex is 332 MB and Claude Code 225 MB); the `.dmg` is 370 MB. The frontend packages (react, mermaid, katex, lucide…) are devDependencies: the web app is built into `dist/` before packing, and the server never loads them, so they stay out of the app.

## Milestones

- [x] **M1 · TOT.app.**
  - *Accept:*
    - Opened from Finder (launchd's PATH), the window shows TOT without signing in.
    - Codex and Claude Code start under that PATH; `npm -v` works through the shim with no other Node.
    - Closing the window keeps TOT and the menu bar icon; opening it again shows the window.
    - Quit leaves no TOT, codex, Executor or Claude Code process.
    - A second launch shows the first.
    - With a TOT already on the port, the app opens it and Quit leaves it running.
  - *Shipped:* everything above, checked live on the packaged app (temp data, port 8807): sign-in-free window in both themes, both providers logged in through the GUI-launched server, the shims, close → menu bar (no Dock icon, status item present) → reopen, a second launch handing over to the first, a killed server restarting once and then showing "TOT stopped" (Restart works), Quit with codex and Executor running leaving nothing behind, attach mode, "Port 8807 is in use", and a force-quit app's server shutting itself down. Not checked live: the menu bar menu's clicks (macOS didn't allow scripting them; the same functions are exercised through the window and Quit), Open at login turned on (it registers a real login item), and the first-close notification appearing on screen.
- [ ] **M2 · Distribution.**
  - **Signing and notarization.** Needs an Apple Developer account ($99/yr). Then: Developer ID, hardened runtime, notarize in electron-builder. Also turn off the Electron fuses TOT doesn't need (`--inspect` and `NODE_OPTIONS` for the app; keep RunAsNode, the server and the shims use it).
  - [x] **Auto-update from GitHub Releases** (electron-updater), built 2026-10-16 (above). Needs `dhruvalgolakiya/tot` to be public: the apps carry no token.
  - **x64 and universal builds** for Intel Macs (codex and Claude Code ship x64 packages; `signIgnore` and the native packages need checking per arch).
  - **A Download button** on the landing page (`site/`).
  - **A smaller app:** codex and Claude Code are most of what's left (about 560 MB). They could be downloaded on first launch instead of shipped.

## Notes and follow-ups

- **The agents' local computers** (`server/computer/local.ts`) put `dirname(process.execPath)` first on PATH so sandboxed commands find Node. In the app that's `TOT.app/Contents/MacOS`, which has no `node`. On a Mac without Node, local-computer agents have none (the shim folder is under the home folder, which the sandbox can't read). Fix by giving the sandbox a readable `node` (e.g. the shim folder outside `~`) if it matters.
- **Dictation** uses the Web Speech API, which Electron declares but has no speech service for, so the app hides the microphone button (`src/components/voice/speechRecognition.ts`). Bringing it back means local speech-to-text.
- **Started from a terminal that sets `ELECTRON_RUN_AS_NODE`** (some Electron-based terminals and agents do), `open TOT.app` passes it on and Electron starts as plain Node and exits. That's Electron's own switch; opening from Finder or the Dock is unaffected.
- `npm` as a dependency also puts `node_modules/.bin/npm` first inside `npm run` scripts, so npm scripts that call `npm` use npm 11 from the repo. Harmless, but worth knowing.

## Out of scope

- Windows and Linux.
- The Mac App Store (its sandbox can't run codex, Claude Code or the agents' local computers).
- A bundled Claude or ChatGPT login: providers are logged in once in a terminal, as in Quick start.
