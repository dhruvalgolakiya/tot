import clsx from "clsx";
import { create } from "zustand";
import type { Message, PlanUsage, PlanUsageWindow } from "@tot/shared/types";
import { api } from "../../lib/api";
import { useStore } from "../../store";
import { Tip } from "../ui/Tip";

/**
 * A small ring in the composer's footer: how much of the model's context this chat's session holds, from what the
 * provider reported with the latest reply; hovering adds the account's plan limits when it reported them. Hidden
 * until there's a number.
 */

const usePlanUsage = create<{ usage: Record<string, PlanUsage>; at: number }>()(() => ({ usage: {}, at: 0 }));
/** How long plan limits shown on hover last before they're asked for again. */
const PLAN_TTL_MS = 30_000;

function loadPlanUsage() {
  if (Date.now() - usePlanUsage.getState().at < PLAN_TTL_MS) return;
  usePlanUsage.setState({ at: Date.now() });
  api.planUsage().then(
    (usage) => usePlanUsage.setState({ usage }),
    () => usePlanUsage.setState({ at: 0 }),
  );
}

/** The newest reply's context numbers, as one string so a streaming reply doesn't re-render this. */
function contextOf(messages: Message[] | undefined): string | null {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const message = messages![i]!;
    if (message.role !== "assistant") continue;
    const { contextTokens, contextWindow } = message.usage ?? {};
    if (contextTokens && contextWindow) return `${contextTokens}|${contextWindow}|${message.account ?? message.provider ?? ""}`;
  }
  return null;
}

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function resetText(at: number | null): string {
  if (!at) return "";
  const minutes = Math.max(1, Math.round((at - Date.now()) / 60_000));
  if (minutes < 60) return ` · resets in ${minutes} min`;
  if (minutes < 48 * 60) return ` · resets in ${Math.round(minutes / 60)} h`;
  return ` · resets ${new Date(at).toLocaleDateString(undefined, { weekday: "short" })}`;
}

function windowLine(window: PlanUsageWindow): string {
  const used = window.reached ? "limit reached" : window.usedPercent === null ? "near its limit" : `${window.usedPercent}% used`;
  return `${window.label} limit: ${used}${resetText(window.resetsAt)}`;
}

export function ContextMeter({ conversationId }: { conversationId: string }) {
  const context = useStore((s) => contextOf(s.messages[conversationId]));
  const plan = usePlanUsage((s) => (context ? s.usage[context.split("|")[2]!] : undefined));
  if (!context) return null;
  const [used, size] = context.split("|").map(Number) as [number, number];
  const share = Math.min(used / size, 1);
  const percent = Math.round(share * 100);
  const radius = 6.5;
  const around = 2 * Math.PI * radius;

  const tip = (
    <div className="space-y-0.5 py-0.5">
      <p>{`Context: ${tokens(used)} of ${tokens(size)} tokens (${percent}%)`}</p>
      {plan?.windows.map((window) => (
        <p key={window.label} className="font-normal text-fg-muted">
          {windowLine(window)}
        </p>
      ))}
    </div>
  );

  return (
    <Tip content={tip}>
      <button
        type="button"
        aria-label={`Context ${percent}% used`}
        onPointerEnter={loadPlanUsage}
        onFocus={loadPlanUsage}
        className="grid size-7 shrink-0 cursor-default place-items-center rounded-full transition-colors hover:bg-hover"
      >
        <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden="true">
          {/* A full track under the arc, so it reads as a gauge rather than a spinner. */}
          <circle cx="8" cy="8" r={radius} fill="none" strokeWidth="2" className="stroke-fg/25" />
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${around * share} ${around}`}
            className={clsx(share >= 0.9 ? "stroke-danger" : share >= 0.75 ? "stroke-warning" : "stroke-fg-muted")}
          />
        </svg>
      </button>
    </Tip>
  );
}
