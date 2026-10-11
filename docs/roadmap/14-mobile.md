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

- **Nothing is synced and no TOT runs on the phone.** Every list comes from the server on the fly; every turn runs on the agent's device. The app stores two things in the iOS Keychain (`expo-secure-store`): the TOT's address and the sign-in token.
- **One TOT at a time** in M1 (the one you sign in to). Several saved TOTs come in M5; with paired devices you rarely need them.
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

The web app's ChatGPT/Codex look (DESIGN.md), as a phone app: true neutral greys (canvas `#212121`/`#ffffff`, panel `#181818`/`#f9f9f9`, bubble `#303030`/`#f4f4f4`), light and dark following the system, Inter. Flat rows with hairlines, pill buttons, the pill composer. No colored bars on rows or cards. Mascots are a colored circle with the agent's initial in M1 (the full mascot art is later). Few visible actions: the rest is in a long-press or a "…" action sheet.

## Milestones

- [x] **M1 Connect, agents, chats, live replies, approvals.** Built 2026-10-11 on `feat/mobile`: the token sign-in, `GET /api/runs/live`, and the app's five screens, checked on the iOS Simulator (Expo Go) against two paired throwaway TOTs.
  - Server: the token sign-in above, and `GET /api/runs/live` (what's running and waiting for the user right now: app events only tell what changes after the app opens). `server/mobile-auth.test.ts`.
  - Connect: the TOT's address and password, or **Scan QR code** (Settings → Devices → Add a phone; a pasted sign-in link works too). A TOT that doesn't ask for sign-in (this Mac's simulator, remote access off) connects with no token.
  - Agents: every agent on this TOT and its paired devices (a section per device; offline devices say so), a working dot while a run is going, "Needs you" when a chat waits for an approval.
  - An agent's chats: pinned first, then chats in no project, then a section per project; tasks and Lead chats marked. New chat; long-press for Pin and Delete.
  - Chat: messages with markdown, tool steps and thinking one quiet line each (tap to open), the reply streaming live, the pill composer, Stop. Approval cards (Approve / Decline, a Lead's land / discard / push) inline; form approvals say to answer on the computer for now.
  - Settings sheet: which TOT, its address, the paired devices, Sign out. Signed out from the computer, the app goes back to Connect at once (address kept).
- [ ] **M2 Tasks and projects.** Task status, steer, pause/resume/stop, land/discard cards for the Lead's asks; mission control (every task); projects list, a project's page, new chat in a project with the workspace picker (checkout / new worktree).
- [ ] **M3 Settings and the top bar.** The model/account picker in a chat; an agent's settings (name, mascot, island, tagline, model); Settings sections that make sense on a phone: Models & accounts (incl. Make default), Tasks, Memory / About you, Devices and remote access, Slack and GitHub status (read-only).
- [ ] **M4 Notifications and knowledge.** Local notifications for "needs you" and "task done" while the app is open or recently backgrounded. APNs push needs an Apple Developer account and a relay that can reach the phone: designed here (the server would keep each app session's push token and send on `approval` and task events), not built. The knowledge viewer (a project's wiki and memory, read-only).
- [ ] **M5 Polish.** Reconnect and offline (last lists cached, clear "can't reach Mac mini" state), several saved TOTs, the real mascots, app icon and splash, Android pass, TestFlight notes (EAS build, bundle id, signing).

## Not done in M1

- The mascots are a colored circle with an initial; offline devices' agents aren't remembered (the web app caches them per browser).
- No attachments, model picker, task cards (a task started from a chat shows as one line with its status) or form approvals.
- The QR scanner is untested on a real phone (the simulator has no camera); the code path is the same as a pasted link, which is tested.
- An older paired TOT answers `/api/runs/live` with its web page (unknown API paths fall through to the app in production); the app treats an HTML answer as "not supported" and shows that device's live state from events only.

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
