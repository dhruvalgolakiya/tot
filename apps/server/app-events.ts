import { EventEmitter } from "node:events";
import type { AppEvent } from "@tot/shared/types";
import { agents } from "./data/agents.ts";
import { brains } from "./data/brains.ts";
import { personas } from "./data/personas.ts";

/** App-wide live updates, fanned out to every open tab via GET /api/events. */

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/** An event and its JSON, made once however many tabs and phones it goes to (on the first one's ask). */
function send(event: AppEvent): void {
  let text: string | undefined;
  emitter.emit("event", event, () => (text ??= JSON.stringify(event)));
}

export const appEvents = {
  publish(event: AppEvent): void {
    send(event);
  },

  /** Re-sends an agent after what's in its workspace (chats, memories, routines) changed. */
  agentChanged(agentId: string | null | undefined): void {
    const agent = agentId ? agents.get(agentId) : null;
    if (agent) send({ type: "agent", agent });
  },

  /** Re-sends a persona after something shown with it changed (mailbox state, unread count, its agents). */
  personaChanged(personaId: string | null | undefined): void {
    const persona = personaId ? personas.get(personaId) : null;
    if (persona) send({ type: "persona", persona });
  },

  /**
   * A brain's pages changed. With `structure`, its page count or the brains themselves
   * changed too, so the brain list and every agent's page counts are re-sent.
   */
  brainChanged(brainId: string, { structure = false, conversationId }: { structure?: boolean; conversationId?: string } = {}): void {
    send({ type: "wiki", brainId, ...(conversationId ? { conversationId } : {}) });
    if (structure) appEvents.brainsChanged();
  },

  /** Re-sends the brain list (and agents, whose page counts depend on it). */
  brainsChanged(): void {
    send({ type: "brains", brains: brains.list() });
    for (const agent of agents.list()) send({ type: "agent", agent });
  },

  /** `json()` is the event as JSON, shared by every subscriber that sends it on. */
  subscribe(listener: (event: AppEvent, json: () => string) => void): () => void {
    emitter.on("event", listener);
    return () => emitter.off("event", listener);
  },
};
