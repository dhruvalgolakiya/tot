import type { Routine } from "../../shared/types.ts";
import { appEvents } from "../app-events.ts";
import { agents } from "../data/agents.ts";
import { conversations } from "../data/conversations.ts";
import { routines } from "../data/routines.ts";
import { projectSchedules } from "../projects/schedules.ts";
import { sendMessage } from "./orchestrator.ts";
import { runRegistry } from "./runs.ts";

/**
 * Runs routines when they're due: each run is a new chat with the routine's agent. A project's schedule
 * (module 12) runs in the project's Lead instead (projects/schedules.ts).
 */

const TICK_MS = 30_000;

const dayLabel = (time: number) => new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export async function runRoutine(routine: Routine): Promise<{ conversationId: string; runId: string }> {
  if (routine.projectId) return projectSchedules.run(routine);
  const agent = agents.get(routine.agentId);
  if (!agent) throw new Error("This routine's agent no longer exists.");
  const conversation = conversations.create({
    agentId: agent.id,
    modelId: agent.modelId,
    title: `${routine.name} · ${dayLabel(Date.now())}`,
    routineId: routine.id,
  });
  appEvents.agentChanged(agent.id);
  try {
    const { runId } = await sendMessage(
      conversation.id,
      { text: routine.prompt },
      {
        preamble: `[This is your scheduled routine “${routine.name}”, running on its own — the user isn't watching live. Do the task end to end, then finish with a short summary of the result.]`,
      },
    );
    return { conversationId: conversation.id, runId };
  } finally {
    // Advance even when the run couldn't start (e.g. no provider), so a broken routine can't spin.
    routines.markRun(routine.id, conversation.id);
  }
}

function tick(): void {
  for (const routine of routines.due()) {
    if (routine.projectId) {
      projectSchedules.due(routine);
      continue;
    }
    // Don't stack runs: skip this slot while the previous run is still going.
    if (routine.lastConversationId && runRegistry.activeFor(routine.lastConversationId)) {
      routines.markRun(routine.id, null);
      continue;
    }
    runRoutine(routine).catch((err) =>
      console.warn(`[tot] routine "${routine.name}" couldn't start:`, err instanceof Error ? err.message : err),
    );
  }
}

let timer: NodeJS.Timeout | null = null;

export const scheduler = {
  /** Starts ticking; routines missed while TOT was off run once shortly after startup. */
  start(): void {
    if (timer) return;
    timer = setInterval(tick, TICK_MS);
    timer.unref();
    setTimeout(tick, 5_000).unref();
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },

  /** Runs what's due now (tests; the timer does this every 30 seconds). */
  tick,
};
