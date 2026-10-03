import { randomUUID } from "node:crypto";
import type { Message } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { runRegistry, type Run } from "../agent/runs.ts";
import { appEvents } from "../app-events.ts";
import { conversations, toPublicConversation } from "../data/conversations.ts";
import { messages } from "../data/messages.ts";
import { runLoop } from "./run-loop.ts";
import { taskStore } from "./store.ts";

/**
 * Steering: a note from the user while a task works. It's saved in the transcript right
 * away (a user message marked `steered`), then delivered:
 *  - mid-turn, when the provider can take input during a turn (Claude: a queued user message
 *    on the Agent SDK's streaming input; ChatGPT: Codex's `turn/steer`) — see TurnInput.onSteerable;
 *  - otherwise, or when that fails: TOT stops the turn at its next tool boundary (so no work
 *    is lost mid-step), and the task's next turn starts with "The user added: …".
 * A note sent between turns, or while the task waits in the queue, goes with its next turn.
 */

const MAX_NOTE = 4000;

/** Stops a run as soon as its current tool call finishes (or now, when nothing is running). */
function stopAtToolBoundary(run: Run): void {
  const reply = run.reply?.();
  const busy = reply?.parts.some((part) => part.type === "tool" && part.status === "running");
  if (!busy) {
    run.stop("steer");
    return;
  }
  const unsubscribe = run.subscribe((_seq, event) => {
    if (event.type === "part-update" && event.part.type === "tool" && event.part.status !== "running") {
      unsubscribe();
      run.stop("steer");
    }
  }, run.size);
}

async function deliver(run: Run, taskId: string, text: string): Promise<void> {
  const delivered = run.steer ? await run.steer(text).catch(() => false) : false;
  if (delivered) return;
  runLoop.addNote(taskId, text);
  if (!run.done) stopAtToolBoundary(run);
}

/** Saves the note and gets it to the task; resolves with the saved message. */
export function steer(taskId: string, text: string): Message {
  const task = taskStore.require(taskId);
  const note = text.trim();
  if (!note) throw new HttpError(400, "The note is empty.");
  if (note.length > MAX_NOTE) throw new HttpError(400, `Keep notes under ${MAX_NOTE} characters.`);
  const { status } = task.task;
  if (status !== "running" && status !== "queued" && status !== "needs-input") {
    throw new HttpError(409, "This task isn't running. Send a message to pick it up again.");
  }

  const run = runRegistry.activeFor(taskId);
  const reply = run?.reply?.();
  const message: Message = {
    id: randomUUID(),
    conversationId: taskId,
    role: "user",
    parts: [{ type: "text", id: randomUUID(), text: note }],
    status: "complete",
    steered: true,
    ...(reply ? { steeredInto: { messageId: reply.id, afterPartId: reply.parts.at(-1)?.id ?? null } } : {}),
    createdAt: Date.now(),
  };
  messages.insert(message);
  const touched = conversations.update(taskId, {}, true);
  if (touched) appEvents.publish({ type: "conversation", conversation: toPublicConversation(touched) });

  if (run) void deliver(run, taskId, note);
  else runLoop.addNote(taskId, note);
  return message;
}
