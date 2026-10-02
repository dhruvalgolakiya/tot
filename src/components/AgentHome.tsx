import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { openAgentSettings, selectActiveAgent, useStore } from "../store";
import { defaultMascot, MascotStage } from "./mascot";
import { routinesApi } from "./routines/routinesApi";

/** An agent's new-chat hero: its mascot, a greeting, and a one-line pitch. */
export function AgentHome() {
  const agent = useStore(selectActiveAgent);
  const name = agent?.name ?? "TOT";
  const [routineCount, setRoutineCount] = useState(0);

  useEffect(() => {
    setRoutineCount(0);
    if (!agent) return;
    let cancelled = false;
    routinesApi.list(agent.id).then(
      (routines) => {
        if (!cancelled) setRoutineCount(routines.length);
      },
      () => {
        // Quiet failure: the chip just doesn't show. RoutinesPanel reports errors itself.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agent?.id]);

  return (
    <div className="flex flex-1 flex-col items-center justify-end px-4 pt-14 pb-8">
      <MascotStage spec={agent?.mascot ?? defaultMascot} size={200} title={name} />
      <h1 className="mt-6 text-center text-display text-fg-strong">Hi, I'm {name}</h1>
      <p className="mt-2 max-w-md text-center text-sm leading-relaxed text-fg-muted">
        Ask me anything, or hand me a task — I can browse the web, use a computer, and remember what matters to you.
      </p>
      {agent && routineCount > 0 && (
        <button
          type="button"
          onClick={() => openAgentSettings(agent.id, "routines")}
          className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-edge bg-fill-subtle px-3 py-1 text-xs font-medium text-fg-muted transition-colors hover:border-edge-strong hover:bg-hover hover:text-fg"
        >
          <Clock className="size-3.5" />
          <span className="tabular-nums">
            {routineCount} routine{routineCount === 1 ? "" : "s"}
          </span>
        </button>
      )}
    </div>
  );
}
