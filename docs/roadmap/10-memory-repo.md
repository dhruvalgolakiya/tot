# 10 · Memory repo: memory as git, shared by your devices, tidied every night

**Lane:** worktree `tot-memory`, branch `feat/memory-repo`, from `main` after 08. Independent of 09 (different files) except `shared/types.ts`, `server/routes.ts`, `package.json` (test chain) and `src/lib/api.ts`, merged by the lead. **Depends on:** 06 (projects), 07 (paired devices). Read [README.md](README.md) first.

## Goal

TOT's memory follows the open [Agent Memory Repo](https://github.com/AgentMemoryRepo/agentmemoryrepo) spec (Cognition, MIT): memory is a **git repo of markdown**, so it has history, merges and undo, it's readable by any agent (Claude Code, Codex, Cursor), and it can travel between computers.

- **About you** (`you`): what you told any agent. Today's `memories` table becomes this repo.
- **Per project** (`projects/<slug>`): what agents learned working on it ("tests need `TZ=UTC`", "deploys go through `make ship`"). Every chat and task in the project, on every worktree, reads and writes it.
- **Shared by paired devices** (module 07's open question): the `you` repo syncs with paired computers, no GitHub needed. Optionally backed up to a private git remote you set up.
- **Dreaming:** a nightly pass merges duplicates, drops stale entries, settles contradictions and spots patterns. Every change is a commit you can undo.

Brains and the wiki (long-form documents, Learn a repo) stay as they are. Memory is short facts; the wiki is documents.

## Today (what this replaces)

- `memories` table + `memories_fts` (`server/db.ts`), `server/data/memories.ts` (`forPrompt` budget 5000 chars).
- Tools `memory_save`/`memory_search`/`memory_update`/`memory_delete` (`server/mcp/server.ts`, gated by `memory.enabled`).
- Routes `GET/POST/PATCH/DELETE /api/memories`, UI `src/components/MemoryBrowser.tsx` (Settings → Memory).
- Loaded once, into a chat's first system prompt (`orchestrator.ts` → `prompts.ts` `memorySection`).
- Per device; nothing synced; nothing cleans up. The wiki keeper (`server/agent/wiki-keeper.ts`) is the model for a background job with a light model (`defaultComplete`, Sonnet then ChatGPT).

## The format (the spec, plus three TOT rules)

```
~/.tot/memory/you/
  MEMORY.md          entry point, loaded every session: short, links to the rest
  preferences.md     topic files, any names, any folders
  people.md
  .gitattributes     *.md merge=union (kept from the first commit; TOT merges entry by entry itself)
```

- An entry is one line: `- Prefers pnpm over npm [id: 3f2a9c; source: tot://c/<conversationId>; added: 2026-10-06]`. Links: `[[preferences]]`, `[[billing/count_paying_customers.sql]]`.
- **TOT rule 1, ids:** entries TOT writes carry `id` (8 hex; older 6-hex ids still read) so tools can edit them. Lines a person wrote without one get a derived id (`h` + 10 hex of a hash of path + text), not written back, and only touched while their text still matches. The same id twice: both lines are kept, as `<id>` and `<id>.2`.
- **TOT rule 2, merges never conflict, and deletes stick:** TOT merges memory itself, entry by entry against the merge base (`server/memory/merge.ts`), and writes the two-parent commit. Removed on one side and unchanged on the other → removed (a plain line union would bring it back); edited on one side → that edit; edited on both → both kept (Dreaming tidies); added on either → kept. Other lines merge three-way, this device winning a clash. A peer's links, scripts, dotfiles and submodules are dropped.
- **TOT rule 3, no secrets:** every write is checked against `server/trust/shell.ts`'s secret shapes, TOT's own secret values and `redactGitHubTokens`. A match is refused with "That looks like a secret; memory never stores secrets."
- Every write is one commit (author `TOT`, message `"<agent>: remember …"` / `"you: edit …"`), serialized per repo.

## Server design (`server/memory/`)

- **`repo.ts`:** init (git init, `.gitattributes`, starter MEMORY.md), read/list files, parse/serialize entries (tolerant: any `- ` line is an entry, trailing `[...]` metadata), add/update/delete an entry, commit, log, revert. Git via `execFile` on this machine (not the agent's computer). Repos: `DATA_DIR/memory/you`, `DATA_DIR/memory/projects/<slug>`.
- **`index.ts`:** `memories` becomes an index rebuilt from the files (add `repo`, `path` columns; FTS unchanged), reindexed after every commit, merge, revert and at startup.
- **`migrate.ts`:** first start with no `memory/you`: today's rows become entries (MEMORY.md up to ~3500 chars, the rest in `notes.md`, linked); one commit "Imported N memories". Idempotent.
- **Tools** (same names, more reach): `memory_save {content, scope?: "you"|"project", file?}`, `memory_search {query, scope?}`, `memory_update {id, content}`, `memory_delete {id}`, new `memory_read {path, scope?}` (follow `[[links]]`). Descriptions teach routing: facts about the user → `you`; facts about the code or project → `project` (only in a project chat or task). Tasks in worktrees use the same tools: writes are serialized on the server, so parallel tasks never conflict.
- **Prompt:** first turn loads `you/MEMORY.md` (≤ 4000 chars), the project's MEMORY.md (≤ 3000) and FTS-relevant entries from other files (≤ 2000), replacing `memorySection`'s list. Same for tasks.
- **Sync with paired devices** (`sync.ts`), the `you` repo only:
  - each device serves `GET /api/memory/sync/you.bundle` to **paired devices only** (device token; browsers and phones get 403);
  - every 10 minutes, and soon after a peer's `memory` device event, a device fetches each online peer's bundle (streamed, 50 MB cap, objects checked) into `refs/peers/<deviceId>` and merges it entry by entry (rule 2). One device of a pair merges and the other fast-forwards; after 30 minutes of waiting either may merge;
  - both sides pull, so they converge;
  - status per peer: last sync, ok or error.
- **Optional remote backup:** `memory.remote = {url, enabled}`. When the user turns it on with a URL (a private repo they made), TOT pulls (rebase) and pushes the `you` repo after writes (debounced) and every 10 minutes. Off by default; tests use a local bare repo only.
- **Dreaming** (`dreaming.ts`):
  - nightly at `memory.dreaming.time` (default 03:30 local), only when a repo changed or chats happened since the last dream; also "Dream now";
  - input: the repo's files (≤ 30k chars) and the user's messages since the last dream (≤ 20k);
  - output: strict JSON ops: `merge {ids, text, file}`, `update {id, text}`, `delete {id, reason}`, `add {file, text, source}`, `move {id, file}`, at most 30;
  - validated: known ids only, no secret, never more than 40 % of entries removed;
  - applied as one commit "Dreaming: merged 3, removed 2, added 1" with the details in the body. Undo = revert;
  - uses the keeper's light model.
- **Routes:**
  - `GET /api/memory/repos` (you + projects, with entry counts, last commit, sync status);
  - `GET /api/memory/:repo/files`, `GET /api/memory/:repo/file?path=`;
  - `GET /api/memory/:repo/history`, `POST /api/memory/:repo/revert {sha}`;
  - `POST /api/memory/dream {repo?}`;
  - `GET/PATCH` settings via the existing settings route.
  - Existing `/api/memories` keeps working (scope `you`, plus `?repo=`).
  - `memory` is added to the list paired devices can't call, except the sync bundle.

## UI

- **Settings → Memory** (rework `MemoryBrowser.tsx`):
  - a repo picker (About you · each project);
  - MEMORY.md rendered on top;
  - the entries grouped by file, with search, add, edit and delete as today;
  - **History:** commits with author/agent, time and what changed, and **Undo** on each, with a confirm;
  - **Dreaming:** on/off, time, last dream ("merged 3, removed 2 · Undo"), **Dream now**;
  - **Sync:** paired devices with their last sync, plus the optional backup remote (URL, on/off, last push).
  - Light and dark; few visible actions (edit/delete on hover, the rest in "…").
- **Project page:** a small "Memory · 12 entries" row linking to Settings → Memory with that project picked.
- A line in Settings → Memory: "Your memory is a git repo at `~/.tot/memory/you`. Claude Code, Codex and Cursor can read it too: `npx skills add AgentMemoryRepo/agentmemoryrepo --skill agent-memory-repo`."

## Milestones

- [x] **M1 · Repos, format, index, migration, tools, prompt.**
  - *Accept:* existing memories migrate once; save/search/update/delete work through the files with one commit each; a secret is refused; a project chat writes to the project repo; the first-turn prompt includes both MEMORY.md files.
  - *Shipped:* `server/memory/` — `repo.ts` (git through `execFile` with the user's git config shut out; the entry format with derived `h…` ids; `withRepo` serializing each repo; a first commit that's identical on every device so their repos share history; history, undo, merge), `index.ts` (the `memories` table, rebuilt once in `db.ts` without its old primary key, is now an index of the files; the old rows are kept in `memories_legacy`), `memory.ts` (remember/edit/forget with the secret check, one commit each, a commit for anything edited by hand first, MEMORY.md overflowing into `notes.md` past 3500 characters, topic files linked from MEMORY.md's "See also:" line), `migrate.ts` (once, "Imported N memories", secrets left out), `tools.ts` (the four tools plus `memory_read`, with `scope` and `file`), `prompt.ts` (you/MEMORY.md ≤ 4000, the project's ≤ 3000, related entries ≤ 2000, each with its id), `routes.ts`, `start.ts`. Tested in `server/memory.test.ts` (a pre-module-10 database migrated, tools over MCP, secrets of every kind, a hand-written line, a project chat, the first turn's prompt through the real pipeline).
- [x] **M2 · Parallel writers and history.**
  - *Accept:* 20 concurrent saves from different tasks give 20 commits and no lost entry; revert restores an entry and reindexes.
  - *Shipped:* writes queue per repo; history with actor (a `TOT-Actor:` trailer), kind and lines changed; undo is a revert in which markdown merges as plain text, so an undo that collides with later edits is refused (409) instead of keeping both; the first commit can't be undone. Tested: 20 chats saving at once over MCP, undoing a delete, a colliding undo.
- [x] **M3 · Sync with paired devices and the optional remote.**
  - *Accept:* two TOT instances in one test (two data dirs, a fake peer link) converge after each adds an entry; the same line edited on both keeps both; browsers get 403 on the bundle; remote push/pull against a local bare repo.
  - *Shipped:* `sync.ts`: the bundle route (paired devices only), pulls every 10 minutes, after a paired device's `memory` event (a new `relay.onEvent` hook) and when one comes online; per-peer status kept in `settings`; the backup remote (fetch, merge, push; URLs with passwords or tokens refused). Of each pair only one device merges (the smaller id, or the one the other can't reach) and the other fast-forwards, so both never make different merges of the same changes. Tested in `server/memory-sync.test.ts` with two real TOTs paired through the API (the second a child process): converge with one merge, the same line edited on both keeps both versions, 403 for a script and a signed-in browser, paired devices refused on the other memory routes; the remote against a local bare repo in `server/memory.test.ts`.
- [x] **M4 · Dreaming.**
  - *Accept:* with a fake model, duplicates merge, a stale entry goes, unknown ids and secrets are refused, over-deletion is refused, and the commit reverts cleanly.
  - *Shipped:* `dreaming.ts`: nightly at `memory.dreaming.time` (or within 6 hours after, if TOT was off then), only for repos that changed or had chats since their last dream; "Dream now" in the background; the keeper's light model (`defaultComplete`, now exported); ops checked one by one (known ids, no secrets, nothing edited while the model thought) and the whole plan refused past 40% removed; one commit "Dreaming: merged 1, removed 1, added 1" with the details in its body; the last dream kept per repo for Settings.
- [x] **M5 · UI.**
  - *Accept:* screenshots of Settings → Memory (you and a project, history, Dreaming, sync) in light and dark.
  - *Shipped:* Settings → Memory rebuilt (`MemoryBrowser.tsx` and `src/components/memory/`): the repo picker, where the repo lives with the `npx skills add …` line, entries grouped by file under MEMORY.md's own text (search, add, edit and delete on hover), History with Undo (confirmed), Dreaming (on/off, time, last dream with Undo, Dream now), and for About you, Sync (paired devices with their last sync, the backup remote's URL, switch and last push). A project's page has a "Memory · N entries" row that opens it. Views reload on `memory` events (`src/lib/memory.ts`). Checked with headless-Chrome screenshots, light and dark, 1280×800 and 390×844.

## Out of scope

- Moving wiki pages or brains into git.
- Syncing project memory between devices (projects are per device; 07).
- Sharing memory with other people.
