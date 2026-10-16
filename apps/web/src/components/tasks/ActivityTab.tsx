import { useMemo } from "react";
import type { Message } from "@tot/shared/types";
import { computerActivity } from "../../lib/tools";
import { useStore } from "../../store";
import { ComputerActivityItem } from "../ComputerActivityItem";
import type { TaskConversation } from "../../lib/tasks";

const NO_MESSAGES: Message[] = [];

/** What this task ran on the computer, newest first. */
export function ActivityTab({ task }: { task: TaskConversation }) {
  const messages = useStore((s) => s.messages[task.id]) ?? NO_MESSAGES;
  const live = useStore((s) => Boolean(s.activeRuns[task.id]));
  const entries = useMemo(() => computerActivity(messages), [messages]);

  if (!entries.length) return <p className="text-sm text-fg-subtle">Commands and file changes show up here as the task works.</p>;
  return (
    <ol className="space-y-1.5">
      {entries.map((part) => (
        <ComputerActivityItem key={part.id} part={part} live={live} />
      ))}
    </ol>
  );
}
