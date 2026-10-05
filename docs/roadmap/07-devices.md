# 07 · Devices: TOT on every computer you own

**Lane:** worktree E, branch `feat/devices`, created from `main`. **Depends on:** 06 (projects belong to a device). **Overlaps:** touches `server/auth.ts`, `server/session.ts`, `src/lib/api.ts` and `src/store.ts`, so it should not run at the same time as another module that changes sign-in or the store's loading.

Read [README.md](README.md) first.

## Goal

Today TOT is one server on one Mac. Your phone can open it on the home Wi-Fi, but a second Mac can't join in: if you install TOT there too, it is a separate island with its own agents.

This module lets you **install TOT on another computer, pair the two once, and use both from either side**. You talk to the MacBook's agents from the Mac mini and the Mac mini's agents from the MacBook, with everything live on both screens.

The bar for every decision, same as 06: **a new user and a model should both understand it on first sight.** When a choice adds power but also a concept, leave it out.

## The whole model in two words

| Word | What it is | Example |
|------|-----------|---------|
| **Device** | A computer running TOT. It keeps its own agents, chats, projects, computers and logins. | Mac mini, MacBook |
| **Screen** | Anywhere you look at TOT: a device's own window, another device, a browser, your phone. A screen keeps nothing. | Safari on iPhone |

That's it. A phone is a screen, not a device: it signs in to one device and sees everything that device sees.

## The agent question: where does an agent live?

**An agent lives on one device. You can talk to it from any screen.**

Nothing is copied or synced. When you chat with Kiwi (who lives on the MacBook) from the Mac mini, the turn runs on the MacBook: Kiwi's model, computer, folders, Claude/Codex login and worktrees are all there. The Mac mini just shows it. The MacBook's own window shows the same chat, live.

This keeps the hard promise simple: **everything an agent touches is on its device.** If you open `~/playground/meet-notes` with a MacBook agent, it's the MacBook's folder.

What that looks like:

```
 Rail (Mac mini)            Hover card
 ●  Tot                     Kiwi
 ●  Puddin                  on MacBook · online
 ───
 ●▫ Tot                     Sol
 ●▫ Kiwi                    on Studio · asleep, seen 2 h ago
 ◌▫ Sol      (faded)
```

- **The rail:** this device's agents come first, exactly as today. Below a hairline come the paired devices' agents, each with a small laptop badge on the mascot's corner. Nothing changes when you have only one device.
- **Two agents named Tot are fine.** Each device makes a default Tot; the badge and hover card tell them apart.
- **Offline device:** its agents fade, the hover card says "asleep, seen 2 h ago", and opening one shows "MacBook is offline. Its chats are safe on it." Nothing is lost; you just can't reach it right now.
- **Chat header:** "Kiwi on MacBook › web › Fix the flaky test". The "on MacBook" part only shows for another device's agent.
- **New agent:** gains one field, **Lives on** (this device by default), and only when you have more than one device.
- **Moving an agent** to another device is later (M5).

## Rules that keep it simple

**For the user**

1. Each device keeps its own agents, chats, projects and settings. Nothing is copied between devices.
2. **Pair two devices once, and both sides see each other.** One link, pasted once, works in both directions.
3. From any screen you can do everything with any agent: chat, tasks, projects, approvals, its settings.
4. **Device settings stay on the device:** logins (Claude, Codex, Boat), GitHub, Slack, mail and apps. Change them on that device itself. Secrets never leave the device they're on.
5. Unpair from either side, and both forget each other.
6. Every browser and phone signed in to a device is listed, and you can sign any one out.

**For the agent**

1. Nothing changes: it runs on its own device exactly as today.
2. When its device has paired devices, its prompt gets one line, always the same shape:

```
# Device
You run on MacBook. Your computer, folders and logins are on this machine.
```

Agents don't see or call agents on other devices (that's later, in M5).

## How screens reach devices

**The device you're on is your hub.** A screen only ever talks to one device, the way it does today (same origin, the same sign-in cookie). That device talks to its paired devices for you:

```
 iPhone ──▶ Mac mini ──▶ MacBook
           (signed in)   (paired)
```

