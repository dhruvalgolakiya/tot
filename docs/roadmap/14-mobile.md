# 14 · Mobile app: every agent on every device, from your phone

**Lane:** worktree `~/playground/tot-mobile`, branch `feat/mobile`, from `main` after provider accounts (a89661c). **Depends on:** 07 (devices, remote access, sign-in sessions, the phone's QR code), 13 (accounts, for M3). **Overlaps:** one change in `server/auth.ts` (a token sign-in); everything else is a new top-level `mobile/` folder.

Read [README.md](README.md) first.

## Goal

The user's words (2026-10-11):

> "Let's build a mobile app for exactly what we have here in the web / macOS app, so I can manage all my agents from my phone. It will see all my connected systems' agents, running prompts, manage those, and all the configs we have in our top bar and settings page."

The web app already works in a phone's browser (remote access, Settings → Devices). A native app adds what a browser tab can't do well: it stays signed in, comes back where you left off, notifies you when an agent needs you, and feels like a phone app (lists, swipes, the camera for the QR code).

The bar, as in 06–08: **a new user should understand it on first sight.** Agents, their chats, a chat. Everything else is one tap away, not on screen.

## Model: the app is a screen, not a device

In module 07's words, a phone is a **screen**: it keeps nothing and signs in to one **device** (a TOT), which shows it everything it sees, its paired devices' agents included.

```
 TOT app (iPhone) ──▶ Mac mini ──▶ MacBook
   token, Bearer       (signed in)   (paired; /api/d/<id>/…)
```

- **Nothing is synced and no TOT runs on the phone.** Every list comes from the server on the fly; every turn runs on the agent's device. The app keeps each saved TOT's address and sign-in token in the iOS Keychain (`expo-secure-store`), and (M5) a cache of the last lists it loaded from each, to show while the TOT can't be reached.
- **One TOT open at a time.** Several can be saved (M5: Settings → TOT servers); with paired devices you rarely need more than one.
- **Other devices' agents** come exactly as in the web app: `GET /api/devices` lists the paired ones, and calls about their agents, chats and runs go to `/api/d/<deviceId>/…` (the app ports `src/lib/devices.ts`' id ownership). Their live events arrive wrapped as `{ type: "remote", deviceId, event }` on the one event stream.

## Sign-in

The phone app can't rely on a browser cookie, so it gets the same sign-in **session** as a token (`server/auth.ts`):

- `POST /login` with JSON `{ client: "mobile", code | password, deviceName }` answers `{ token, deviceName }`. `code` is the one-time code of Settings → Devices → **Add a phone** (the app scans its QR code: the link `<address>/login#code=…` carries both the address and the code); `password` is the one set there.
- The token is `tots_<session id>.<secret>`; the server keeps only the secret's hash (module 07's `sessions` table). The app sends it as `Authorization: Bearer <token>` on every request, the event streams included.
- It shows in Settings → Devices as **"TOT app on <phone name>"**, and signing it out there ends its requests and closes its event streams at once, like a browser's. `POST /logout` with the token signs the app out itself.
- Everything else is unchanged: this computer never signs in; until a password is set nothing else can connect (the app gets a 409 that says so); codes are single-use and live 5 minutes; wrong passwords and made-up tokens count toward the global lockout; the browser form still sets a cookie.

**Why Bearer is safe from CSRF.** A cookie is sent by the browser on its own, so a cookie-authenticated write needs the Origin check in `routes.ts`. A Bearer header is only sent by code that holds the token, and a cross-site page can't send one without a CORS preflight TOT never answers. The Origin check still applies to these requests (a native app sends no Origin).

**Live updates without EventSource.** React Native has no EventSource, and EventSource couldn't set a header anyway. The app reads SSE through `fetch` with a streaming body (`expo/fetch`, the global `fetch` on iOS and Android in Expo SDK 52+), with the Bearer header. So no `?access_token=` in URLs, which would end up in logs.

## Stack: Expo (React Native, TypeScript)

