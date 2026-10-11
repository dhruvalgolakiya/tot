# TOT

Your own always-on AI agents — in the spirit of ChatGPT Dots and Grok Bot — running on **your own subscriptions**: ChatGPT (via Codex) and Claude (via Claude Code). Every agent has a **mascot**, a **personality**, **its own cloud computer**, shared **long-term memory** about you, and **plugins**.

- **Agents.** Create as many as you like (Tot is the default). Each one has an animated mascot that shows what it's doing — thinking, working on its computer, talking — a personality, a default model, and a computer that persists across all of its chats.
- **Two brains, one app.** Claude Opus 5.5 / Sonnet 5.5 through your Claude subscription, GPT‑6.x through your ChatGPT plan. No API keys needed for local use.
- **TOT Auto.** Quick asks go to Sonnet 5.5 (fast); coding, debugging, research and long requests go to Opus 5.5; "Think harder" forces Opus at extra-high effort. When a plan hits its usage limit, Auto moves to the other provider until it resets.
- **A computer per agent.** A [boat.dev](https://boat.dev) cloud VM (Ubuntu, Docker, Node, Python, Chrome, 60 fps desktop) created on first use and stopped when idle. Agents run shell commands, edit files, share web servers as public links, and **use the desktop** (screenshot, click, type) for sites that need a real browser — while you watch live. Without a Boat key, agents get a sandboxed local folder instead (no desktop).
- **Routines.** Agents run recurring tasks on their own ("every weekday at 9, brief me on AI news") — ask in chat and the agent schedules it, or set one up in the agent's settings. Each run starts a new chat.
- **Attachments.** Drop in images (the model sees them), text/code/CSV files (read inline), or anything else (copied to the agent's computer under `~/uploads`).
- **Memory.** Agents save durable facts about you across chats (edit them in the Memory panel).
- **Light & dark.** Follows your device by default; switch in Settings → General or with the sun/moon button in the sidebar (saved per device).
- **Plugins.** Any MCP server. ChatGPT turns can also use the apps connected to your ChatGPT account; Claude turns can use your claude.ai connectors.

## Quick start

Requirements: Node ≥ 22.13 (24 recommended), and at least one provider logged in:

| Provider | Log in once in a terminal | Check |
|---|---|---|
| Claude (Pro/Max) | `claude` → `/login` | `claude` starts without asking to log in |
| ChatGPT (Plus/Pro) | `codex login` (or the **Connect ChatGPT** button in Settings) | `codex login status` |

```bash
npm install
npm run dev          # API on :8787, web app on :5173
open http://localhost:5173
```

**Cloud computers (recommended):** create a key at [boat.dev/dashboard](https://boat.dev/dashboard?tab=api-keys) ($20/month minimum, billed per second while a VM runs) and either paste it in **Settings → Computer** or put it in `.env`:

```bash
cp .env.example .env    # then set BOAT_API_KEY=boat_...
```

Restart `npm run dev` after editing `.env`. With a key present, new agent computers are Boat VMs; without one, each agent gets a sandboxed local folder (macOS Seatbelt: writes only inside its workspace, no access to your files).

Production-style run: `npm run build && npm start` (serves the built UI from the API server on :8787).

## Mac app

TOT also runs as **TOT.app** (Apple silicon). It starts the TOT server itself, with the Node built into the app, and opens it in its own window, signed in like any browser on this computer. Close the window and TOT keeps running in the menu bar, so your phone and paired devices keep working; **Quit TOT** in the menu bar (or Cmd+Q) stops it and everything it started. If a TOT is already running on the port (say `npm run dev`), the app opens that one instead of starting a second. It uses the same port (8787) and data (`~/.tot`) as `npm start`, and you still log in to Claude and Codex once in a terminal.

```bash
npm run app:build    # release/TOT-0.1.0-arm64.dmg and .zip (and release/mac-arm64/TOT.app)
npm run app:dev      # from this checkout: opens a running dev TOT, or starts the bundled server (run npm run build once first)
```

The build is signed ad hoc, so it runs on the Mac that built it; on another Mac, right-click → Open the first time (a signed and notarized build needs an Apple Developer account). The menu bar menu has **Open at login**, so TOT is always reachable, and **Show log** (`~/Library/Logs/TOT/server.log`). Apps opened from Finder don't see your shell's PATH, so TOT reads it from your login shell and adds `node`, `npm` and `npx` of its own after yours. Details in [08 · Mac app](docs/roadmap/08-mac-app.md).

## Landing page

The public page for TOT lives in `site/`, built from the app's own design tokens and mascots. It's a static site with no API and no sign-in.

```bash
npm run site          # http://localhost:5190
npm run site:build    # static files in site/dist, ready for any host
```

## Use TOT from your phone

TOT only serves this computer until you turn on remote access, and this computer never asks you to sign in.

1. Open **Settings → Devices → Set up**.
2. Choose a password. Other devices sign in with it; you can reset it from this computer if you forget it.
3. Pick how other devices reach this one: **Anywhere, with Tailscale** (recommended: install [Tailscale](https://tailscale.com) on this computer and your phone, signed in to the same account) or **Only on this Wi‑Fi**. If macOS asks whether to accept incoming connections, choose Allow.
4. Scan the QR code with your phone's camera. It opens TOT signed in, no password needed.
5. To keep TOT as an app, choose **Add to Home Screen** (Safari's Share menu, or Chrome's ⋮ menu). It opens full screen with the TOT icon.

**Settings → Devices** shows the address, a switch to turn remote access off, and every phone and browser signed in. Sign any one out there and it's out at once; changing the password signs out all of them.

How it's kept safe:

- Other devices need a session (from the password or a phone's one-time code), and wrong guesses are rate-limited.
- Cross-site requests are blocked, and the agents' tool endpoint answers only this computer.
- TOT listens only on the addresses you chose (the Tailscale or home-network address, IPv4), never on all of them, and stops the moment you turn it off. In development, the Vite dev server stays on this computer; other devices get the app through TOT.
- Voice input needs HTTPS, so the mic button hides over plain `http://`.

**From anywhere without Tailscale:** run `npm run build && npm start` and expose port 8787 over HTTPS with a tunnel, e.g. `cloudflared tunnel --url http://localhost:8787`, then set `TOT_PUBLIC_URL` to the tunnel's address. Visitors through a tunnel always sign in.

**Older setups:** `TOT_ACCESS_TOKEN`, `TOT_LAN=1` and `TOT_HOST=tailscale` in `.env` still work. The token is accepted as a password and as `Authorization: Bearer <token>` for scripts, and the other two fix the remote-access setting (the Devices page says so). Remove them to manage everything in the app.

## Mobile app

`mobile/` is TOT's iPhone app (in development; Expo, React Native): every agent on this TOT and its paired devices, their chats, live replies and approvals, tasks (mission control, steer, pause, land) and projects, the model picker, agent settings, Settings (models and accounts, tasks, memory, devices), notifications while it's open or just closed (with a catch-up when it comes back), and a read-only Knowledge viewer. It's a client of your TOT, not a copy: nothing is synced and no TOT runs on the phone. It signs in like a phone browser, with the QR code from **Settings → Devices → Add a phone** (or the address and password), and shows up in the sign-in list there. Details in [14 · Mobile app](docs/roadmap/14-mobile.md).

```bash
cd mobile && npm install
npx expo start --ios     # opens it in the iOS Simulator with Expo Go (Xcode installed)
npx tsc --noEmit         # typecheck; mobile/ isn't part of the root build or tests
```

On this Mac's simulator, connect to `127.0.0.1:8787` (no sign-in needed: this computer never signs in). To try the real sign-in, turn on remote access and connect to the address Settings → Devices shows. On a real iPhone, scan the QR code `npx expo start` prints with the Expo Go app.

## Install TOT on another Mac, and pair them

Each computer runs its own TOT, with its own agents, chats and logins. Pair two once, and each shows the other's agents: talk to the MacBook's agents from the Mac mini and the other way round, live on both. Nothing is copied: an agent's chats, files and logins stay on the computer it lives on. ([07 · Devices](docs/roadmap/07-devices.md) has the details.)

1. Install Node and log in to Claude and/or Codex on that Mac, as in [Quick start](#quick-start).
2. `git clone` this repo there, then `npm install`.
3. `npm run dev` there. Don't copy this Mac's `.env`: tokens and keys belong to one computer.
4. Turn on remote access on both computers (**Settings → Devices → Set up**: a password each, then Tailscale).
5. On one, open **Settings → Devices → Pair a device** and copy the link. On the other, open the same dialog and paste it. One paste pairs them both ways.

[Tailscale](https://tailscale.com) on both is the way to go: it works from anywhere, not just your Wi-Fi, and it's encrypted. Plain Wi-Fi works too, at home only. If a computer has a name or tunnel of its own, set `TOT_PUBLIC_URL` to it.

Each computer keeps its own logins, GitHub, Slack, mail and apps. If both run the same Slack bot or mailbox, Settings → Devices warns you, since both would answer.

## How it works

```
Browser (React + Vite)
   │  REST + Server-Sent Events (/api/*)
   ▼
TOT server (Hono on Node)  ── SQLite (~/.tot/tot.db: chats, memory, plugins, settings)
   │  picks a model (TOT Auto router), builds the system prompt (persona + memory)
   ├─► Claude provider ── Claude Agent SDK ──► Claude Code (your Claude login)
   └─► ChatGPT provider ── codex app-server ──► Codex (your ChatGPT login)
            │                                   both locked down: no local shell/file tools
            ▼
   TOT MCP server (/mcp/<chat>)  ── computer_* tools ──► the agent's Boat VM (or sandboxed local folder)
                                 ├─ desktop tools    ──► screenshot / click / type on the VM's desktop
                                 ├─ memory_* tools   ──► SQLite FTS5
                                 └─ routine_* tools  ──► scheduler (starts new chats when due)
```

- The agent harnesses run on your machine, but their local shell/file tools are disabled. Everything the agent *does* goes through TOT's MCP tools, which act on that chat's computer.
- Each agent's computer is created on its first tool call, stopped after `idleStopMinutes` (default 10) and resumed on the next call; files and installed packages persist, running servers don't.
- Each chat keeps its provider session (Claude session / Codex thread), so follow-ups resume with full context. Switching providers mid-chat carries the transcript over.
- Replies stream token by token. Runs are decoupled from the HTTP request: reload the page mid-reply and it reattaches.

## Project layout

```
shared/types.ts          API contract shared by server and web
server/
  index.ts, routes.ts    HTTP API (+ local-only Host/Origin guard)
  agent/                 orchestrator, Auto router, prompts, run registry
  agent/providers/       claude.ts (Agent SDK), chatgpt.ts (codex app-server)
  mcp/server.ts          built-in MCP server: computer, desktop and memory tools
  computer/              Boat + local backends, lifecycle manager (lazy start, idle stop), screenshots
  data/                  SQLite repositories
src/                     React app (sidebar, chat, model picker, computer panel, memory, settings)
electron/                the Mac app: main process, bundled server, menu bar, packaging
mobile/                  the iPhone app (Expo); its own package.json, shares shared/types.ts
```

Data lives in `~/.tot` (override with `TOT_DATA_DIR`). All settings can go in `.env` — see `.env.example`: `BOAT_API_KEY`, `ANTHROPIC_API_KEY` (only for Claude API-key mode), `TOT_PORT` (8787), `TOT_WEB_PORT` (5173, the dev web server), `TOT_CLAUDE_CONFIG_DIR`, `TOT_CODEX_PATH`.

## Subscriptions, and "everyone can use it"

TOT is built for local, personal use of your own subscriptions — the way Claude Code and Codex themselves use them.

To host TOT for other people:
- **Claude:** Anthropic doesn't allow third-party products to offer claude.ai login or subscription limits without prior approval, so hosted TOT must use API keys (Settings → Models → Claude → API key; per-user keys in a hosted build).
- **ChatGPT:** OpenAI's *Sign in with ChatGPT* lets open-source/locally-hosted apps use a user's ChatGPT plan without approval; paid or remotely hosted apps must join OpenAI's partner program first. Codex app-server can take per-user ChatGPT tokens, so the provider layer is ready for it.
- **Computers:** Boat already isolates each agent in its own VM, which is what a multi-user deployment needs.
