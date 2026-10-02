import { useMemo } from "react";
import clsx from "clsx";
import { Circle, CircleCheck } from "lucide-react";
import type { Message } from "@shared/types";
import { useNow } from "../../hooks/useNow";
import { relativeTime } from "../../lib/format";
import { answeredByLabel, modelLabel } from "../../lib/models";
import { formatTokens, isOpenTask, repoLabel, taskElapsed, type TaskConversation } from "../../lib/tasks";
import { useStore } from "../../store";
import { LazyMarkdown } from "../LazyMarkdown";
import { Callout } from "../ui/Callout";

const NO_MESSAGES: Message[] = [];

/** The goal, the agent's checklist and latest step, the result once it's in, and the task's details. */
export function PlanTab({ task }: { task: TaskConversation }) {
  const models = useStore((s) => s.models);
  const messages = useStore((s) => s.messages[task.id]) ?? NO_MESSAGES;
  const now = useNow(task.task.status === "running");
  const { goal, plan, progress, question, summary, status, repo, usage, turns, startedAt } = task.task;
  const lastReply = useMemo(() => messages.findLast((m) => m.role === "assistant" && m.model), [messages]);
  const done = plan.filter((step) => step.done).length;

  const details: [string, string][] = [
    ["Model", (lastReply && answeredByLabel(models, lastReply)) ?? modelLabel(models, task.modelId)],
    ...(startedAt ? ([["Started", relativeTime(startedAt, now)]] as [string, string][]) : []),
    ["Working for", taskElapsed(task.task, now) ?? "Not started"],
    ["Turns", String(turns)],
    ["Tokens", `${formatTokens(usage.inputTokens)} in · ${formatTokens(usage.outputTokens)} out`],
    ...(repo
      ? ([
          ["Repo", repoLabel(repo.source)],
          ["Branch", `${repo.branch}${repo.baseBranch ? ` ← ${repo.baseBranch}` : ""}`],
          ["Worktree", repo.worktree],
        ] as [string, string][])
      : []),
  ];

  return (
    <div className="space-y-6">
      <section className="space-y-1.5">
        <h3 className="group-label">Goal</h3>
        <p className="text-sm leading-relaxed whitespace-pre-line text-fg">{goal}</p>
      </section>

      {status === "needs-input" && (
        <Callout tone="warning">{question ?? "Waiting for your OK on an action in the chat."}</Callout>
      )}

      <section className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="group-label">Plan</h3>
          {plan.length > 0 && (
            <span className="text-xs text-fg-subtle tabular-nums">
              {done} of {plan.length}
            </span>
          )}
        </div>
        {plan.length === 0 ? (
          <p className="text-sm text-fg-subtle">{isOpenTask(status) ? "The plan shows up here once the agent writes it." : "No plan was written."}</p>
        ) : (
          <ol className="space-y-1.5">
            {plan.map((step, index) => (
              <li key={index} className="flex items-start gap-2.5 text-sm">
                {step.done ? (
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-label="Done" />
                ) : (
                  <Circle className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-label="To do" />
                )}
                <span className={clsx("leading-relaxed", step.done ? "text-fg-muted" : "text-fg")}>{step.text}</span>
              </li>
            ))}
          </ol>
        )}
        {progress && isOpenTask(status) && <p className="text-xs text-fg-subtle">Now: {progress}</p>}
      </section>

      {summary && (
        <section className="space-y-1.5">
          <h3 className="group-label">{status === "done" ? "Result" : status === "failed" ? "Why it failed" : "Note"}</h3>
          <div className="text-sm">
            <LazyMarkdown text={summary} muted />
          </div>
        </section>
      )}

      <section className="space-y-1.5">
        <h3 className="group-label">Details</h3>
        <dl className="divide-y divide-hairline rounded-xl border border-hairline">
          {details.map(([label, value]) => (
            <div key={label} className="flex items-baseline gap-3 px-3 py-2">
              <dt className="w-24 shrink-0 text-xs text-fg-subtle">{label}</dt>
              <dd className={clsx("min-w-0 flex-1 text-ui break-words text-fg", (label === "Branch" || label === "Worktree") && "font-mono")}>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
