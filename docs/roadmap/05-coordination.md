# 05 · Coordination: wake-ups, safe context, retries, forks

**Lane:** worktree C, branch `feat/coordination`, created from `main`. **Depends on:** 01 and 02, both merged. Touches `server/tasks/`, `server/orchestration/` and `server/agent/orchestrator.ts`, so build it in **one worktree**; splitting it would mostly produce merge conflicts.

Read [README.md](README.md) first.

## Goal

01 and 02 let a chat start tasks on either provider and pass work between them. This module makes that work smoothly without the user nudging it:

- **A chat hears back when its tasks finish.** Today it only finds out on the user's next message.
- **Switching provider mid-chat never overflows the new model.** Today the whole transcript is pasted in.
- **Retried tool calls never start the same task twice.**
- **Nothing ends silently.** Restarts, stops and a failing provider are always reported back.
- **The agent can wait for a quick task** instead of ending its turn.
- **The user can fork a chat, bring the fork's findings back, and attach another chat as context.**

## Today (what this builds on)

- **Results reach a chat on its next turn only.**
  - When a task finishes, `reportToParent` (`server/tasks/tasks.ts:148`) posts a notice in the parent chat and adds the task to `childResults`.
  - The chat's model reads that list at the start of its *next* turn (`childResultsNote`, `server/tasks/prompt.ts:103`, called at `server/agent/orchestrator.ts:369`), which also clears it.
  - Only groups started with `then: "synthesize"` wake the chat by themselves (`server/orchestration/fanin.ts`). A task that started tasks already waits for them (`waitForChildren`, `server/tasks/run-loop.ts`).
- **Only tasks can be steered.** `onSteerable` is passed for `kind === "task"` only (`server/agent/orchestrator.ts:273`). A chat with a turn running answers 409 (`orchestrator.ts:103`).
- **Provider switch in a chat pastes everything.** When a chat's next turn runs on a different provider, `withTranscript()` (`orchestrator.ts:248`) sends every earlier message through `transcriptPreamble` (`server/agent/prompts.ts:290`), with no size limit. Long chats can fail with "too long for the model's context window" (`server/agent/providers/chatgpt.ts:544`).
- **`chat_read`** (`server/mcp/server.ts:393`) returns a whole transcript in one go, and refuses the current chat.
- **No retry keys.** `task_start` / `task_spawn_many` (`server/tasks/tools.ts:78`, `:96`) start new tasks on every call.
- **Only done and failed tasks report back.** `reportToParent` runs on `done` and `failed` only (`tasks.ts:390`), so a `stopped` task, or an `interrupted` one that won't resume, never tells its chat.
- **Cut-off chat replies are marked silently.** On startup, a chat reply cut off by a restart becomes `stopped` (`server/db.ts:388`), and nothing tells the model. Tasks do get told (`server/tasks/prompt.ts:66`).
- **The queue keeps starting tasks on a provider that's down.** It starts tasks whenever a slot is free (`server/tasks/queue.ts:56`), so every queued task fails the same way in turn. Usage limits are already handled by `failover.ts`.
- **Tool-call timeouts:** TOT's MCP server gets 11 minutes on Claude (`claude.ts:21`) and 620 s on ChatGPT (`chatgpt.ts:34`).
- **Native forks exist in both providers:**
  - Claude Agent SDK 0.3.284: `resume` + `forkSession: true`, and `resumeSessionAt` to fork from an earlier turn.
  - Codex app-server 0.160: `thread/fork { threadId, lastTurnId? }`, and `thread/inject_items` to add history items.

## Concepts

- **Unread results.** `childResults` on a chat becomes the durable list of its tasks' results that its model hasn't seen. Three things mark a result read:
  - the chat's next turn reading it (as today);
  - a wake turn;
  - the agent calling `task_status` on that task.
- **Wake.** A short message TOT writes to a chat when it has unread results:
  - It is **steered** into the running turn when the provider can take input mid-turn.
  - Otherwise it **waits** until the turn ends, then becomes **one auto turn**.
  - A wake never interrupts or restarts a turn.
- **Context selection.** One function decides which earlier messages a model gets when it can't resume its own session. Used for a provider switch, a fork that can't fork natively, merge-back and attached chats:
  - It always keeps the latest user message, the latest reply and the first user message.
  - It then adds messages from newest to oldest until the budget is used.
  - It adds whole messages only, never cut, and keeps them in their original order.
  - It ends with how many messages were left out, and the chat id to read them with `chat_read`.
- **Request id.** An optional key the agent passes to `task_start` / `task_spawn_many`. The same key from the same chat always means the same tasks.
- **Queue hold.** An agent's queue stops starting tasks after one fails because its provider kept erroring. It starts again when the user resumes it.

