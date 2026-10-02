import { EventEmitter } from "node:events";
import type { AppEvent } from "../shared/types.ts";
import { agents } from "./data/agents.ts";
import { personas } from "./data/personas.ts";

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

  /** Re-sends a persona after something shown with it changed (mailbox state, unread count, its agents). */
  personaChanged(personaId: string | null | undefined): void {
    const persona = personaId ? personas.get(personaId) : null;
    if (persona) emitter.emit("event", { type: "persona", persona } satisfies AppEvent);
  },

  subscribe(listener: (event: AppEvent) => void): () => void {
    emitter.on("event", listener);
    return () => emitter.off("event", listener);
  },
};
