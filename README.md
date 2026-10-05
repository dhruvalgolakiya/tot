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

## Landing page

The public page for TOT lives in `site/`, built from the app's own design tokens and mascots. It's a static site with no API and no sign-in.

```bash
npm run site          # http://localhost:5190
npm run site:build    # static files in site/dist, ready for any host
```

## Use TOT from your phone

TOT only serves this machine until you give it an access token.

**On your Wi-Fi** (phone, tablet, other computers):

1. In `.env`, set `TOT_ACCESS_TOKEN` (e.g. `openssl rand -hex 16`) and `TOT_LAN=1`.
2. Restart `npm run dev`. The startup log prints your network URLs, e.g. `http://192.168.1.21:5173` and `http://<your-mac>.local:5173`.
3. Open one on your phone and sign in with the token (dashes and capitals don't matter). The session lasts 30 days.
4. To keep TOT as an app, choose **Add to Home Screen** (Safari's Share menu, or Chrome's ⋮ menu). It opens full screen with the TOT icon.

**Settings → Devices** shows this computer's address, and every browser and phone signed in to it. Sign any one out there, and it's out at once. Changing the token signs out all of them.

In dev, only the web app listens on the network; the API stays private behind it. With `npm run build && npm start`, the server itself listens on your network (port 8787). TOT binds IPv4 only — networks often hand out public IPv6 addresses, which would otherwise put it on the internet. Voice input needs HTTPS, so the mic button hides over plain `http://`.

**From anywhere:** keep the token, run `npm run build && npm start`, and expose port 8787 over HTTPS with a tunnel, e.g. `cloudflared tunnel --url http://localhost:8787`.

With a token set, every page and API call requires sign-in (a cookie, or `Authorization: Bearer <token>` for scripts), cross-site requests are blocked, wrong-token guesses are rate-limited, and the agents' tool endpoint answers only this machine. TOT refuses to start on the network without a token.

## Install TOT on another Mac

Each computer runs its own TOT, with its own agents, chats and logins. Nothing is shared between them yet: pairing two computers, so each can use the other's agents, is next on the roadmap ([07 · Devices](docs/roadmap/07-devices.md)).

1. Install Node and log in to Claude and/or Codex on that Mac, as in [Quick start](#quick-start).
2. `git clone` this repo there, then `npm install`.
3. Make its own `.env` with a fresh `TOT_ACCESS_TOKEN` (`openssl rand -hex 16`), plus `TOT_LAN=1` to reach it from other devices. Don't copy this Mac's `.env`: tokens and keys belong to one computer.
4. `npm run dev`. Its Settings → Devices page shows the address to open from your phone.

With [Tailscale](https://tailscale.com) on both, the address works from anywhere, not just your Wi-Fi, and TOT shows the Tailscale address first.

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
```

Data lives in `~/.tot` (override with `TOT_DATA_DIR`). All settings can go in `.env` — see `.env.example`: `BOAT_API_KEY`, `ANTHROPIC_API_KEY` (only for Claude API-key mode), `TOT_PORT` (8787), `TOT_HOST` (127.0.0.1), `TOT_CLAUDE_CONFIG_DIR`, `TOT_CODEX_PATH`.

## Subscriptions, and "everyone can use it"

TOT is built for local, personal use of your own subscriptions — the way Claude Code and Codex themselves use them.

To host TOT for other people:
- **Claude:** Anthropic doesn't allow third-party products to offer claude.ai login or subscription limits without prior approval, so hosted TOT must use API keys (Settings → Models → Claude → API key; per-user keys in a hosted build).
- **ChatGPT:** OpenAI's *Sign in with ChatGPT* lets open-source/locally-hosted apps use a user's ChatGPT plan without approval; paid or remotely hosted apps must join OpenAI's partner program first. Codex app-server can take per-user ChatGPT tokens, so the provider layer is ready for it.
- **Computers:** Boat already isolates each agent in its own VM, which is what a multi-user deployment needs.
