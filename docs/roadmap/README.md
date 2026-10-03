# TOT roadmap: multi-agent work you can trust

TOT should become a daily driver for running many agents at once, for code and for everything else.

**Chats and tasks mix freely, like Grok Bot.** You talk to an agent in a normal chat. When something needs real work, the chat turns into a task, or starts tasks of its own. Those tasks:

- run in the background on the agent's computer;
- each get their own git branch and worktree when they touch code;
- report back into the chat as live cards;
- can be steered, paused and queued;
- pass tests and an independent review before you see a PR.

The plan has five modules. Each has its own doc, written so an agent can pick it up and build it.

| # | Module | Doc | Depends on | Worktree |
|---|--------|-----|------------|----------|
| 01 | **Sessions & Tasks**: chats ↔ tasks, task cards, worktrees, queue, steer/pause, background runs, notifications | [01-sessions-and-tasks.md](01-sessions-and-tasks.md) | nothing | **A** |
| 02 | **Orchestration**: model tiers, sub-sessions, handoff packets, provider failover (its auto-spawn dispatcher was later removed: the chat's model decides) | [02-orchestration.md](02-orchestration.md) | 01 | **A** (after 01) |
| 03 | **Trust gates & playbooks**: repo profile, test gates, cross-provider review, scope guards, pstack-style playbooks | [03-trust-gates-and-playbooks.md](03-trust-gates-and-playbooks.md) | nothing for M1–M4; 01 for M5 | **B** |
| 04 | **PR workflow**: diff, draft PR, checks, address review comments, update branch, shortcuts | [04-pr-workflow.md](04-pr-workflow.md) | 01 | **B** (after 03 M1–M4) |
| 05 | **Coordination**: chats woken when their tasks finish, context that fits on a provider switch, retry-safe task tools, nothing ending silently, wait for a task, fork and merge back, attach a chat | [05-coordination.md](05-coordination.md) | 01, 02 (both merged) | **C** |

01, 02, 03 (M1–M4) and 05 are merged into `main`. 04 is next.

## Parallel plan: two worktrees

Module 01 is the foundation, because everything else hangs off "a session can be a task with a branch". Module 03 is the only big piece that can be built in parallel without it: profiles, gates, the reviewer and playbooks are standalone services until their final milestone. That gives two lanes:

```
Worktree A  feat/tasks ─── 01 M1 … M5 ──▶ merge ──▶ feat/orchestration ─── 02 M1 … M5 ──▶ merge
Worktree B  feat/trust ─── 03 M1 … M4 (standalone) ──▶ rebase on main (01 merged) ─── 03 M5 ──▶ merge ──▶ feat/pr ─── 04 ──▶ merge
```

**Merge order:**
1. 01
2. 03
3. 02 and 04, either order. They barely touch each other.

Whoever merges second rebases and resolves.

Set up the two worktrees from the main checkout. Pushing is the user's call; see the rules below.

```bash
git worktree add ../tot-tasks -b feat/tasks main
git worktree add ../tot-trust -b feat/trust main
cd ../tot-tasks && npm ci        # each worktree needs its own node_modules
```

Module 05 gets its own worktree from today's `main`:

```bash
git worktree add ../tot-coordination -b feat/coordination main
cd ../tot-coordination && npm ci
```

## Running the app inside a worktree

The user's own TOT runs from the main checkout: web on 5173, API on 8787, Executor on 4791, with data in `~/.tot`. **Never use those ports or that folder from a worktree.** `~/.tot` holds:

- real Slack and mailbox connections (a second copy would answer Slack messages twice);
- GitHub tokens;
- the user's chats.

Don't copy `.env` either: without `TOT_ACCESS_TOKEN` the app stays local-only, which is what you want.

```bash
# Worktree A (use 8802 / 5182 / 4802 for worktree B, 8803 / 5183 / 4803 and ~/.tot-dev-c for worktree C)
TOT_DATA_DIR=$HOME/.tot-dev-a TOT_PORT=8801 TOT_EXECUTOR_PORT=4801 npm run dev:server
TOT_PORT=8801 npx vite --port 5181 --strictPort
```

## Avoiding merge conflicts

Both lanes will touch some shared files: `shared/types.ts`, `server/db.ts`, `server/routes.ts`, `src/store.ts`, `src/lib/api.ts`, the sidebar and the settings sections. Keep those touches small:

- **New code goes in new files and folders.** 01 owns `server/tasks/` and `src/components/tasks/`; 03 owns `server/trust/` and `src/components/trust/`.
- **Routes:** each module adds its routes in its own file (e.g. `server/tasks/routes.ts`) exporting a Hono router. `server/routes.ts` gets one `api.route(...)` line.
- **Types:** add a new section at the **end** of `shared/types.ts` with a banner comment, plus the route docs in the existing route-docs block. Only 01 may change the existing `Conversation` / `MessagePart` / `AppEvent` types; 03 adds new types only.
- **Database:** add one schema block at the end of `server/db.ts`. Use the idempotent style already used there (`CREATE TABLE IF NOT EXISTS`, `hasColumn` checks), with a comment naming the module.
- **Frontend state:** put it in its own store file where possible (e.g. `src/lib/tasks.ts`), and keep `src/store.ts` edits to wiring.

## Rules for every agent (non-negotiable)

These come from the user's standing rules.

- **Git and GitHub:**
  - Never push, open or merge a PR, or push to `main` without the user's explicit OK for that exact action.
  - Local commits on your feature branch are fine.
  - GitHub writes inside the product stay as they are now: off by default; when on, agents push branches and open PRs only when asked, and **never merge or push to the default branch**.
- **Never send, edit or delete anything in Slack or Linear** for real without the user's explicit OK. Don't send real email either.
- **Tests:**
  - Every test suite's first import is `import "./test-data-dir.ts";` (adjust the path). It refuses to run against `~/.tot`.
  - Add each new suite to the `npm test` script with `TOT_DATA_DIR=$(mktemp -d)`.
  - Use fakes for providers, GitHub, Slack and mail. `server/slack.test.ts`, `server/github.test.ts` and `server/personas.test.ts` show the patterns, e.g. `useSender(...)` to fake turns and the fake GitHub server.
- **Secrets:** never print secrets or `.env` values, and never put tokens in tool output, logs or errors. Use `redactGitHubTokens` and the existing scrubbers.
- **Design:**
  - Follow `DESIGN.md`. TOT looks like the ChatGPT / Codex desktop app: neutral greys, flat rows, pill buttons, design tokens only, and it must work in light and dark.
  - Keep few visible actions; group secondary ones into one "…" menu.
  - Use the existing primitives (`src/components/ui/*`, including `Select`) and lucide icons. No emojis as icons.
  - For any visible change, check with real screenshots in both themes before calling it done.
- **Models:** use Claude Sonnet 5.5 for light work (classification, summaries) and Opus 5.5 for hard work. `server/agent/router.ts` already encodes this; extend it rather than hard-coding model ids elsewhere.
- **Code style:** match the surrounding code (comment density, naming, idioms). Keep functions readable; no speculative abstractions.

## Definition of done for every milestone

- `npm test` passes: every suite prints `ALL PASS`, including the new ones.
- `npx tsc -p tsconfig.server.json --noEmit` and `npx tsc -p . --noEmit` are clean.
- `npx vite build --outDir /tmp/<anything>` succeeds.
- UI changes have been checked with screenshots in light and dark, and on a phone-width viewport if the screen is reachable on mobile.
- The route docs in `shared/types.ts` are updated, and the milestone is ticked in its module doc with a one-line note of what shipped.
- Work is committed on the feature branch with a clear message, and is not pushed.

## Map of today's code (where things live)

| Area | Files |
|------|-------|
| Turn pipeline (model routing, system prompt, MCP servers per turn, approvals) | `server/agent/orchestrator.ts` (`sendMessage`, `TurnOptions`: `preamble`, `heavy`, `freshSession`, `maxSteps`), `router.ts`, `prompts.ts`, `approvals.ts` |
| Providers | `server/agent/providers/claude.ts` (Agent SDK `query()`), `chatgpt.ts` (Codex app-server JSON-RPC: `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`) |
| Live runs | `server/agent/runs.ts`: in memory only (`Run` keeps events, `runRegistry.activeFor(conversationId)`); **nothing survives a restart** |
| Usage limits / cooldowns | `server/agent/limits.ts` (persisted cooldown per provider; Auto avoids a limited provider) |
| Multi-step jobs (precedent) | `server/agent/learn-repo.ts`: steps sent one after another with `freshSession`, state kept in a brain checklist, stall detection |
| Scheduled runs | `server/agent/scheduler.ts` (routines run unattended) |
| Computers | `server/computer/manager.ts` (`ensure`, `act`, exec via the `computer_exec` tool with `cwd`), `local.ts` (macOS Seatbelt sandbox), `boat.ts` (cloud VMs). Repos live in `~/repos/<name>` on the agent's computer (Learn a repo) |
| Agent tools (TOT's MCP server) | `server/mcp/server.ts` (+ `wiki-tools.ts`, `mail-tools.ts`); served per conversation at `/mcp/<conversationId>` |
| Brains / wiki | `server/data/brains.ts`, `server/data/wiki.ts`, `server/agent/brain-hints.ts`; repo brains come from Learn a repo |
| GitHub | `server/github.ts`, `server/persona-github.ts` (`githubAccessFor(agentId)` is the single decision point), `server/computer/github-login.ts` |
| External triggers | `server/slack.ts` (thread → chat, status line, approval buttons), `server/mail/tasks.ts` (emailed tasks) |
| Frontend | `src/store.ts` (zustand), `src/lib/api.ts`, `src/components/Sidebar.tsx`, `ChatView.tsx`, `MessagePartView.tsx`, `Header.tsx`, `Composer.tsx`, `settings/*` |
