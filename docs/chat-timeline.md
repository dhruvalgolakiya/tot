# The chat timeline

How a chat's messages read and what can be done with them, beyond sending the next one.

## Rewind to a message

A user message's "…" menu (on hover) has **Rewind to here**. It asks first, then removes that message and everything
after it, and puts the message's text, attachments and attached chats back into the message box to edit and send
again. It's refused while a reply is running, and tasks can't be rewound (their chat can).

- **The agent forgets the removed turns.** The next turn continues a copy of the provider session cut after the reply
  the chat now ends with, as a fork's first turn does (Claude: `resume` + `forkSession` + `resumeSessionAt`; Codex:
  `thread/fork` with `lastTurnId`). When that reply came from another account or provider, or has no ref to cut at, the
  next turn starts a fresh session seeded with what's left of the chat. Rewinding to the first message starts the
  chat over. The point it resumes from is kept in `chat_rewinds`.
- **Files, for chats with a workspace** (their project's main checkout, or a worktree of their own). Before a turn's
  first change (its first `computer_exec` or `computer_write_file`), `server/chats/checkpoints.ts` snapshots the working
  tree into a commit on a private ref, `refs/tot/checkpoints/<chat>/<reply>`, through a temporary index (`git add -A`,
  `write-tree`, `commit-tree`), so the checkout's index, branch and stash are untouched. New files are in it, ignored
  ones aren't; a tree with more than 20,000 new files isn't snapshotted. In a folder on this Mac TOT's server runs this
  git itself (the agent's sandbox may not write those refs); a clone's runs on the agent's computer.
- **Putting the files back** is an option in the confirm dialog when one of the removed turns has a checkpoint. The
  working tree goes back to the oldest of them (new files removed, changed and deleted ones back, ignored ones kept),
  and the branch moves back over commits made since. It's refused, and nothing is removed, when the checkout is on
  other commits than it was then. What was there before the rewind is kept on `refs/tot/checkpoints/<chat>/before-rewind`.
- Removed turns' refs are dropped (only when the computer is running or the folder is on this Mac), and deleting the
  chat drops all of its refs.

API: `GET /api/conversations/:id/rewind?messageId=` (`RewindPreview`) and `POST /api/conversations/:id/rewind`
(`RewindRequest` → `RewindResponse`). Tests: `apps/server/rewind.test.ts`.
