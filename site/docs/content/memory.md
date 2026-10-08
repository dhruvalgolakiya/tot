Memory is what your agents keep in mind between chats: short facts, one per line. "Prefers pnpm over npm." "Tests need `TZ=UTC`." Agents save them as they go, and read them at the start of every chat.

**Why you'd use it:** you shouldn't have to repeat yourself. Tell one agent once, and every agent knows.

Memory is for short facts. A project's longer notes, and each of its repos' own docs, live beside it: see [Project knowledge](#project-knowledge) below.

## Two kinds of memory

- **About you**: what you've told any agent. Shared by every agent, in every chat.
- **Per project**: what agents learned working on a project. Every chat and task in that project reads and writes it, on every branch.

Agents choose where a fact goes: facts about you go to **About you**; facts about the code or the project go to the project.

## Plain files, with history

Your memory is a git repo of markdown files: a folder with a full history, like code. It follows the open [Agent Memory Repo](https://github.com/AgentMemoryRepo/agentmemoryrepo) format.

- **About you** lives in `~/.tot/memory/you`, and each project's in `~/.tot/memory/projects/<name>` — the same repo as that project's wiki, see below.
- `MEMORY.md` is the front page, loaded in every chat. When it grows long, the rest moves to other files it links to.
- Every change is a commit: who changed what, and when. Many tasks can save at once without losing anything.
- Because it's plain files, other coding agents can read it too. Claude Code, Codex and Cursor can use it with:

```bash
npx skills add AgentMemoryRepo/agentmemoryrepo --skill agent-memory-repo
```

## See and edit About you

Open **Settings → Memory**.

1. **Entries**: every fact, grouped by file, under the text of `MEMORY.md`. Search them, press **Add memory** to add one, or hover an entry to edit or delete it.
2. **History**: every change, newest first. **Undo** puts back what one change did, as a new change.
3. **Dreaming**: see below.
4. **Sync**: your paired devices and an optional backup.

A project's own memory is its **Facts** on the Knowledge page instead; see below. To stop agents saving or recalling anything, turn off **Memory** in **Settings → General**.

## Project knowledge

A project's memory and its pages are one git repo: `MEMORY.md` for facts, `pages/` for pages, and `repos/<name>/` for each of the project's repos' own docs. Open the project's **…** menu → **Knowledge** (or pick the project in the switcher on any Knowledge page). The column on the left has:

- **Facts**: the project's memory, loaded in every chat. Type one in the field and press Enter; hover one to edit or delete it.
- **Pages**: the longer notes and documents an agent writes up. Open one to read, edit or ask about it; its **…** menu has **History** too.
- **Repos**: each repo's own docs, written by **Learn this repo** in the project's [Repos](/docs/projects#more-than-one-repo).
- **History**: the updates TOT made (below), then every change to facts and pages, each with **Undo**.

This replaced the separate wiki and project memory. The move happens once, the first time TOT starts after the update, and keeps everything: old wiki pages keep their links and ids, and the old copy is kept as a backup. If it ever fails for one, that one keeps working from the database and TOT tries again next start.

### It keeps itself up to date

TOT updates a project's docs and facts by itself, using a light background model, never your chat model:

- **After a task lands** (merged, or a draft PR opened).
- **When a repo's main branch moves** — checked every 6 hours, or press **Check now** in **History**.
- **From chats**, the same way the wiki keeper always has.
- **In nightly Dreaming** (see below), which may move a long fact into the right page.

Each run is one change, named like "Updated after 'Fix cart'", that you can **Undo**. It never stores a secret, never shrinks a page by more than 60%, and leaves alone a page you edited yourself since it last read it.

## Dreaming

While you sleep, TOT tidies your memory. It merges duplicates, drops stale entries and settles contradictions, using a light model. Each night is one change you can **Undo**.

- It runs at 03:30 by default, on this computer's time. Change it with **At**, or turn off **Dream every night**.
- It only dreams when memory changed, or you chatted, since the last dream.
- **Dream now** runs it straight away.
- It never removes more than 40% of your entries in one go, and never writes a secret.

## Sync between your devices

When you pair your Macs (see [Use it from your phone and other computers](/docs/devices)), **About you** follows you to them. No GitHub needed: your devices sync with each other every 10 minutes, and soon after a change. If both sides edited the same line, both versions are kept, and Dreaming tidies them later.

**Optional backup.** Turn on **Back up to a git remote** and give it the address of a private repo you made. TOT pulls and pushes it after changes, with this computer's SSH keys. It's off by default; turn it on on one device only.

## Secrets are refused

Memory, and a project's wiki pages, never store passwords, tokens or keys. A save that looks like one is refused: "That looks like a secret; memory never stores secrets." This holds for agents, for Dreaming, for the auto-updates above, and for anything you add yourself.

## Limits

- A project's knowledge (its memory and its wiki) stays on the computer it's on. Only **About you** syncs.
- Memory is yours alone: there's no sharing it with other people.
- An undo that collides with later edits is refused, rather than guessing. The very first change can't be undone, and neither can a sync.