## Server design

- **`server/tasks/wake.ts` (new).**
  - **Trigger.** When a task whose parent is a chat (`kind === "chat"`) reaches `done`, `failed`, `stopped`, or `interrupted` without resuming:
    - mark the chat `wakePending` (a new column);
    - skip tasks in a `then: "synthesize"` group, because `fanin.ts` owns those;
    - skip everything when Settings → Tasks → "Tell the chat when its tasks finish" is off (default on).
  - **Batching.** Wait 3 s after the last result, so tasks finishing together give one wake. Allow at most one wake in flight per chat. Results arriving during a wake turn get exactly one follow-up wake when it ends.
  - **Steer.** Pass `onSteerable` for chats too (`orchestrator.ts:273`). If the chat has a turn running and `run.steer` delivers the note, mark those results read; that's the whole wake.
  - **Otherwise:**
    - wait for the run to end (`runRegistry`, `runEnd`);
    - if results are still unread, send one auto turn with `runLoop.send(chatId, …, { auto: true, keepTitle: true, preamble: childResultsNote(…) })`, the same call `fanin.ts` makes;
    - retry on 409 like `fanin.ts` does.
  - **The wake's text:** `2 tasks finished: “Fix checkout”, “Update docs”.` (one task: `“Fix checkout” finished.`). It renders as the quiet `auto` divider.
  - **Slack and email chats.** Deliver the wake turn's answer to the thread with `taskNotifications.deliver` (as `fanin.ts` does), and skip `notify.ts`'s own "task done" message for that task.
  - **Restart.** On startup, chats with `wakePending` and unread results get their wake. Only flag results after this ships, so old `childResults` don't wake every chat at once.
  - **Cost.** Wake turns count toward the mission's token budget (`server/orchestration/budget.ts`). Over budget, post the notice only.
- **`server/agent/context-select.ts` (new).**
  - `selectContext(messages, { budgetTokens, chatId })` returns the preamble text plus `{ included, omitted }`. Estimate tokens as characters / 4.
  - **Default budget:** 16k tokens for a provider switch, 4k for each attached chat.
  - **Uses:**
    - replace `withTranscript()`'s unbounded paste (`orchestrator.ts:248`) and `transcriptPreamble` (`prompts.ts:290`);
    - after a task's handoff packet (`handoffPreamble`, `server/tasks/prompt.ts:118`), also include the last user message and the last reply verbatim, within 4k tokens.
  - Short chats that fit go in whole, as today.
- **`chat_read` (`server/mcp/server.ts:393`).**
  - Add paging: `before` (a message id) and `limit` (default 20, max 50), with each message clipped to 4,000 characters and a "more before" hint.
  - Allow the **current** chat, so a model that got a selection can read what was left out.
  - Keep the agent scoping (`chatSearch.transcript(agentId, …)`).
- **Request ids.**
  - New table `task_requests (parent_id, request_id, idx, task_id, created_at, PRIMARY KEY (parent_id, request_id, idx))`.
  - `task_start` and `task_spawn_many` take an optional `request_id` (max 100 characters). A repeat returns the existing tasks and says "already started". `POST /api/conversations/:id/tasks` takes `requestId` too, against double clicks.
  - Tool descriptions say: "pass a `request_id` if you might retry this call".
- **Reporting every ending.**
  - Run `reportToParent` for `stopped`, and for `interrupted` when the task won't resume, with clear notices: "“X” was stopped." / "“X” was cut off when TOT restarted and is waiting for you to resume it."
  - `resultBlock` gives these a status with no result.
  - For chats: when startup marks a cut-off reply `stopped` (`server/db.ts:388`), also set `error: "Cut off when TOT restarted."`. The chat's next turn starts with one line: "TOT restarted during your last reply, so it was cut off. Check where things stand before you carry on." Say it once.
- **Queue hold (`server/tasks/queue.ts`).**
  - New table `queue_holds (agent_id PRIMARY KEY, provider, reason, created_at)`.
  - When a task fails with "Stopped after repeated errors" (`run-loop.ts`), and the errors weren't a usage limit, hold that agent's queue. `pump()` skips held agents.
  - `POST /api/agents/:id/queue/resume` clears the hold. A usage limit never holds the queue, since failover handles it.
