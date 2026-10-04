# 06 · Projects: agent → project → chat

**Lane:** worktree D, branch `feat/projects`, created from `main`. **Depends on:** 01 (tasks, branches, worktrees). Shows 03's repo profile on the project page when there is one. **Overlaps with 04** in `server/tasks/worktree.ts`: 06 was built first, so 04 builds on `inFolder` and the folder grant.

Read [README.md](README.md) first.

## Goal

Today every agent has one flat list of chats, its own clones in `~/repos`, and no way to work on a folder on your Mac. That's fine for one repo and falls apart with three. This module adds **projects**: the things you work on, shared by all your agents.

The bar for every decision below: **a new user and a model should both understand it on first sight.** When a choice adds power but also a concept, leave it out.

## The whole model in three words

| Word | What it is | Example |
|------|-----------|---------|
| **Agent** | *Who* does the work: a mascot, a personality, a computer, a notebook. | Tot, Puddin |
| **Project** | *What* you're working on: a GitHub repo, a folder on your Mac, or just a topic. Has a brain (wiki) and instructions. Any agent can work in any project. | `web` (acme/web), `meet-notes` (~/playground/meet-notes), `Q4 launch` |
| **Chat / task** | One conversation, or one background job. Belongs to **one project or none**. | "Fix the flaky checkout test" |

Knowledge follows the same three levels, and nothing else:

- **About you:** memory, shared by all agents. This is today's memory.
- **About the agent:** its notebook brain. This is today's notebook.
- **About the project:** the project's brain and instructions.

## Rules that keep it simple

**For the user**

1. A chat is in one project or in none. There's nothing else to file or tag.
2. Projects aren't owned by an agent. Pick an agent, pick a project, talk.
3. **Your files are never changed in place.** Code changes happen on `tot/*` branches. For a folder on your Mac, those branches show up in your own repo (`git branch`), and you check one out when you want it.
4. Everything about a project lives on its page: chats, tasks, instructions, brain and settings.
5. TOT never moves a chat out of a project, and never files one silently. When an agent files a chat, a notice says so and **Move** undoes it.

**For the agent**

1. Every chat in a project gets one short **Project** section in its prompt, always in the same shape (below).
2. The project's files are at one path, always the same on every computer.
3. One rule for changes: **look in the project folder; change code in a task.** Each task gets its own branch and checkout.
4. Inside a project, `task_start` needs no `repo`: it uses the project's.
5. When it's not clear which project a request is about, ask; don't guess.

The prompt section, exactly as an agent sees it (code project):

```
## Project: web
GitHub acme/web · base branch main · files at ~/projects/web
Instructions: Use pnpm. Never touch billing/ without asking.
Brain: "web" (Overview pinned below; search it with wiki_search).
Look in ~/projects/web, but don't change it: start a task for any change.
Each task gets its own branch (tot/…) and folder.
```

Topic project:

```
## Project: Q4 launch
No code. Shared files at ~/projects/q4-launch (drafts, notes, exports); edit them freely.
Instructions: Audience is existing customers. Launch date is Nov 12.
Brain: "Q4 launch".
```

## Today (what this builds on)

- **Computers:** one per agent.
  - **Local:** a folder at `~/.tot/computers/<agentId>/`, sandboxed by Seatbelt (`server/computer/local.ts`, `profile()`). It may write only inside that folder, and it may not read your home folder.
  - **Boat:** a cloud VM, with home at `/home/user` (`server/computer/boat.ts`).
- **Repos:** cloned to `~/repos/<name>` by Learn a repo (`server/agent/learn-repo.ts`) or by a task's first run (`server/tasks/worktree.ts`).
- **Tasks:** each one checks out `tot/<slug>-<hex>` in `<repo>/.tot-worktrees/<branch>`. Nothing is pushed.
- **Brains:**
  - Kinds are `notebook`, `repo` and `notes` (`server/data/brains.ts`).
  - Shared brains are attached to agents, or to all of them.
  - A repo brain's `source` is the URL or folder it was learned from.