- The Mac mini forwards `/api/d/<deviceId>/…` to the MacBook's `/api/…`, using the MacBook's device token. The browser never holds another device's token, and there's no CORS.
- The Mac mini keeps one event stream open to each paired device and passes its events on, tagged with the device. When that stream is up, the device is **online**.
- **No chains.** A device shows only the devices *it* paired with. To see three devices from each other, pair each pair.

**How devices find each other.** A device's **address** is the URL another computer would open TOT at.

- **Tailscale** is recommended: it works from anywhere, is encrypted, and is already on this Mac. TOT fills in the Tailscale address first.
- **The home LAN** (`http://192.168.x.x:5173`) works at home only, and isn't encrypted. The Devices page says so.
- We don't build a relay, accounts or a cloud service.

To be pairable, a device must accept connections from other machines. Today that's `TOT_LAN=1` plus `TOT_ACCESS_TOKEN`. M2 adds `TOT_HOST=tailscale`, which listens on the Tailscale address only.

## Today

- **Sign-in:** one shared token from `.env`. The `tot_session` cookie is a hash of that token (`server/session.ts`, `server/auth.ts:151`), so every browser holds the same cookie value. You can't list browsers or sign one out; rotating the token signs out everything.
- **Live updates:** REST plus SSE on `/api/events` (no ids, no replay; clients refetch on reconnect, `src/store.ts:1477`). Run streams (`/api/runs/:id/events`) have sequence ids and `Last-Event-ID` replay.
- **Ids are random UUIDs** (agents, chats, projects), so two devices never collide. Each device makes its own default Tot.
- **Device-only things already:**
  - `/mcp` accepts only this machine;
  - `/api/apps/open` and `/api/apps/access` refuse other machines;
  - Claude and Codex sessions are files on this Mac;
  - `computer.exposePort` returns `http://localhost:<port>`.
- **Jobs that must run on exactly one machine:** the Slack bot (two would both answer), mailboxes and emailed tasks. Routines, the wiki keeper and the task queue are per device already, because they only touch that device's data.
- **No web app manifest**, so "Add to Home Screen" on the phone gives a plain bookmark.

## Concepts

**Pairing (mutual, one paste).**

1. **On the Mac mini:** Settings → Devices → **Add a device**. It shows one link, such as `http://100.101.4.2:5173/pair#K7QM-4RXP-2HWD`. The link holds the address plus a one-time code (12 characters, no look-alikes). It works once, for 5 minutes.
2. **On the MacBook:** Settings → Devices → **Connect to a device**, then paste the link.
3. **The MacBook's server calls the Mac mini** with the code, its own id, name and address, and a fresh token the Mac mini can use to call it back. The Mac mini checks the code, saves the MacBook, and answers with its own id, name and a token for the MacBook.

Both now hold a token for the other: two-way, in one step. Each side then checks that it can reach the other. If the Mac mini can't reach the MacBook's address, pairing still works one way. The MacBook says: "Paired. Mac mini can't reach this MacBook at 192.168.1.30, so you can use Mac mini from here, but not the other way. Turn on Tailscale to fix it."

The code sits in the link's `#fragment`. Opening the link in a browser shows "Paste this link into TOT on your other device", and the code never reaches a server log.

**Tokens.**

- Device tokens are 32 random bytes.
- The device that issued a token stores only its SHA-256.
- The device that holds a token keeps it in `secrets.json` (0600) as `deviceToken:<id>`.
- Tokens never appear in logs, errors or tool output.

**What a paired device may do.** Everything a signed-in screen may do, **except**:

- device management: pairing codes, connect, unpair others, the sign-in list;
- `/api/d/*` (no chains);
- `/mcp`;
- the routes that are already this-machine-only.

**Sign-in sessions (screens).** Signing in creates a row with a random token. The cookie holds that token, and the device stores only its hash. A label comes from the browser ("Safari on iPhone"), plus last-seen. Signing one out ends its requests at once and closes its open event streams.

## Data model