- **Wait mode.**
  - `task_start` and `task_spawn_many` take `wait: true` and `wait_minutes` (1–10, default 5). The cap stays under the tool timeouts above.
  - The call returns when the task (all tasks, for spawn-many) finishes, with the result inline and marked read, so no wake follows.
  - On timeout it returns "still running; you'll hear when it finishes", and the wake covers the rest.
  - Stopping the parent turn ends the wait (the turn's abort signal).
- **Forks (`server/chats/fork.ts`, new).**
  - **Creating a fork:** `POST /api/conversations/:id/fork { messageId? }` creates a chat titled "Fork of X" with `forkedFrom: { conversationId, messageId }` (new column). It copies the messages up to that point, so the history shows. It starts no provider session.
  - **Remembering where to fork from:** store each assistant message's provider turn ref (new `provider_ref` column): Claude's message uuid, or Codex's turn id.
  - **Native fork, on the first turn when it's the same provider and the source has a session:**
    - Claude: `resume` + `forkSession: true` (+ `resumeSessionAt` for an earlier message);
    - Codex: `thread/fork { threadId, lastTurnId }`.
  - **Otherwise** use `selectContext` on the copied messages.
  - **Merge back:** `POST /api/conversations/:forkId/merge-back` posts a notice in the source chat and leaves a pending note for its next turn. The note is the fork's new messages since the fork point, one line each (clipped to 240 characters), plus the fork's latest reply in full, within 8k tokens, and "read more with `chat_read <forkId>`". A newer merge-back from the same fork replaces a pending one.
- **Attached chats.**
  - A user message can carry `contextChats: string[]` (message meta, max 3, same agent).
  - The turn's preamble gets, for each, its title, id and `selectContext` at 4k tokens. Mark it as reference material, not new instructions.
  - `chat_read` accepts those ids.

## UI

- **Wake turns** show as the existing quiet `auto` divider ("2 tasks finished"), followed by the agent's reply. There's no new card; the task cards already show each result.
- **Queue hold:** one line in the queue popover and the sidebar's task section, "Queue paused: Claude kept failing. **Resume**". Hovering shows the reason.
- **Forks:**
  - "Fork from here" in a reply's "…" menu; "Fork chat" in the chat's "…" menu.
  - A fork shows a small "Forked from *X*" link under its title, and "Bring back to *X*" in its "…" menu.
- **Attach a chat:** typing `@` in the composer opens a chat picker (title search). Picked chats show as chips above the input and on the sent message. Dragging a chat from the sidebar onto the composer does the same.
- **Settings → Tasks:** "Tell the chat when its tasks finish" (default on).

## Milestones

- [x] **M1 · Wake the chat.**
  - What to build: `wake.ts`, `onSteerable` for chats, the `wakePending` column, the setting, Slack/email delivery, the startup pass.
  - *Accept:*
    - With a fake sender, a chat starts 2 tasks and ends its turn. Both finish 1 s apart: exactly **one** wake turn follows, with both results.
    - With a turn running and steering available, the note is steered in and no extra turn follows.
    - If the agent called `task_status` on both first, no wake happens.
    - A wake pending at shutdown happens once after startup.
    - Never two wake turns at once.
  - *Shipped:* `server/tasks/wake.ts` (`chatWakes`) is flagged by `reportToParent`, batches results for 3 s, steers them into a running turn or waits for it to end, then sends one auto turn; follow-ups, the restart pass (`wake_pending`), the budget (`wake_tokens` counts in `missionUsage`) and Slack/email delivery (the task's own thread post is held back for it) are covered in `server/coordination.test.ts`. `childResultsNote` now clears only the results it read, and `task_status` marks one read. Settings → Tasks → "Tell the chat when its tasks finish" (`tasks.wakeChats`, default on).
- [x] **M2 · Context selection on provider switch.**
  - What to build: `context-select.ts`, `withTranscript()` replaced, the verbatim tail after a handoff packet, `chat_read` paging including the current chat.
  - *Accept:*
    - A 300-message chat switched from Claude to ChatGPT sends at most the budget.
    - It always includes the first and latest user messages and the latest reply, in order, plus the omitted count and the `chat_read` pointer.
    - The model can page the rest. A 6-message chat goes in whole.
  - *Shipped:* `server/agent/context-select.ts` (`selectContext`, `lastExchange`, the 16k / 4k budgets) feeds `transcriptPreamble` on a provider switch and on a failed resume; gaps are marked in place and the closing line carries `chat_read { chatId, before }`. A kept message too big for the budget on its own is the one thing that gets cut, and says so. Handoff packets end with `<last_exchange>` (the last message from a person and the last reply). `chat_read` pages (`before`, `limit` 20/50, 4,000 characters a message), reads the current chat, and is now registered with memory off too, for the current chat only. Tested through the real turn pipeline with fake providers.
- [x] **M3 · Retry-safe task tools.**
  - What to build: the `task_requests` table, and `request_id` / `requestId` on the tools and the route.
  - *Accept:*
    - The same `request_id` twice gives one task, even across a restart.
    - Different ids give two. `task_spawn_many` returns the same set on a repeat.
  - *Shipped:* `server/tasks/requests.ts` (`taskRequests.once`, synchronous so two calls can't both start) behind `task_start`, `task_spawn_many` (`request_id`, ≤ 100 characters; a repeat answers "Already started…" with the original tasks) and `POST /api/conversations/:id/tasks` (`requestId`; 201, then 200 with the same task). Rows go with their chat but not with a deleted task, so a retry never restarts deleted work. "Run as task" sends a `requestId`. The restart case is tested from a second process on the same database.
- [x] **M4 · Nothing ends silently.**
  - What to build: notices for stopped/interrupted tasks, the cut-off-reply note for chats, the queue hold and its Resume.
  - *Accept:*
    - With a fake provider that keeps erroring, the first task fails and the next queued task stays queued, with the queue shown paused. Resume starts it.
    - A usage-limit error doesn't hold the queue.
    - A stopped task's chat gets a notice, and the stop is in its next turn's results.
    - A chat reply cut off by a restart is mentioned once on the chat's next turn.
  - *Shipped:* `reportToParent` covers every ending (a stopped task, and an interrupted one when auto-resume is off), with the notices above; deleting a task isn't reported. `resultBlock` gives those a status and a note, no result. Startup marks a still-streaming reply `stopped` with `error: "Cut off when TOT restarted."` (shown under the reply), and a chat's next turn opens with the one-line note. `queue_holds` + `server/data/queue-holds.ts`: `run-loop` holds the agent's queue on "Stopped after repeated errors" unless the provider is at its usage limit, `pump()` skips held agents, `agent.queueHold` drives "Queue paused: Claude kept failing. Resume" in the sidebar's Tasks section and the queue popover (the error on hover), and `POST /api/agents/:id/queue/resume` (or Run now) clears it. Wakes start before tasks at boot, so a task cut off by the restart wakes its chat.
- [ ] **M5 · Wait for a task.**
  - What to build: `wait` / `wait_minutes` on both tools.
  - *Accept:*
    - A fast fake task returns its result in the tool call, with no wake after.
    - A timed-out wait returns "still running", and one wake follows when the task finishes.
    - Stopping the parent turn ends the wait.
- [ ] **M6 · Fork and merge back.**
  - What to build: `fork.ts`, the `provider_ref` and `forkedFrom` columns, native forks on both providers, the `selectContext` fallback, merge-back, the menu items.
  - *Accept:*
    - Forking at an earlier Claude reply continues natively: the fork knows what came before that reply, and not what came after.
    - The same works on ChatGPT through `thread/fork`.
    - A fork switched to the other provider gets the context selection.
    - Merge-back gives the source chat a notice and the fork's summary on its next turn.
- [ ] **M7 · Attach a chat as context.**
  - What to build: `contextChats` meta, the preamble, the `@` picker and chips, drag from the sidebar.
  - *Accept:*
    - With a chat attached, "what did we decide there?" is answered from it.
    - The chip shows on the sent message.
    - No more than the budget of the attached chat goes into the prompt.

Order: M1 first, since M5 builds on it. M2 next, since M6 and M7 reuse `selectContext`. M3 and M4 can go anywhere.

## Tests

`server/coordination.test.ts`, first import `./test-data-dir.ts`, added to `npm test`. Use `runLoop.useSender(...)` fakes as `server/tasks.test.ts` does. Cover:

- wake batching, steering vs waiting, read-before-wake, one-at-a-time, the startup pass;
- `selectContext` ordering, budget and whole-message rules, and `chat_read` paging;
- request ids, including after a restart (reopen the db);
- queue hold and resume, and that usage limits don't hold;
- stopped/interrupted notices and the cut-off-reply note;
- wait mode: done, timed out, aborted;
- fork lineage, the native-fork request shapes for both providers (fake providers asserting `forkSession` / `resumeSessionAt` / `thread/fork` arguments), the fallback, and merge-back replacing a pending one;
- attached chats in the preamble, within budget, same agent only.

## Out of scope

- **Showing Claude's or Codex's own built-in subagents.** TOT keeps those off on purpose (`claude.ts:342`, `chatgpt.ts:420`); its own tasks are the one way to run child work.
- **Forking tasks.** Chats only for now.
- **A general durable event log** for every side effect. The tables above are enough at TOT's size.

## Open questions

- **Wake turns in Slack and email chats** post a second message to the thread. Proposal: yes, and skip the plain "task done" message there, so there's still one message per finished batch.
- **Attaching a chat from another agent.** Proposal: not in M7. Allow it later only when the user attaches it themselves, never by the agent.
- **Fork from a task's transcript.** Proposal: later, once forks of chats have been used for a while.
