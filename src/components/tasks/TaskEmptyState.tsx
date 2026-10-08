import { useLayoutEffect, useRef, useState } from "react";
import { budgetReason, pausedForBudget, queueLine, TASK_STATUS_LABELS, type TaskConversation } from "../../lib/tasks";
import { goToSettings, resumeTask, useStore } from "../../store";
import { TaskStatusIcon } from "./TaskStatus";

/** Where a task is, in plain words, and the one or two things that move it on (as quiet links). */
function taskState(task: TaskConversation, queueHeld: boolean): { text: string; budget: boolean; resumable: boolean } {
  const { status, progress, question, summary } = task.task;
  const budget = pausedForBudget(task.task);
  if (budget) return { text: budgetReason(task.task), budget, resumable: true };
  switch (status) {
    case "queued":
      return { text: queueHeld ? "Waiting to start: the queue is paused" : queueLine(task.task), budget, resumable: false };
    case "running":
      return { text: progress ?? "Starting…", budget, resumable: false };
    case "needs-input":
      return { text: question ?? progress ?? "Waiting for you.", budget, resumable: false };
    case "paused":
      return { text: progress ?? "Paused before it started.", budget, resumable: true };
    case "interrupted":
      return { text: "Cut off when TOT restarted, before it replied.", budget, resumable: true };
    default:
      return { text: summary ?? TASK_STATUS_LABELS[status], budget, resumable: false };
  }
}

/** The status line alone: under a task's last message when it paused for the budget. */
export function TaskStateLine({ task }: { task: TaskConversation }) {
  const queueHeld = useStore((s) => Boolean(s.agents.find((agent) => agent.id === task.agentId)?.queueHold));
  const state = taskState(task, queueHeld);
  return (
    <div className="flex items-start gap-2 text-ui text-fg-muted">
      <TaskStatusIcon status={task.task.status} className="-my-0.5" />
      <p className="min-w-0 flex-1 text-pretty">
        {state.text}
        <StateActions task={task} budget={state.budget} resumable={state.resumable} />
      </p>
    </div>
  );
}

function StateActions({ task, budget, resumable }: { task: TaskConversation; budget: boolean; resumable: boolean }) {
  if (!budget && !resumable) return null;
  return (
    <span className="ml-2 inline-flex gap-3 whitespace-nowrap">
      {budget && (
        <button type="button" onClick={() => goToSettings("tasks")} className="link-muted">
          Raise the budget
        </button>
      )}
      {resumable && (
        <button type="button" onClick={() => void resumeTask(task.id)} className="link-muted">
          Resume
        </button>
      )}
    </span>
  );
}

/** A task with nothing in it yet (queued, paused before it started, or about to reply): what it was asked, and where it is. */
export function TaskEmptyState({ task }: { task: TaskConversation }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const goalRef = useRef<HTMLParagraphElement>(null);
  const goal = (task.task.brief?.goal ?? task.task.goal).trim();
  // Long briefs show their first few lines until asked for the rest.
  useLayoutEffect(() => {
    const el = goalRef.current;
    if (el && !expanded) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [goal, expanded]);

  return (
    <div className="space-y-5 pt-4">
      {goal && (
        <div className="space-y-1.5">
          <p className="text-xs text-fg-subtle">Asked to</p>
          <p ref={goalRef} className={`text-sm leading-relaxed whitespace-pre-wrap text-fg-muted ${expanded ? "" : "line-clamp-4"}`}>
            {goal}
          </p>
          {(clamped || expanded) && (
            <button type="button" onClick={() => setExpanded((value) => !value)} className="text-xs link-muted">
              {expanded ? "Show less" : "Show all"}
            </button>
          )}
        </div>
      )}
      <TaskStateLine task={task} />
    </div>
  );
}