```sql
-- 07 · Devices
CREATE TABLE IF NOT EXISTS sessions (           -- browsers and phones signed in to this device
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (            -- devices paired with this one
  id           TEXT PRIMARY KEY,                -- the other device's id
  name         TEXT NOT NULL,
  address      TEXT NOT NULL,                   -- where to reach it, e.g. http://100.101.4.2:5173
  token_hash   TEXT NOT NULL UNIQUE,            -- hash of the token *it* uses to call us
  paired_at    INTEGER NOT NULL,
  last_seen_at INTEGER
);
```

- **This device's identity:** `settings` key `device` = `{ id, name }`. The id is created once and never changes. The name defaults to the Mac's name, and you can rename it.
- **Pairing codes** live in memory only, so a restart voids them.
- **`shared/types.ts`:**
  - `Device` = `{ id, name, address, self, online, lastSeenAt, pairedAt, canReachBack }`.
  - `SignInSession` = `{ id, label, current, createdAt, lastSeenAt }`.
  - `Agent` and `Project` gain `deviceId` (filled in by the server), so the client always knows where a thing lives.
  - AppEvents gain `{ type: "device"; device }` and `{ type: "remote"; deviceId; event: AppEvent }`.

## Server design

All new code goes in `server/devices/`.

- **`identity.ts`:**
  - `self()` returns `{ id, name, version }`.
  - `addresses()` returns the Tailscale address first, then LAN addresses, with the port another machine would use.
  - `GET /.well-known/tot` is open and returns `{ id, name, protocol: 1 }`, used for reachability checks.
- **`sessions.ts`:** create, check, list, revoke. `auth.ts`'s `check()` accepts a session cookie or a device token and records which one it was. Revoking closes that caller's open SSE streams.
- **`pairing.ts`:**
  - `newCode()`;
  - `POST /api/pair`, which is open, but only works with a live code and is rate-limited;
  - `connect(link)`, the MacBook side;
  - `unpair(id)`, which forgets the device locally and then tells the other side (best effort).
- **`proxy.ts`:**
  - `ALL /api/d/:deviceId/*` forwards method, body and query with the device token.
  - SSE responses are streamed through, passing `Last-Event-ID` for run streams.
  - It times out a dead device in 10 s with a clear "MacBook is offline" error.
- **`relay.ts`:**
  - one event stream per paired device, re-emitted locally as `remote` events;
  - a `device` event whenever one goes online or offline;
  - reconnects with backoff up to 30 s.
- **`routes.ts`:**
  - `GET /api/devices` returns self, paired devices and sign-in sessions;
  - `POST /api/devices/pairing-code`;
  - `POST /api/devices/connect`;
  - `PATCH /api/devices/:id` (name, address);
  - `DELETE /api/devices/:id`;
  - `DELETE /api/sessions/:id`;
  - `POST /api/sessions/sign-out-others`.
- **`prompt.ts`:** the `# Device` line, added in `prepareTurn` only when this device has paired devices.

## UI

**Settings → Devices:** one page, three short sections.

```
 Devices
 This device   Mac mini   http://100.101.4.2:5173 (Tailscale)         [ … ]
 Paired        MacBook    online                                       [ … ]   Rename · Change address · Unpair
               Studio     asleep · seen 3 days ago                     [ … ]
                                        [ Connect to a device ]  [ Add a device ]
 Signed in     Chrome on this Mac       now · this browser
               Safari on iPhone         2 h ago                        [ Sign out ]
```

**Add a device:** the link, a Copy button, and "Works once, for 5 minutes."

**Connect to a device:** one field ("Paste the link from the other device") and **Connect**. Success says "Paired with Mac mini. Its agents are in your rail."

**Elsewhere:**

- the rail, hover card, chat header and **Lives on** field described above;
- the project picker in a chat shows the projects on the chat's agent's device;
- the Projects section groups by device only when there's more than one.

**Phone install:** a web app manifest and icons. "Add to Home Screen" then opens TOT full screen, with the TOT icon and no browser bar.

## Milestones

- [ ] **M1 · This device and who's signed in.**
  - What to build:
    - device identity and `/.well-known/tot`;
    - real sign-in sessions (table, cookie, `check()`, revoke closes streams);
    - Settings → Devices with **This device** and **Signed in**;
    - the web app manifest and icons;
    - a README section, "Install on another Mac".
  - *Accept:*
    - Two browsers signed in are both listed. Signing one out makes its next request 401 and closes its event stream within a second.
    - A cookie from before M1 asks you to sign in once.
    - The device id survives a restart; renaming shows everywhere.
    - Chrome reports the app as installable.
