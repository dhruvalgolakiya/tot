# 11 · Workspaces: one place for a project's repos, knowledge and agents

**Lane:** worktree `tot-ws`, branch `feat/workspaces`, from `main` after the Inter switch (3cafb45). Built in four parallel lanes (A–D) off the contract commit, merged by the lead. **Depends on:** 06 (projects), 09 (mission control, landing), 10 (memory repos). Read [README.md](README.md) first.

## Goal

One place to run a project, like a Cursor project with a brain:

- **A project is a workspace of repos.** It holds any mix of GitHub repos and folders on your Mac (`web`, `api`, `mobile`). Each task works in one of them; the Lead splits cross-repo work into one task per repo.
- **One knowledge base per project.** The project's wiki and its memory become one git repo of markdown (the Agent Memory Repo format): `MEMORY.md` facts loaded every chat, `pages/` for documents, `repos/<name>/` for each repo's docs. History and Undo on everything.
- **It keeps itself up to date.** When code lands, when a repo's main branch moves, and after chats and tasks, TOT updates the affected docs and facts.
- **A Lead runs the project.** Each project has a pinned Lead chat, the top-level orchestrator: it plans, starts tasks across repos, steers them, answers what it can, and proposes landing. Every merge or PR waits for your click (an approval card).
- **One screen.** The project page is the Lead chat with a live mission board and the Knowledge beside it. A Home overview shows every project.

Decided with the user (2026-10-06): merge wiki and memory into one git knowledge base; the Lead lands only with the user's OK; cross-repo work is one task per repo.

## Rules