- **Origins:** `Conversation.origin` already records Slack threads and emails (`shared/types.ts`, `ConversationOrigin`). Slack picks the agent with `pickAgent` (`server/slack.ts`).
- **Tickets from Linear** reach an agent only when the user pastes them, through the apps tools (Executor).
- **The sidebar** shows the selected agent's chats by date, with tasks nested under their chats (`src/components/ConversationList.tsx`).

## Concepts

- **Project kinds.** There are three, and the user picks one when creating a project:
  - **GitHub repo** (`github`): `owner/name`. Cloned on each computer that works on it.
  - **Folder on this Mac** (`folder`): an absolute path, used in place, with your consent.
  - **No files** (`none`): a topic. Its folder on each computer holds shared drafts.
- **The project folder.**
  - **GitHub and topic projects:** `~/projects/<slug>` on the agent's computer.
  - **Folder projects:** the real path on your Mac.
  - One computer per agent means each agent has its own clone of a GitHub project, like teammates on their own laptops. The brain, instructions and settings are shared; the clones aren't.
  - TOT keeps every clone set up the same way: same source, same base branch, base fetched before each task.
- **Folder consent.**
  - Adding a folder project asks once, in plain words, and the grant lives on the project.
  - A local computer can see the folder **only while it's working in that project**: the sandbox is widened per command, from the chat's project.
  - What the sandbox allows:
    - reading the whole folder;
    - writing only to `<folder>/.git` (git needs it for branches and commits) and `<folder>/.tot-worktrees/`.
  - Your checked-out files stay untouched, and the sandbox enforces it, not just the prompt.
  - Folders without git are read-only in v1.
- **Origin (ticket).** `ConversationOrigin` gains `linear` and `github` kinds, and a `key` (`ENG-123`, `acme/web#42`).
  - **Set automatically** when a chat starts from Slack or email (as today), or when the first message contains a Linear or GitHub issue link.
  - **Set by the agent** with `ticket_link`, when it finds the ticket another way.
  - A task started from a chat with an origin names its branch after the key: `tot/eng-123-fix-checkout-3f2a`. 04's PR description links the ticket.
- **Intake.** A project can list where its work comes from: Slack channels (`#web-bugs`) and Linear teams (`ENG`). GitHub issues of its own repo always count.
  - A ticket from a listed place starts its chat in that project, when it's the only project that takes it. Only intake counts: a project's name in the text doesn't.
  - Everything else starts with no project, and the agent can file it (rule 5 above).

## Data model

```sql
-- module 06
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,          -- folder name: ~/projects/<slug>
  kind TEXT NOT NULL,                 -- 'github' | 'folder' | 'none'
  source TEXT,                        -- 'owner/name' | absolute path | NULL
  default_branch TEXT,                -- NULL: the repo's own default
  instructions TEXT NOT NULL DEFAULT '',
  brain_id TEXT NOT NULL,             -- its wiki (kind 'repo' for code, 'notes' for topics)
  intake TEXT NOT NULL DEFAULT '{}',  -- JSON: { slackChannels: string[], linearTeams: string[] }
  folder_granted_at INTEGER,          -- folder projects: when the user said yes
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
-- conversations: + project_id TEXT (NULL = no project), indexed with agent_id
```

Types go at the end of `shared/types.ts`:

```ts
export type ProjectKind = "github" | "folder" | "none";
export interface Project {
  id: string;
  name: string;
  slug: string;
  kind: ProjectKind;
  source: string | null;
  defaultBranch: string | null;
  instructions: string;
  brainId: string;
  intake: { slackChannels: string[]; linearTeams: string[] };
  folderGranted: boolean;
  /** Counts for the sidebar and project page. */
  chats: number;
  running: number;
}
// Conversation: + projectId: string | null
// ConversationOrigin.kind: + "linear" | "github"; + key: string | null
```

## Server design (`server/projects/`)

