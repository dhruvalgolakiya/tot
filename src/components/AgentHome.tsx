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
      <h1 className="mt-6 text-center text-[32px] font-semibold tracking-[-0.02em] text-white/92 sm:text-[40px]">
        Hi, I'm {name}
      </h1>
      <p className="mt-2 max-w-md text-center text-[15px] text-white/55">
        Ask me anything, or hand me a task — I can browse the web, use a computer, and remember what matters to you.
      </p>
      {agent && routineCount > 0 && (
        <button
          type="button"
          onClick={() => openAgentSettings(agent.id, "routines")}
          className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs font-medium text-white/55 transition-colors hover:border-white/20 hover:bg-white/[0.06] hover:text-white/85"
        >
          <Clock className="size-3.5" />
          {routineCount} routine{routineCount === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}
