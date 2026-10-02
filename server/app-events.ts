import { EventEmitter } from "node:events";
import type { AppEvent } from "../shared/types.ts";
import { agents } from "./data/agents.ts";
import { brains } from "./data/brains.ts";

/** App-wide live updates, fanned out to every open tab via GET /api/events. */

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export const appEvents = {
  publish(event: AppEvent): void {
    emitter.emit("event", event);
  },

  /** Re-sends an agent after what's in its workspace (chats, memories, routines) changed. */
  agentChanged(agentId: string | null | undefined): void {
    const agent = agentId ? agents.get(agentId) : null;
    if (agent) emitter.emit("event", { type: "agent", agent } satisfies AppEvent);
  },

  /**
   * A brain's pages changed. With `structure`, its page count or the brains themselves
   * changed too, so the brain list and every agent's page counts are re-sent.
   */
  brainChanged(brainId: string, { structure = false, conversationId }: { structure?: boolean; conversationId?: string } = {}): void {
    emitter.emit("event", { type: "wiki", brainId, ...(conversationId ? { conversationId } : {}) } satisfies AppEvent);
    if (structure) appEvents.brainsChanged();
  },

  /** Re-sends the brain list (and agents, whose page counts depend on it). */
  brainsChanged(): void {
    emitter.emit("event", { type: "brains", brains: brains.list() } satisfies AppEvent);
    for (const agent of agents.list()) emitter.emit("event", { type: "agent", agent } satisfies AppEvent);
  },

  subscribe(listener: (event: AppEvent) => void): () => void {
    emitter.on("event", listener);
    return () => emitter.off("event", listener);
  },
};
