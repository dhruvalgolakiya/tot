import { randomUUID } from "node:crypto";
import type { RunEvent } from "../../shared/types.ts";

type Listener = (seq: number, event: RunEvent) => void;

/** Finished runs stay replayable briefly so reconnecting clients can catch the end. */
const RETAIN_FINISHED_MS = 5 * 60_000;

/**
 * One assistant turn in flight. Events are buffered for the lifetime of the run
 * so any client can attach (or re-attach) and replay from a sequence number.
 */
export class Run {
  readonly id = randomUUID();
  readonly controller = new AbortController();
  private readonly events: RunEvent[] = [];
  private readonly listeners = new Set<Listener>();
  done = false;

  constructor(
    readonly conversationId: string,
    readonly messageId: string,
  ) {}

  push(event: RunEvent): void {
    if (this.done) return;
    this.events.push(event);
    const seq = this.events.length;
    for (const listener of this.listeners) listener(seq, event);
    if (event.type === "run-end") {
      this.done = true;
      this.listeners.clear();
    }
  }

  /** Replays events after `afterSeq` (1-based), then streams live ones. */
  subscribe(listener: Listener, afterSeq = 0): () => void {
    for (let i = afterSeq; i < this.events.length; i++) listener(i + 1, this.events[i]);
    if (this.done) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.events.length;
  }

  stop(): void {
    this.controller.abort();
  }
}

const runs = new Map<string, Run>();
const activeByConversation = new Map<string, Run>();

export const runRegistry = {
  create(conversationId: string, messageId: string): Run {
    const run = new Run(conversationId, messageId);
    runs.set(run.id, run);
    activeByConversation.set(conversationId, run);
    return run;
  },

  get(runId: string): Run | undefined {
    return runs.get(runId);
  },

  activeFor(conversationId: string): Run | undefined {
    const run = activeByConversation.get(conversationId);
    return run && !run.done ? run : undefined;
  },

  finish(run: Run): void {
    if (activeByConversation.get(run.conversationId) === run) activeByConversation.delete(run.conversationId);
    setTimeout(() => runs.delete(run.id), RETAIN_FINISHED_MS).unref();
  },

  stopAll(): void {
    for (const run of activeByConversation.values()) run.stop();
  },
};