- [ ] **M2 · Pair two devices.**
  - What to build:
    - pairing links and codes, `/api/pair`, connect, the `devices` table and device tokens;
    - limits on what a paired device may do;
    - unpair on both sides;
    - address detection (Tailscale first) and `TOT_HOST=tailscale`;
    - online/offline from the event stream, and the one-way "can't reach back" state.
  - *Accept, with two TOTs on this Mac (temp data dirs, ports 8807 and 8808):*
    - One paste pairs both ways, and each lists the other as online.
    - Stopping one shows it offline within 30 s; restarting it brings it back without pairing again.
    - A used code, or one older than 5 minutes, is refused.
    - A device token can't reach device management, `/mcp` or `/api/d/*`.
    - After unpairing, both forget each other and the old tokens get 401.
- [ ] **M3 · Use the other device's agents.**
  - What to build:
    - the proxy (JSON, the event stream, run streams with replay) and the event relay;
    - `deviceId` on agents and projects;
    - the client routing every call for a thing to its device (`src/lib/api.ts`), with the store tagging what it loads;
    - the rail badge, hover card, chat header and offline state.
  - *Accept:*
    - From A's screen you chat with B's agent. The turn runs on B: the messages are in B's database and not in A's.
    - B's own window shows that chat appear and stream live, and the same works from B to A.
    - Stop B mid-turn: A shows "offline". Start B again, and A shows the chat's real state.
    - With nothing paired, the app looks and behaves exactly as before.
- [ ] **M4 · The whole app across devices.**
  - What to build:
    - tasks and task cards, project pages and the project picker;
    - uploads and screenshots (their URLs go through the device);
    - approvals and agent settings for another device's agents;
    - **Lives on** in New agent;
    - the `# Device` prompt line;
    - a warning on the Devices page when two paired devices both have Slack or the same mailbox connected.
  - *Accept:*
    - From A, start a task in one of B's projects. Its card updates live on A and B.
    - Approve B's tool request from a phone signed in to A.
    - An image attached from A shows in B's chat.
- [ ] **M5 · Later.**
  - Move an agent to another device (agent, mascot, persona and notebook).
  - Memory that follows you across devices.
  - A cached read-only view of offline devices.
  - A packaged Mac app that starts at login, so a device is always reachable.
  - A preview gateway, so an agent's dev server opens from other screens.
  - An agent on one device starting a task for an agent on another.

## Tests

Add `server/devices.test.ts` to `npm test` with `TOT_DATA_DIR=$(mktemp -d)`. It covers sessions, codes (expiry and single use), token hashing, and the paired-device route limits.

Add `server/devices-pair.test.ts`, which starts a second TOT as a child process with its own temp data dir and a free port. It checks real pairing, the proxy, the event relay, offline and back online, and unpairing. Use fake senders for turns, as in `server/tasks.test.ts`.

- Every M1–M4 *Accept* line.
- No token ever appears in a response body, log line or error message (scan them).
- A request through `/api/d/<id>/d/<other>/…` is refused.

## Out of scope

- Copying or syncing chats, agents or projects between devices.
- A relay, accounts or any cloud service. Use Tailscale.
- Other people. TOT stays single-user; pairing is for your own computers.
- Agents running on a phone.

## Open questions

- **Always two-way?** A work laptop might be allowed to use the Mac mini without the Mac mini being able to use it. That would be a "This device can be used from Mac mini" switch, off or on, but it's a second concept. Leave it out until it's asked for.
- **Memory.** "About you" memory is per device today, so a MacBook agent doesn't know what you told a Mac mini agent. Should memory follow you across devices (M5), or is per-device fine?
- **Moving an agent.** When Kiwi moves to the Mac mini, do its chats move too, or stay behind on the MacBook as history?
- **The same repo on two devices.** Should `acme/web` on both devices show as one project, or as two labelled ones (simplest, and the plan above)?
