import { EventEmitter } from "node:events";
import type { ComputerSummary } from "@tot/shared/types";

/**
 * Side-channel events raised outside the provider stream (e.g. by MCP tool
 * handlers), keyed by agent id. Every active run of that agent's chats
 * forwards them to its client.
 */
export type ConversationEvent = { type: "computer"; computer: ComputerSummary };

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export const bus = {
  publish(agentId: string, event: ConversationEvent): void {
    emitter.emit(agentId, event);
  },

  subscribe(agentId: string, listener: (event: ConversationEvent) => void): () => void {
    emitter.on(agentId, listener);
    return () => emitter.off(agentId, listener);
  },
};
