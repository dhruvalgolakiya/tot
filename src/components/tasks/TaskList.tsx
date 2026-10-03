import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import clsx from "clsx";
import { isTask, sortTasks, type TaskConversation } from "../../lib/tasks";
import { selectActiveAgentId, useStore } from "../../store";
import { QueuePopover } from "./QueuePopover";
import { TaskRow } from "./TaskRow";

/** How many finished tasks the folded "Finished" list shows. */
const FINISHED_SHOWN = 15;

/**
 * The selected agent's tasks, above its chats: running, waiting and queued ones first, then the
 * recent finished ones folded away. Hidden when the agent has no tasks.
 */
export function TaskList({ query }: { query: string }) {
  const conversations = useStore((s) => s.conversations);
  const currentId = useStore((s) => s.currentId);
  const agentId = useStore(selectActiveAgentId);
  const [showFinished, setShowFinished] = useState(false);
  const needle = query.trim().toLowerCase();

  const { open, finished } = useMemo(
    () =>
      sortTasks(
        conversations
          .filter(isTask)
          .filter((task) => task.agentId === agentId && (!needle || task.title.toLowerCase().includes(needle))),
      ),
    [conversations, agentId, needle],
  );
  const queued = open.filter((task) => task.task.status === "queued");
  if (!open.length && !finished.length) return null;
  // The open task is always listed, even when it's finished and folded away.
  const shownFinished = showFinished ? finished.slice(0, FINISHED_SHOWN) : finished.filter((task) => task.id === currentId);
  // Tasks started by a task in the list sit under it, one step in.
  const shown = [...open, ...shownFinished];
  const listed = new Set(shown.map((task) => task.id));
  const childrenOf = new Map<string, TaskConversation[]>();
  for (const task of shown) {
    if (task.parentId && listed.has(task.parentId)) childrenOf.set(task.parentId, [...(childrenOf.get(task.parentId) ?? []), task]);
  }
  const rows: { task: TaskConversation; depth: number }[] = [];
  const add = (task: TaskConversation, depth: number) => {
    rows.push({ task, depth });
    for (const child of childrenOf.get(task.id) ?? []) add(child, depth + 1);
  };
  for (const task of shown) if (!task.parentId || !listed.has(task.parentId)) add(task, 0);

  return (
    <section className="mt-2">
      <div className="flex h-6 items-center justify-between pr-1 pl-2.5">
        <h2 className="group-label">Tasks</h2>
        {queued.length > 0 && <QueuePopover queued={queued} />}
      </div>
      <ul className="space-y-px">
        {rows.map(({ task, depth }) => (
          <li key={task.id} className={clsx(depth > 0 && "pl-4")}>
            <TaskRow task={task} active={task.id === currentId} />
          </li>
        ))}
      </ul>
      {finished.length > 0 && (
        <button
          type="button"
          aria-expanded={showFinished}
          onClick={() => setShowFinished((value) => !value)}
          className="mt-0.5 flex h-8 w-full items-center gap-1.5 rounded-lg px-2.5 text-xs text-fg-subtle transition-colors hover:bg-hover hover:text-fg-muted"
        >
          <ChevronRight className={clsx("size-3.5 transition-transform", showFinished && "rotate-90")} />
          Finished · {finished.length}
        </button>
      )}
    </section>
  );
}