- **`projects.ts`:** the data layer.
  - Create, update and archive projects.
  - `forChat(id)`.
  - Creating a project makes its brain: `repo` for code projects, `notes` for topics. The brain is attached to all agents.
- **`checkout.ts`:**
  - **`ensure(agentId, project)`:** puts the project folder on that agent's computer.
    - Clones GitHub projects to `~/projects/<slug>` with the agent's git login.
    - Creates the empty folder for topic projects.
    - Checks that a folder project still exists and is a git repo.
  - **Replaces `repoFolder()` in `server/tasks/worktree.ts`.** Inside a project, a task's repo is always the project. Outside one, `repo` works as today, cloning into `~/repos`.
  - **Migration:** an existing `~/repos/<name>` moves to `~/projects/<slug>` the first time that computer is used, leaving a symlink behind so old tasks and wiki pages keep working.
- **`folders.ts`:** folder grants. Every grant and every sandboxed command resolves the real path, and rejects:
  - anything outside your home folder, and your home folder itself;
  - `~/.tot`, `~/Library`, and dot-folders at the top of home (`~/.ssh`, `~/.config`, …);
  - symlinks that lead outside the folder.

  It also has `recentGitFolders()`, which checks `~/code`, `~/projects`, `~/playground`, `~/dev`, `~/src` and `~/Documents/GitHub` one level deep, for the picker.
- **`server/computer/local.ts`:** `profile(workspace, grant?)` takes an optional folder grant, and `exec(externalId, command, { cwd, timeoutMs, grant })` passes it through.
  - `computer_exec` (`server/mcp/server.ts`) and `worktree.ts` pass the grant of the conversation's folder project, and nothing for any other conversation.
  - On a Boat computer, folder projects can't run (M5).