| Choice | Why |
|---|---|
| **Expo SDK 57** (React Native 0.86, New Architecture, Hermes) | TOT is React + TypeScript; Expo is the recommended way to build React Native apps, runs on the iOS Simulator with Expo Go in one command (no Xcode project to keep), and builds for TestFlight later with EAS or `expo run:ios`. |
| **expo-router** | File-based routes like a web app (`/agents`, `/agent/[id]`, `/chat/[id]`), native stack navigation and back-swipe. |
| **zustand** | The web app's store library; the mobile store reads like `src/store.ts`. |
| **`shared/types.ts` imported directly** (`@shared/*` → `../shared/*`, type-only imports) | One API contract. Metro never bundles it: type imports are erased. |
| The API client **ported** from `src/lib/api.ts` (same paths, same types), plus the run reducer from `src/lib/reducer.ts` | Not rewritten: the same calls, a base URL and a Bearer header instead of a same-origin cookie. |
| `expo-secure-store`, `expo-camera` (QR scanning), `expo-device` (the phone's name), Inter via `@expo-google-fonts/inter`, `@expo/vector-icons` Feather (lucide is a Feather fork) | All in Expo Go, so no custom dev build is needed for M1. |
| A small built-in markdown renderer (`mobile/src/components/Markdown.tsx`) | Paragraphs, headings, lists, quotes, code, bold/italic/inline code, links. The React Native markdown libraries lag React 19 and the New Architecture; this covers what replies use. |

**Its own `package.json`, outside the root build.** `mobile/` is not an npm workspace of the root and isn't in its `typecheck`/`test`/`build` chain: the root `tsconfig*.json` include only `src`, `server`, `shared` and `electron`, Vite builds from `index.html`, and `electron/builder.config.ts` packs only `dist`, `dist-app` and the server's packages. Run `npx tsc --noEmit` inside `mobile/`.

**iOS first.** Android should work (nothing here is iOS-only except where noted) but isn't tested until M5.

## Look

The web app's ChatGPT/Codex look (DESIGN.md), as a phone app: true neutral greys (canvas `#212121`/`#ffffff`, panel `#181818`/`#f9f9f9`, bubble `#303030`/`#f4f4f4`), light and dark following the system, Inter. Flat rows with hairlines, pill buttons, the pill composer. No colored bars on rows or cards. Mascots are drawn like the web's (M5: shape, color, eyes, accessory, with react-native-svg; still, not animated). Few visible actions: the rest is in a long-press or a "…" action sheet.

## Milestones

- [x] **M1 Connect, agents, chats, live replies, approvals.** Built 2026-10-11 on `feat/mobile`: the token sign-in, `GET /api/runs/live`, and the app's five screens, checked on the iOS Simulator (Expo Go) against two paired throwaway TOTs.
  - Server: the token sign-in above, and `GET /api/runs/live` (what's running and waiting for the user right now: app events only tell what changes after the app opens). `server/mobile-auth.test.ts`.
  - Connect: the TOT's address and password, or **Scan QR code** (Settings → Devices → Add a phone; a pasted sign-in link works too). A TOT that doesn't ask for sign-in (this Mac's simulator, remote access off) connects with no token.
  - Agents: every agent on this TOT and its paired devices (a section per device; offline devices say so), a working dot while a run is going, "Needs you" when a chat waits for an approval.
  - An agent's chats: pinned first, then chats in no project, then a section per project; tasks and Lead chats marked. New chat; long-press for Pin and Delete.
  - Chat: messages with markdown, tool steps and thinking one quiet line each (tap to open), the reply streaming live, the pill composer, Stop. Approval cards (Approve / Decline, a Lead's land / discard / push) inline; form approvals say to answer on the computer for now.
  - Settings sheet: which TOT, its address, the paired devices, Sign out. Signed out from the computer, the app goes back to Connect at once (address kept).
- [x] **M2 Tasks and projects.** Built 2026-10-11 on `feat/mobile`, client only (no server changes), checked on the iOS Simulator against two paired throwaway TOTs seeded with a six-task group (done, running, queued, paused, failed, ready to land), a folder project on a throwaway git repo and a Lead with a land card.
  - Tasks (the layers button on Agents): mission control across this TOT and its online paired devices (each device's `GET /api/mission`, merged; rows read the store, the board refetches 600 ms after task events). Needs you, Working, Ready to land (in land order), Landed (folded). Each row: status icon, title, status line, agent (and device), branch, `+/− · files`, checks icon, elapsed. Long-press: Run now / Pause / Resume / Stop.
  - Task page (a chat with kind "task"): a strip under the title with status · role · tier and repo · branch; "…" with Run now / Pause / Resume / Stop; the web's TaskEmptyState (Asked to…, where it stands, Resume when that moves it on); the composer adds notes (`/steer`) while the task is steerable, Stop with nothing typed.
  - In chats: tasks started together are one card ("6 tasks · 1 running · 2 done · 1 paused…", a row each, tap opens, long-press for actions; a single task is the same card without its header); "… is done" notices stack into one compact list.
  - Landing: a ready-to-land task's page ends with its changes, checks (a line per gate), how far behind its base it is and why it can't land, and Discard / Merge into <branch> (Open draft PR for GitHub projects), each with a native confirm. Landed: where the code went. Lead cards (M1) still land.
  - Projects: project sections in an agent's chats open the project's page, and the device's other projects are listed under Projects. The page: icon, name, source, a composer that starts a chat in it with this agent (Main checkout / New worktree for code projects), and its chats from every agent. "…": Start / Open the Lead, Archive (confirm). New chat anywhere: a project picker (and the workspace picker) above the composer.
- [x] **M3 Settings and the top bar.** Built 2026-10-11 on `feat/mobile`, client only (no server changes), checked on the iOS Simulator against two paired throwaway TOTs, one with an extra Claude account (a temp folder whose dummy settings.json points at a proxy, with two MCP servers).
  - Model picker: the chat's title opens a native bottom sheet (`app/models.tsx`, a form sheet route; what it picks for is handed over in `lib/picker.ts`), the web's ModelPicker: TOT Auto, then each account's models under its name, unavailable ones with their reason. A chat's change is optimistic (`PATCH /conversations/:id`, reverted with an alert); a new chat's draft model goes in its create request, picked from a pill above the composer. A paired device's agent uses that device's model list. Tasks keep their role's tier: no picker.
  - Agent settings (an agent's "…" → Agent settings): name, tagline (≤40), island (the four `public/hero/islands` pictures bundled in `mobile/assets/islands`, dawn in light mode), mascot color (the web's twelve swatches), shape, eyes and accessory (action sheets), instructions, default model, the computer's status line (read-only), Delete agent (confirm; not for a device's last agent). Each field saves when editing ends. New agent (a row under each device's agents): name, mascot color, default model; the rest of the mascot is random and the island round-robin, as on the web; it's made on that device.
  - Settings is a screen with sections (`app/settings/*`), the web's wording, every change saved at once (`PATCH /settings` with just that field, optimistic, reverted with an alert): General (theme System/Light/Dark kept on the phone via `Appearance.setColorScheme`, your name, custom instructions, default model, memory on/off); Models & accounts (accounts per provider with name, folder, sign-in/proxy/MCP lines and Signed in / Proxy / Not signed in / At its limit / Off; "…" with Make default, Rename (an iOS prompt), the MCP servers toggle, Turn off/on; Sign in, Add account and Import from T3 Code say "Do this on the computer"; Claude and ChatGPT connected-app switches; the tiers per provider and the task roles' tiers as action sheets); Tasks (steppers for the three limits, the switches, cleanup days, Clean up now); Memory (About you: add with return, tap to delete; Dreaming on/off, time, Dream now, undo the last dream; the history with Undo; reloads on `memory` events); Devices (this device and remote access, read-only; Signed in with Sign out per session, this phone's own included, and Sign out all others; paired devices). GitHub, Slack, Apps, Personas and Plugins are read-only status rows ("Set up on the computer").
  - Shared pieces: `components/settings.tsx` (iOS grouped lists in the web's greys: groups, rows, switches, steppers, a segmented control, status dots), `lib/models.ts`, `lib/agents.ts` (islands and the mascot catalog, ported: Metro bundles only `mobile/`).
- [x] **M4 Notifications and knowledge.** Built 2026-10-11 on `feat/mobile`, client only (no server changes), checked on the iOS Simulator (Expo Go) against two paired throwaway TOTs seeded with a notebook, a project with facts, pages, a repo's docs and a mermaid block, and running tasks; approvals, task endings and replies fired by hand (`.scratch/m4/tot.ts`, a word in a file and SIGUSR1), no model turns.
  - Local notifications (`lib/notify.ts`, `expo-notifications`, works in Expo Go): an approval waiting (a tool's or a Lead's card), a task that needs input, is done or failed (the web's rule from `handleTaskEvent`, minus tasks whose results get combined, as `server/tasks/notify.ts` skips them: the combined reply notifies), and a reply finishing in your own chat (not tasks, routines or Slack/email threads). Never about the chat on screen (the chat screen sets it while focused). Tapping opens the chat or task; a summary opens Tasks; the notification that launched the app is handled too.
  - iOS keeps the app running only briefly in the background, so: live from the event stream while it runs, and after every full load (launch, coming back, the stream reconnecting) a **catch-up** from `/api/runs/live` and the chats list: chats waiting now that weren't before, replies that were running and ended, tasks changed since the last look. What was already notified is remembered per TOT in AsyncStorage (keys like `task:<id>:done:<finishedAt>`, the chats waiting and running at the last look); the first look at a TOT only remembers, so installing never brings a backlog. Live notes are gathered until the stream is quiet for a second (3 s at most); more than three at once become one summary ("5 things happened in TOT").
  - Permission is asked the first time you send a message (as the web asks the browser), or from **Settings → Notifications**: the permission state, **Turn on notifications** while iOS hasn't asked, **Open iOS Settings** once it's off there, and each kind on/off (kept on the phone).
  - Knowledge viewer (`app/knowledge/*`, the web's WikiView): from an agent's "…" (its notebook) and a project's "…" (its knowledge). The title is the switcher (an action sheet: the agent's notebook, the shared brains it uses, the device's projects); search with highlighted snippets; a project's Facts (count, add with return, tap to delete) and History (each change with who and when, tap to open the pages it touched or Undo: a 409 from later changes says so); the page tree (indented, long-press or the chevron folds a page's children) and each repo's docs; a page with its line, who changed it last and the content in the app's Markdown (mermaid shows as code). A paired device's knowledge is read through the signed-in TOT (`/api/d/<id>/…`), which the web's Knowledge page doesn't do; `wiki` and `memory` events reload what's open.
- [x] **M5 Polish.** Built 2026-10-11 on `feat/mobile`, client only (no server changes), checked on the iOS Simulator (Expo Go for the app, a local Release build for the icon and splash) against two throwaway TOTs (`.scratch/m5/tot.ts`: every mascot shape and accessory, a task with a checklist, a slow fake reply fired by hand; one tiny real turn to send a photo).
  - Mascots (`components/mascot/`): the web's geometry and palette copied (Metro bundles only `mobile/`), drawn with react-native-svg everywhere an agent shows (Agents, an agent's page, the chat's header and empty state, agent settings, New agent). Still: dozens of looping animations in a list would cost battery for little. Below 24 pt the accessory and small ink details drop out, as on the web; an offline device's agents sleep (eyes closed, faded). Decorative next to a name for VoiceOver; read out ("Cat mascot with sunglasses") in the editors.
  - Reconnect and offline: the last lists from each TOT (agents, chats, projects, devices, settings, models, and the latest messages of the last 12 chats opened) are cached on the phone (`lib/cache.ts`, AsyncStorage per address, never re-saved from the cache) and shown at once on launch. When the TOT can't be reached (a load can't connect, or the event stream stays down 2.5 s) a **Reconnecting to Mac mini…** banner shows on every screen with when the lists were loaded and **Retry**; chats are read-only (the composer waits). The event stream backs off 1 → 15 s, gives up on a connect that hangs after 12 s, and drops a stream silent for 40 s (TOT heartbeats every 15 s) so a Mac that slept or a frozen connection is noticed; coming back to the app or Retry tries at once. Back, it reloads the lists, the board and every open chat (a run stream resumes with Last-Event-ID; a run that ended loads its saved reply; one that started meanwhile is followed). An offline paired device keeps its agents, chats and projects from the last look, faded (the web keeps them per browser). A refused token still goes back to Connect at once, address kept, and that TOT's cache is dropped.
  - Several saved TOTs (`lib/connection.ts`): the Keychain holds the list (address, name) and a token per server; M1–M4's single TOT moves in on first launch. **Settings → TOT servers**: each saved TOT (the open one says Open); tap for Open or Remove (signs this phone out there, drops its cache); **Add a TOT** opens Connect over the current TOT, with Cancel. Connect offers the saved TOTs when none is open. Notification memory stays keyed by address, as in M4.
  - Icon and splash: `mobile/scripts/icons.mts` draws the Mac app's two rings (electron/icons.ts) full-bleed and opaque for iOS (it rounds the corners), the splash's rings on white or `#212121` (system light or dark, `expo-splash-screen`), and Android's adaptive icon (rings in the safe zone on `#1b1b1f`, a white monochrome). The splash holds until the Keychain and fonts are read. Connect shows the rings too.
  - M1–M4 gaps closed: photo attachments (the composer's **+**: up to 10 from the library, uploaded at once to the agent's device with `POST /api/uploads`, sent with the message; sent photos show as thumbnails fetched with the phone's sign-in); a task's **Plan** (checklist and PLAN.md) and, for a coding task, **Changes** (files and the diff, cut at 1,500 lines) from its "…", read-only; the model sheet's rows reach VoiceOver (plain buttons with state and reason in the label); offline devices' agents remembered.
  - Android: no Android SDK on this Mac, so not run. The code is platform-neutral except where noted (menus fall back to alerts; renaming an account, which needs `Alert.prompt`, is iOS-only); `eas.json`'s simulator and preview profiles build an APK.

## Not done in M5

- Not run on Android (no SDK here) or on a real iPhone; the keyboard avoidance on Android (edge-to-edge in SDK 57) is the likeliest thing to need a fix.
- Attachments are photos from the library only (no camera, no files); a steering note can't carry one.
- A task's Changes are read-only and plain (no syntax colors, no per-file view); Activity, Update from base, Run checks and the rest of M2's list are still on the computer.
- The cache keeps the last lists, not everything ever loaded: a chat not among the last 12 opened shows no messages while offline.
- No push (see below), so nothing reaches a phone whose app iOS has suspended.

## What the app does, and what stays on the computer

**On the phone:** every agent on the open TOT and its paired devices (offline ones remembered); their chats, live replies (streaming, resumed after a drop), tool steps and thinking; sending messages and photos, stopping a reply; approvals (tools' and a Lead's land / discard / push); tasks: mission control, a task's page, steering notes, Run now / Pause / Resume / Stop, its Plan and Changes, landing (merge or draft PR) and discarding; projects: their pages, new chats in them (main checkout or worktree), the Lead, archiving; the model picker; agent settings and New agent; Settings: General, Models & accounts (default, rename, MCP servers, on/off, tiers, roles), Tasks, Memory (About you, Dreaming, history with Undo), Devices (sign-ins with Sign out), Notifications; local notifications with the catch-up; the Knowledge viewer (search, pages, a project's facts and history with Undo); several saved TOTs; the last lists while a TOT is unreachable.

**On the computer:** signing in to Claude or ChatGPT, adding or removing accounts, importing from T3 Code, the Claude API key; GitHub, Slack, apps, personas, plugins, workflows; the computer (Boat / local) settings; remote access, the password, pairing and renaming devices; creating or setting up projects (repos, instructions, subscriptions, worktree setup) and allowing a folder; editing knowledge pages, Learn a repo, brain settings; form approvals; a task's Activity, Update from base, Run checks, Rename, Delete, Continue on the other provider, previews and Compare; routines and an agent's persona.

## TestFlight (what the user does)

The app builds with EAS (Expo's build service) from `mobile/`; `mobile/eas.json` has three profiles. Nothing below has been run: each step needs the user's own Apple account.

1. **Apple Developer Program** ($99/year) at developer.apple.com, with the Apple ID that will own the app.
2. **An Expo account** (free) and the CLI: `cd /tmp && npx eas-cli@latest login`, then from `mobile/`: `npx eas-cli@latest init` (links the project; it writes `extra.eas.projectId` into `app.json`, commit that).
3. **Bundle id:** `dev.tot.mobile` in `app.json` (`ios.bundleIdentifier`, `android.package`). Change it first if that id is taken or the user wants their own (e.g. `com.<name>.tot`): it can't change after the first TestFlight upload. The version is `expo.version` (0.1.0); EAS keeps the build number (`appVersionSource: remote`, `autoIncrement` in production).
4. **Build:** `npx eas-cli@latest build --platform ios --profile production`. The first time, let EAS create the signing certificate and provisioning profile (answer yes, sign in with the Apple ID); it stores them for later builds. `--profile simulator` builds a Simulator `.app` (no Apple account needed); `--profile preview` an internal build for registered iPhones (`eas device:create` registers one).
5. **Submit:** `npx eas-cli@latest submit --platform ios --latest` creates the app in App Store Connect (or picks it) and uploads the build; TestFlight lists it after Apple's processing (minutes to an hour). Add testers in App Store Connect → TestFlight (internal testers need no review). Export compliance: the app only uses standard encryption (HTTPS), and `app.json` already says so (`ios.config.usesNonExemptEncryption: false`), so App Store Connect doesn't ask each time.
6. **Review notes for an external TestFlight / the App Store:** the app needs a TOT to connect to, so give Apple a reachable test TOT and a password, or keep it to internal testers.
7. **Push later:** add `expo-notifications`' config plugin to `app.json` (it adds the Push Notifications capability), rebuild, and follow "Push (designed, not built)" below; EAS then asks to create an APNs key, but the design keeps the key on the user's own TOT instead.
8. **Android (Play):** `npx eas-cli@latest build --platform android --profile production` (an `.aab`), a Google Play developer account ($25 once), and `eas submit --platform android`.

## Not done in M1

- The mascots are a colored circle with an initial; offline devices' agents aren't remembered (the web app caches them per browser).
- No attachments, model picker or form approvals.
- The QR scanner is untested on a real phone (the simulator has no camera); the code path is the same as a pasted link, which is tested.
- An older paired TOT answers `/api/runs/live` with its web page (unknown API paths fall through to the app in production); the app treats an HTML answer as "not supported" and shows that device's live state from events only.

## Not done in M2

- A task's Plan, Changes (file list and diff) and Activity tabs, Update from base, Run checks, Rename, Delete, Turn back into a chat, Continue on the other provider, previews and best-of Compare: the web app has them.
- Steering notes show as the user's bubbles in order, not inside the reply they were handed to.
- Draft-PR landing is wired (`method: "pr"`) but was only checked against folder projects (no real GitHub in development).
- A folder project the user hasn't allowed yet says to allow it on the computer; the app can't grant it. Projects can't be created, renamed or set up (repos, instructions, subscriptions, worktree setup) from the phone yet.
- The board shows online devices only; an offline device's tasks reappear when it's back.

## Not done in M3

- The mascot is still M1's colored circle with an initial: shape, eyes and accessory are saved and show on the computer, not drawn on the phone.
- Signing in to an account, adding or removing one, importing from T3 Code, the Claude API key, the computer (Boat / local) settings, Workflows, the Slack person for task notices, remote access, the password, pairing and renaming the device: the phone points to the computer.
- An agent's persona ("Works as") and routines aren't on the phone; neither are a project's facts (its Knowledge page), memory sync and the backup remote.
- Settings are this TOT's: a paired device's settings aren't shown (the server refuses changes from another device anyway).
- A new chat's draft model was checked on screen; no real turn was run with it.

## Not done in M4

- No push: a notification comes only while the app runs (open, or the few seconds iOS gives it after leaving the screen); the rest arrives as the catch-up when it's opened. See "Push (designed, not built)".
- The app's own notified keys are per address: a different TOT at the same address keeps the old keys (harmless: ids never repeat) and its first look notifies what changed since the old TOT's last look, not nothing.
- An approval's notification is one per wait: a second card in a chat that's still waiting doesn't notify again.
- The Knowledge viewer is read-only but for facts and Undo: no editing pages, new pages, Learn a repo, brain settings or a repo's profile; a page's revisions aren't listed; mermaid isn't drawn.
- Expo Go only: `expo-notifications`' config plugin isn't in `app.json` yet (it adds the push entitlement, which a development build without a paid Apple account can't sign). Add it with push.
- Checked in the Simulator only; a real iPhone's background timing will differ.

## Push (designed, not built)

Local notifications can't reach a phone whose app iOS has suspended. Push can; it's out of scope for now and needs:

- **An Apple Developer account** (paid), the app's bundle id (`dev.tot.mobile`) with the Push Notifications capability, and a development or TestFlight build (EAS or `expo run:ios`) with `expo-notifications`' config plugin. Expo Go can't receive pushes for this app.
- **Sending:** direct APNs from the user's own TOT is the private choice: the user creates an APNs auth key (`.p8`, key id, team id) in their Apple account and gives it to TOT on the computer (Settings → Devices, stored like other secrets, never shown again or synced). A hosted relay (Expo's push service or our own) would be simpler to set up but would see every notification and need an account; if one is offered later it must be opt-in and get titles only.
- **Registering:** the app asks iOS for its APNs device token after the permission prompt and sends it to `POST /api/devices/push` (new; tied to the app's sign-in session in the `sessions` table, replaced on each launch, deleted with the session: signing the phone out stops its pushes). `DELETE` on Settings → Notifications off.
- **When:** the server sends on the same moments the app notifies about: `approval` (pending), task status to needs-input / done / failed (the rule in `server/tasks/notify.ts`), a chat's run ending. Paired devices' events go out from the TOT the phone is signed in to (it already relays them). A `collapse-id` per chat keeps one notification per wait.
- **Privacy:** titles only ("Ada needs your OK", "“Round the totals” is done"), never message text, task questions or summaries, file names or code: APNs payloads pass through Apple. The app fetches the details over its own connection when tapped. The app keeps its local-notification dedupe (by key) so a push and the catch-up don't both show.
- **Tests:** the token route's auth and session cleanup, the payloads (no body text), and a fake APNs sender, like `server/tasks/notify.ts`' fake notifiers.

## Rules

- The app is a client: it never stores chats, never talks to a model, never holds another device's token. Only the address and its own session token, in the Keychain.
- Same sign-in rules as a browser (module 07); no new way in. Tokens never go in URLs, logs or error messages.
- Device settings stay on the device (07): the app may show logins, Slack, GitHub and apps; changing them is for the device itself, as the server already enforces for paired devices. (A signed-in phone may change what the web app on a phone may change.)
- Follow DESIGN.md's look; no colored side bars; few visible actions.
- Real turns in development: at most a couple of tiny "Reply with OK" turns against a throwaway TOT (`TOT_DATA_DIR=$(mktemp -d)`), never `~/.tot`.

## Definition of done (per milestone)

- Root: `npm run typecheck`, `npm test` (every suite `ALL PASS`, `server/mobile-auth.test.ts` included), `npx vite build --outDir /tmp/…`, `npm run site:build`.
- `mobile/`: `npx tsc --noEmit` clean; the app runs on the iOS Simulator against a throwaway TOT; every new screen checked with simulator screenshots in light and dark.
- This doc's milestone ticked with a one-line note; the README's "Mobile app" section and the docs site's page still true.
- Committed on `feat/mobile`, not pushed.