- **Nothing lost.** Wiki pages move into git once, with their ids. The old tables are kept (`wiki_pages_legacy`, `wiki_revisions_legacy`), never dropped; old revisions stay readable as "Before git" history. A failed move leaves the wiki working from the database, shows the error, and retries next start (module 10's pattern).
- **Never move an existing checkout.** A project's existing clone or folder keeps its path; added repos get new ones.
- **The Lead never lands on its own.** Its `task_land` asks you with an approval card; no answer or "no" lands nothing. Pushing and PRs still follow GitHub writes.
- **Knowledge stays local.** Project knowledge repos aren't synced between devices (as in 10). Secrets are refused in pages as in facts.
- **Auto-updates are bounded and undoable:** each run is one commit by "TOT", never shrinks a page by more than 60 %, only edits pages it read, and skips a page the user changed since it read it.
- Tests: `TOT_DATA_DIR=$(mktemp -d)`, first import `./test-data-dir.ts`, real git in temp dirs, fake models; never `~/.tot`, real GitHub, or ports 5173/8787. DESIGN.md: Inter, light and dark, few visible actions, no colored side bars.

## Contract (committed first; lanes build on it)

`shared/types.ts`, "Workspaces (module 11)" block:

- `ProjectRepo { name, kind: "github" | "folder", source, defaultBranch, folderGranted, primary }`, `Project.repos?: ProjectRepo[]` (the primary first; `kind`/`source`/`folderGranted` mirror the primary for older code), `AddProjectRepoRequest`, `UpdateProjectRepoRequest`.
- `TaskRepo.repoName?: string | null`: which of the project's repos a task works in.
- `WikiPageSummary.repo?: string | null`: a page that heads a repo's docs (its subtree is that repo's).
- `Project.leadChatId?: string | null`; `Conversation.lead?: boolean`.
- `KnowledgeStatus` (where the project's knowledge lives, whether the move to git is done or failed), `KnowledgeUpdate` (one auto-update run: trigger, repo, commit, pages and facts changed).
- `HomeProject` (a project's row on Home: counts and the Lead chat).

Route files (each lane owns one), registered in `server/routes.ts`:

| Lane | File | Routes |
|---|---|---|
| A | `server/projects/repos-routes.ts` | `POST /api/projects/:id/repos` · `PATCH /api/projects/:id/repos/:name` · `DELETE /api/projects/:id/repos/:name` · `POST /api/projects/:id/repos/:name/grant` |
| B | `server/knowledge/routes.ts` | `GET /api/projects/:id/knowledge` → `KnowledgeStatus` (wiki routes keep working unchanged on top of git) |
| C | `server/knowledge/auto-routes.ts` | `GET /api/projects/:id/knowledge/updates` → `KnowledgeUpdate[]` · `POST /api/projects/:id/knowledge/refresh` (run now) |
| D | `server/lead/routes.ts` | `POST /api/projects/:id/lead` → the Lead chat (created once) · `GET /api/home` → `HomeProject[]` |

MCP tool registration points in `server/mcp/server.ts`: lane D adds `registerLeadTools(server, conversation)` from `server/lead/tools.ts` (a stub exists). UI: lane D owns `ProjectPage.tsx` and the layout; lane A provides `src/components/projects/ProjectRepos.tsx` (`<ProjectRepos project={project} />`), lane B `src/components/knowledge/KnowledgePanel.tsx` (`<KnowledgePanel project={project} />`), lane C `src/components/knowledge/KnowledgeUpdates.tsx` (`<KnowledgeUpdates project={project} />`), each a stub component in the contract.

## Lane A · Multi-repo projects (`server/projects/`, `server/tasks/worktree.ts`, task tools)

- `project_repos` table (project_id, name, kind, source, default_branch, folder_granted_at, position); migration: every existing project with a repo or folder gets one primary row (its current source; topic projects get none). `Project.repos` filled; `kind`/`source` mirror the primary.
- Checkout paths: the primary keeps today's place (`~/projects/<slug>`, or the folder itself). Other GitHub repos: `~/projects/<slug>.<name>` (a sibling, so nothing is ever nested inside another clone). Folder repos: the folder, with its own grant (same consent dialog).
- Tasks: in a project, `StartTaskRequest.repo` / the task tools' `repo` name one of the project's repos (by name; default the primary); the task's `TaskRepo` gets `repoName`, its folder and grant come from that repo. Mission control and landing keep working per task (A checks that overlaps compare tasks of the same repo only, and that landing merges into the right folder).
- Composer task mode and the New task flow get a repo picker when the project has more than one repo; mission cards show the repo name.
- `ProjectRepos` component: the list with add (GitHub `owner/name` or a Mac folder with consent), rename, set primary, remove (refused while a task holds a worktree in it).
- Tests `server/project-repos.test.ts`: migration of existing projects; add/remove; a task per repo gets its worktree in that repo and lands into that folder; overlaps per repo; folder grants per repo.

## Lane B · One knowledge base (`server/knowledge/`, `server/data/wiki.ts`, `server/memory/`)

- **Git storage for the wiki**, behind the same `wiki.*` API (`overview`, `list`, `outline`, `search`, `relevant`, `get`, `find`, `withTitle`, `create`, `update`, `delete`, `revisions`, `restore`, …) so the wiki tools, routes, keeper, Learn a repo and UI keep working.
  - A project's brain lives in the project's knowledge repo (`memory/projects/<slug>`, the same repo as its memory); every other brain (agent notebooks, shared brains) in `memory/brains/<brainId>`.
  - A page is a markdown file with front matter (`id`, `title`, `summary`, `parent`, `pinned`, `position`, `repo`). Overview → `pages/overview.md`; other pages `pages/<slug>.md`; a repo's docs under `repos/<name>/` (the page with `repo: <name>` and its subtree).
  - `wiki_pages` becomes an index rebuilt from the files (FTS unchanged); revisions come from git history (author in the commit trailer) plus the legacy table for older ones; restore writes the old content as a new commit. Writes go through module 10's per-repo queue, secret check and symlink-safe file writes.
  - Memory's entry index ignores `pages/` and `repos/` (documents aren't facts).
- **Migration** once per brain, logged and retried on failure; old tables kept as `*_legacy`. Page ids unchanged, so links, focus brains and conversation references keep working.
- **Learn a repo** for a project repo writes under that repo's head page (`repo: <name>`).
- **`KnowledgePanel`**: Facts (module 10's entries), Pages (the wiki tree, opening the existing page view), Repos (each repo's docs), History (one timeline for facts and pages, with Undo). Settings → Memory keeps "About you"; project repos there link to the panel.
- Tests `server/knowledge.test.ts`: migration of a seeded wiki (pages, nesting, pinned Overview, revisions) with ids kept; every `wiki.*` call on git; restore; secrets refused; memory ignores pages; a failed migration falls back to the database; the existing smoke and projects suites pass.

## Lane C · Auto-update (`server/knowledge/auto/`)

- **On land:** when a task's `landing` becomes `merged` or `pr`, a light-model job reads the task's diff (stat + patch, capped), its summary, and the repo's doc pages (outline + the pages the diff touches, by path/keyword), and returns JSON ops: `page_update {id, content, summary?}`, `page_create {parent, title, summary, content}`, `fact_add {text}`, `fact_update {id, text}` (≤ 8 ops). Validated (known ids, no secrets, the 60 % rule, page unchanged since read) and applied as one commit "Knowledge: after <task title>".
- **When a main branch moves:** every 6 hours (and `POST …/refresh`), per project repo: GitHub repos `git fetch` the base on the agent's computer; folder repos read the folder's base branch head on this Mac. New commits since the last recorded sha (per repo, in settings or a small table) → the same job over `git log` + diff stat of the range (capped), one commit "Knowledge: <repo> moved to <sha7>".
- **After chats and tasks:** the wiki keeper already folds quiet chats into pages; make it write to the project knowledge (via `wiki.*`, which B moved to git) and skip chats whose project was updated by an on-land run for the same task.
- **Nightly Dreaming** (module 10) also reads the project's page summaries, so it doesn't keep facts that duplicate a page, and may move a long fact into the right page (`fact_to_page`).
- `KnowledgeUpdate` log (last 50 per project), `KnowledgeUpdates` component: "Updated after 'Fix cart' · 2 pages, 1 fact · Undo".
- Uses the keeper's light model (`defaultComplete`), never the user's chat model; failures back off and never block landing.
- Tests `server/knowledge-auto.test.ts` with a fake model: on-land ops applied and refused (unknown id, secret, shrink, user edit meanwhile); main-branch move detection for a folder repo and a bare-remote GitHub-style repo; one commit per run; undo.

## Lane D · Lead, one screen, Home (`server/lead/`, `src/components/projects/`, Home)

- **The Lead chat:** `POST /api/projects/:id/lead` creates (once) a pinned chat in the project with the project's agent (or the selected one), `lead: true`, titled "Lead". Its system prompt: the orchestrator role, the project's repos, the knowledge, how to split work one task per repo, to verify before proposing landing, and that landing needs the user's OK.
- **Lead tools** (`server/lead/tools.ts`, only in Lead chats):
  - `mission_overview {}`: the project's board as text (needs you, working, ready to land with checks and overlaps, land order).
  - `task_land {task_id, method?, reason}`: shows an approval card ("Merge 'Fix cart' into main? · +14 −1 · checks passing") via `askUser`; on yes calls the landing API with the reviewed `headSha`; on no or timeout lands nothing.
  - `task_update_from_base {task_id}`, `task_discard {task_id, reason}` (discard also asks).
  - The existing `task_*` tools work across the project's tasks for the Lead (status, message), not only its own children.
- **Wakes:** the Lead is woken (batched) when any task in its project finishes or needs input, not only the ones it started.
- **One screen:** the project page becomes the Lead chat in the middle and a right panel with tabs **Board** (the project's mission control, compact) · **Knowledge** (`KnowledgePanel` + `KnowledgeUpdates`) · **Repos** (`ProjectRepos`). The current project page content (other chats, memory row) moves into those tabs or a "Chats" list. Phone: tabs above the chat.
- **Home** (`GET /api/home`, the agent home when no chat is open, and a "Projects" view): each project as a row: needs you · working · ready to land, last activity, **Open Lead**.
- Tests `server/lead.test.ts`: the Lead is created once; its tools see all project tasks; `task_land` with a yes lands (fake approval) and with a no doesn't; wakes for any project task; home counts.

## Milestones

- [ ] **M0 · Contract** (lead).
- [ ] **M1 · Multi-repo projects** (A).
- [ ] **M2 · One knowledge base** (B).
- [ ] **M3 · Auto-update** (C).
- [ ] **M4 · Lead, one screen, Home** (D).
- [ ] **M5 · Merge, review, live run** (lead): a two-repo project, the Lead plans and runs a cross-repo change as two tasks, lands both with approvals, the knowledge updates after landing; screenshots light and dark.

## Out of scope

- One task spanning several repos (later, if needed).
- Syncing project knowledge between devices; team sharing.
- Moving "About you" into project knowledge (it stays its own repo).
