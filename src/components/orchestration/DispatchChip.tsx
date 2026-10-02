import { ArrowRight } from "lucide-react";
import type { Dispatch } from "@shared/types";
import { ROLE_LABELS } from "../../lib/orchestration";
import { navigateToConversation, useStore } from "../../store";
import { Tip } from "../ui/Tip";

/** Under a user message: what TOT did with it ("Auto → 2 tasks"), with why on hover. Quiet when it was simply answered. */
export function DispatchChip({ dispatch }: { dispatch: Dispatch }) {
  const target = useStore((s) => (dispatch.mode === "continue-task" ? s.conversations.find((c) => c.id === dispatch.taskId) : undefined));
  if (dispatch.mode === "inline") return null;
  const who = dispatch.by === "user" ? "Task" : "Auto";
  const label =
    dispatch.mode === "continue-task"
      ? `“${target?.title ?? "a task"}”`
      : dispatch.sessions.length === 1
        ? "a task"
        : `${dispatch.sessions.length} tasks`;
  const detail =
    dispatch.mode === "spawn"
      ? `${dispatch.reason}: ${dispatch.sessions.map((s) => `${ROLE_LABELS[s.role].toLowerCase()} (${s.tier})`).join(", ")}${dispatch.then ? ", then combined here" : ""}`
      : `${dispatch.reason}: passed to the task while it works`;
  const open = dispatch.mode === "continue-task" ? () => navigateToConversation(dispatch.taskId) : undefined;

  return (
    <Tip content={detail}>
      <button
        type="button"
        onClick={open}
        disabled={!open}
        className="mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-fg-subtle transition-colors enabled:hover:bg-hover enabled:hover:text-fg-muted disabled:cursor-default"
      >
        {who}
        <ArrowRight className="size-3" />
        <span className="max-w-56 truncate">{label}</span>
      </button>
    </Tip>
  );
}
