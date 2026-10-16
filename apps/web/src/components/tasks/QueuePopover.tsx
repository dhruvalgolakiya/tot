import { useState, type DragEvent, type KeyboardEvent } from "react";
import clsx from "clsx";
import { Popover } from "radix-ui";
import { GripVertical } from "lucide-react";
import type { QueueHold } from "../../../shared/types";
import type { TaskConversation } from "../../lib/tasks";
import { navigateToConversation, patchTask, runTaskNow } from "../../store";
import { Button } from "../ui/Button";
import { QueueHoldLine } from "./QueueHold";

/**
 * "Queue · 3" in the Tasks header: the agent's queued tasks in order. Drag a row (or focus it
 * and press Alt+↑/↓) to reorder; Run now puts a task first and starts it if there's a free slot
 * (resuming a paused queue).
 */
export function QueuePopover({ queued, hold }: { queued: TaskConversation[]; hold: QueueHold | null }) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);

  const move = (id: string, position: number) => void patchTask(id, { queuePosition: position });

  function onDrop(event: DragEvent, index: number) {
    event.preventDefault();
    if (dragging) move(dragging, index + 1);
    setDragging(null);
    setOver(null);
  }

  function onKeyDown(event: KeyboardEvent, task: TaskConversation, index: number) {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const next = index + (event.key === "ArrowUp" ? -1 : 1);
    if (next >= 0 && next < queued.length) move(task.id, next + 1);
  }

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="rounded-md px-1.5 py-0.5 text-xs text-fg-subtle tabular-nums transition-colors hover:bg-hover hover:text-fg-muted data-[state=open]:bg-selected data-[state=open]:text-fg"
        >
          Queue · {queued.length}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={4} collisionPadding={8} className="menu w-72 p-1">
          {hold && <QueueHoldLine agentId={queued[0]!.agentId} hold={hold} focusable={false} className="px-2" />}
          <p className="menu-label">Up next · drag to reorder</p>
          <ol aria-label="Queued tasks">
            {queued.map((task, index) => (
              <li
                key={task.id}
                draggable
                tabIndex={0}
                aria-label={`${index + 1}. ${task.title}. Alt+Up or Alt+Down to move.`}
                onDragStart={(event) => {
                  setDragging(task.id);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setOver(index);
                }}
                onDrop={(event) => onDrop(event, index)}
                onKeyDown={(event) => onKeyDown(event, task, index)}
                className={clsx(
                  "group/item flex h-9 items-center gap-1.5 rounded-lg pr-1 pl-1 transition-colors focus-visible:-outline-offset-2",
                  dragging === task.id ? "opacity-50" : "hover:bg-hover",
                  over === index && dragging && dragging !== task.id && "bg-selected",
                )}
              >
                <GripVertical className="size-4 shrink-0 cursor-grab text-fg-subtle" aria-hidden="true" />
                <span className="w-4 shrink-0 text-xs text-fg-subtle tabular-nums">{index + 1}</span>
                <button
                  type="button"
                  onClick={() => navigateToConversation(task.id)}
                  className="min-w-0 flex-1 truncate text-left text-ui text-fg hover:underline"
                >
                  {task.title}
                </button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2.5 opacity-0 group-hover/item:opacity-100 group-focus-within/item:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                  onClick={() => void runTaskNow(task.id)}
                >
                  Run now
                </Button>
              </li>
            ))}
          </ol>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
