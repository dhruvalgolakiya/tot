import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import clsx from "clsx";
import { isTask, sortTasks } from "../../lib/tasks";
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

  return (
    <section className="mt-2">
      <div className="flex h-6 items-center justify-between pr-1 pl-2.5">
        <h2 className="group-label">Tasks</h2>
        {queued.length > 0 && <QueuePopover queued={queued} />}
      </div>
      <ul className="space-y-px">
        {[...open, ...shownFinished].map((task) => (
          <li key={task.id}>
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
