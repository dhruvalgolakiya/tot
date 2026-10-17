import { useState } from "react";
import { ListChecks, X } from "lucide-react";
import { dismissPlanFollowUp, IMPLEMENT_PLAN, setPlanMode, usePlanMode } from "../../lib/plan-mode";
import { sendMessage, useStore } from "../../store";
import { buttonClass } from "../ui/buttonStyles";
import { IconButton } from "../ui/IconButton";
import { Tip } from "../ui/Tip";

/** After a plan-mode reply finishes, a slim row above the composer: carry it out (plan mode off), or dismiss it. */
export function PlanFollowUp({ conversationId }: { conversationId: string }) {
  const last = useStore((s) => s.messages[conversationId]?.at(-1));
  const running = useStore((s) => Boolean(s.activeRuns[conversationId]));
  const sending = useStore((s) => s.sending);
  const dismissed = usePlanMode((s) => (last ? s.dismissed.has(last.id) : false));
  const [busy, setBusy] = useState(false);
  if (!last || last.role !== "assistant" || !last.plan || last.status !== "complete" || running || dismissed) return null;

  async function implement() {
    setBusy(true);
    setPlanMode(conversationId, false);
    if (!(await sendMessage(IMPLEMENT_PLAN))) setPlanMode(conversationId, true);
    setBusy(false);
  }

  return (
    <div className="mb-2 flex h-10 min-w-0 items-center gap-2 rounded-2xl border border-hairline bg-fill-subtle pr-1.5 pl-3 text-ui">
      <ListChecks className="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-fg-muted">The plan is ready</span>
      <button type="button" disabled={busy || sending} onClick={() => void implement()} className={buttonClass("primary", "sm", "h-7 px-3")}>
        Implement this plan
      </button>
      <Tip content="Dismiss">
        <IconButton label="Dismiss" size="sm" onClick={() => dismissPlanFollowUp(last.id)}>
          <X />
        </IconButton>
      </Tip>
    </div>
  );
}
