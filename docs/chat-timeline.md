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

## Grouped tool calls

Two or more finished tool calls in a row, with any thinking between them, show as one quiet line that says what they
did ("Read 4 files, ran 2 commands, edited 3 files"; a file read twice counts once) and opens to each call
(`apps/web/src/lib/toolGroups.ts`, `components/ToolGroup.tsx`). Anything the user should see stays out of a group and
ends it: a running, failed or interrupted call, an approval card, a screenshot, a shared link, the memory and wiki
pills, text, and a note the user sent mid-turn.

## Folded turns

From a chat's third reply on, every finished turn but the latest folds its work before the answer into one line
("Worked for 2m 12s" when the turn has one fold and its duration is known, otherwise what it did), so older answers
read one after another (`foldedRows` in `lib/toolGroups.ts`, `components/FoldedWork.tsx`). Everything from the turn's
first thought or call to its last (approvals and the text between them included) folds; text before and after stays,
and task cards, notices, screenshots, shared links and the user's mid-turn notes stay in place, splitting the fold.
Opening it shows the work with its tool calls grouped; nothing inside renders until then, which keeps long chats light.
The latest reply (not a notice posted after it) stays open, and the list's batched, newest-first rendering is unchanged.

## Changed files per turn

A turn that changed files in the chat's workspace ends with a compact line, "3 files changed +42 −7", that opens to the
files with their +/− counts, each opening to its unified diff (`components/TurnChanges.tsx`, reusing the task Changes
tab's list, now `components/tasks/ChangedFiles.tsx`). At the end of a turn that was checkpointed, the workspace is
snapshotted again onto `refs/tot/checkpoints/<chat>/<reply>-end` and diffed against the turn's start (`git diff
--numstat -M`, new files included); the counts go on the reply (`Message.changes`, kept in its meta column) and arrive
with its `run-end` event, so the line costs nothing to show. A turn that only looked changes nothing and keeps no end
ref. The files and diff load when the line is opened: `GET /api/conversations/:id/messages/:messageId/changes`
(`TurnDiff`, patch cut at 200 kB). The line stays visible in folded turns.

## Quote a selection

Selecting text inside one reply shows a small floating **Quote** button over it (below it when there's no room above);
clicking puts the selection into the message box as a markdown quote (`> …`, blank lines kept inside it) followed by a
blank line with the cursor (`components/QuoteSelection.tsx`, one listener per message list). Text goes to the composer
through `lib/composerInbox.ts`, the same small hand-off a rewound message uses, so the composer only adds one hook
(`hooks/useComposerInbox.ts`).