- **`tickets.ts`:** `detectTicket(text)` finds Linear and GitHub issue (or PR) URLs, and bare Linear keys of a team some project takes, and returns `{ kind, key, url, label }` (the label is the key: a title isn't known).
- **`intake.ts`:** `intake.match(work)` finds the projects a piece of work belongs to, **by intake only**: a Slack channel the project lists, a ticket from a Linear team it lists, or an issue or PR of its own GitHub repo. A project's name or slug in the text doesn't count: "web" is too common a word. A chat is filed only when exactly one project matches.
- **Prompt:** `projectSection(project)` in `server/agent/prompts.ts`, placed before the brains section. Its shape is shown under "Rules" above.
  - The project's brain is pinned.
  - The project list (name and one line each, at most 20) is added only to project-less chats, so the agent can file one.
- **Tools:**
  - `task_start` / `task_spawn_many`: `repo` becomes optional and is ignored inside a project.
  - New `chat_set_project { project }`: works only on a chat that has no project, and posts the "Filed under *web*" notice.
  - New `ticket_link { url }`.
- **Intake:**
  - `server/slack.ts` and `server/mail/tasks.ts` call `intake.match()` for a new chat's channel or text, and set `project_id`. Agent selection stays as it is (`pickAgent`).
  - A Linear or GitHub link in a new chat's first message sets the origin, and the project too when exactly one project matches.
- **Routes** (`server/projects/routes.ts`, mounted with one `api.route` line):
  - `GET /api/projects`; `POST /api/projects { kind, source?, name? }`; `PATCH /api/projects/:id`; `DELETE /api/projects/:id` (archives it).
  - `GET /api/projects/folders/recent`; `POST /api/projects/:id/grant`.
  - `PATCH /api/conversations/:id { projectId }` (Move).
  - `POST /api/projects/:id/learn` runs Learn a repo into the project's brain.

## UI

**Sidebar (the selected agent's panel).** Projects sit above the chats. Each project row expands to show **this agent's** chats in it. The **Chats** list below holds the chats that have no project.

```
 Tot ▾
 ✎ New chat
 ⌕ Search chats

 Projects
 ▸ web                   ●2      ← tasks running
 ▾ meet-notes
     Fix the reminder bug
     Why is STT slow?
 ▸ Q4 launch
 + New project

 Chats
 Today
   Plan my week
   Morning AI brief
```

**Project page:** clicking a project's name opens it.

```
 web                                         GitHub acme/web · main     …
 ┌──────────────────────────────────────────────────────────────────┐
 │ New chat in web…                                         ↑       │
 └──────────────────────────────────────────────────────────────────┘
 Chats and tasks
  (Tot)    Fix the flaky checkout test     ENG-123   ● Running   3m
  (Puddin) Review the billing refactor               Done        2h
  (Tot)    Why is staging slow?                                  Mon
```

- The list shows **every agent's** chats in the project, each with its mascot. This is the one place to see everything going on in a project.
- A new chat starts with the agent selected in the rail.
- The "…" menu holds Instructions, Brain, Learn this project, Settings (source, base branch, intake) and Archive. There are no other buttons.

**New project:** one dialog, one question.

```
 New project
 What are you working on?
 ( ) A GitHub repo        [ acme/web           ▾ ]   ← your repos when GitHub is connected; or type owner/name
 ( ) A folder on this Mac [ ~/playground/meet-notes ] Recent: meet-notes · abyss · tot
 ( ) Something else       (no files: a topic, a client, a launch)
 Name  [ web ]                                        ← filled in for you
 [x] Learn it now (builds the project's brain)        ← repos and folders only
                                      [ Cancel ]  [ Create ]
```

**Folder consent:** shown once, when a folder is picked.

```
 Let agents work in ~/playground/meet-notes?
 They can read everything in this folder and make branches (tot/…)
 in its git repo. They can't change your checked-out files, push,
 or see anything outside this folder.
                                   [ Cancel ]  [ Allow ]
```

**Elsewhere:**

- **Chat header:** "web › Fix the flaky checkout test", plus a ticket chip ("ENG-123 ↗") when the chat has an origin.
- **Chat "…" menu:** gains "Move to project…".
- **Task card:** its branch line already shows the branch, which now includes the ticket key.
- **Notices:**
  - "Filed under *web*", with **Move**.
  - "This folder needs a local computer" when a Boat agent opens a folder project (until M5).

## Milestones

- [x] **M1 · Projects and chats in them.**
  - What to build: the table, `projects.ts`, the routes, `conversations.project_id`, the sidebar section, the project page, New project (all three kinds; folder projects can be created but not opened until M3), Move to project, `projectSection`, and `task_start` defaulting to the project. Existing repo brains become GitHub projects; existing chats stay project-less.
  - *Accept:*
    - Creating `acme/web` makes one project and one brain.
    - A chat in it gets the Project section, word for word as above.
    - `task_start` without `repo` uses `acme/web`.
    - Moving a chat updates both the sidebar and the project page.
    - Tot's and Puddin's chats in the same project both show on its page.
  - *Shipped:* `server/projects/` (`projects.ts`, `prompt.ts`, `routes.ts`), `conversations.project_id` (tasks and forks follow their chat), the `# Project:` prompt section with a one-time note when a chat moves or its project changes, `task_start` defaulting to the project's repo and base branch, repo brains migrated at startup (`server/projects.test.ts`); UI in `src/components/projects/` (sidebar section, project page, new project and consent dialogs, Move to project, breadcrumb and ticket chip).
- [x] **M2 · One folder per project.**
  - What to build: `checkout.ts`, `~/projects/<slug>` clones, worktrees under them, the `~/repos` migration with symlinks, and topic-project folders.
  - *Accept:*
    - Two tasks in `web` on one computer use `~/projects/web/.tot-worktrees/…` side by side.
    - An old task whose repo was `~/repos/web` still finds its worktree through the symlink.
    - A topic project's chat can write to `~/projects/q4-launch`.
  - *Shipped:* `server/projects/checkout.ts` (`ensure` clones GitHub projects to `~/projects/<slug>`, makes topic folders, checks and prepares folder projects; `prepareTask` before every task's worktree), worktrees under the project folder (`inFolder` in `worktree.ts`), the once-per-run `~/repos` → `~/projects` move with a symlink left behind (only a clone whose origin is the project's repo), project brain cards and Learn a repo pointing at the project folder.
- [x] **M3 · Folders on this Mac.**
  - What to build: the folder picker with recent git folders, the consent dialog, the grant, `folders.ts` validation, and the per-command sandbox grant in `local.ts`.
  - *Accept, against a temp git repo under a temp home:*
    - A task's branch appears in that repo's `git branch`.
    - Writing to a tracked file in the folder from `computer_exec` fails.
    - A chat in another project can't read the folder.
    - `~`, `~/.ssh` and a symlink pointing outside are all refused.
    - A non-git folder is readable but no task can start in it.
  - *Shipped:* `server/projects/folders.ts` (real-path validation, checked again before every sandboxed command; `recentGitFolders`), `GET /api/projects/folders/recent`, `POST /api/projects/:id/grant` and `grant: true` on create, and the per-command folder grant in `local.ts`: chats read the folder; a task also writes only its own worktree, branch, reflog, worktree metadata and new git objects (never the checked-out files, `.git/config`, hooks, info or other refs). Boat agents get "needs a local computer". The folder picker and consent dialog are in the UI (`src/components/projects/`).
- [x] **M4 · Tickets and intake.**
  - What to build: `ConversationOrigin` `linear`/`github` with `key`, `detectTicket`, `ticket_link`, branch names with the key, intake settings, Slack and email routing through `intake.match`, `chat_set_project`, and its notice.
  - *Accept, with fakes:*
    - A Slack mention in `#web-bugs` starts its chat in `web`.
    - A first message with `https://linear.app/acme/issue/ENG-123/…` sets the chip and the project, and the task branch starts `tot/eng-123-`.
    - A project-less chat filed by the agent shows the notice, and Move puts it back.
    - The agent can't move a chat that already has a project.
  - *Shipped:* `tickets.ts` and `intake.ts` (Slack channels, Linear teams and a GitHub project's own issues; filed only when exactly one project matches, with a "Filed under" notice), ticket origins from a first message's link or `ticket_link`, branches named after the key, `chat_set_project`, and the project list in project-less chats (`server/projects-tickets.test.ts`).
- [ ] **M5 · Folder projects on cloud computers** (later).
  - The folder goes to the VM as a `git bundle`, and each finished task's branch comes back the same way, fetched into your repo as `tot/*`. Same promise: your files are untouched, and branches appear in your repo.
  - *Accept:* a Boat agent's task in a folder project ends with its branch in the local repo.

## Tests

Add `server/projects.test.ts` to `npm test`, with `TOT_DATA_DIR=$(mktemp -d)`. Use fake senders (as in `server/tasks.test.ts`), the fake GitHub server, and temp git repos, under a temp `HOME` for the folder tests.

- Every M1–M4 *Accept* line.
- `folders.ts` refusals: home itself, dot-folders, `~/.tot`, symlink escapes, and paths with `..`.
- The sandbox profile with and without a grant: a real `sandbox-exec` run on macOS, skipped elsewhere.
- Migration is idempotent: running it twice leaves one folder and one symlink.

## Out of scope

- Projects owned by one agent, or hidden from some agents.
- Sub-projects, or a chat in two projects.
- Pushing, PRs and merging: that's 04. Projects only decide *where*.
- Syncing your local folder's uncommitted changes to anyone.

## Open questions

- **The `.git` write grant.** Agents can write `.git` in a granted folder, so a careless command could move one of your branches. Options:
  - accept it, since tasks only ever touch `tot/*`, and add a gate that fails a task which changed a non-`tot/*` ref;
  - or run git through a TOT helper that refuses those writes.
- **Topic projects and the computer.** Should a topic project's shared files live in its brain (wiki attachments), so every agent sees the same copy, rather than a folder on each computer?
- **Filing chats.** Should "file this chat" ever happen without the agent, e.g. when the first message names exactly one project? M4 says yes for ticket links only.
