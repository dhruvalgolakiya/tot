import { memo } from "react";
import type { Message, MessagePart, TaskStatus } from "@tot/shared/types";
import { isTask } from "../../lib/tasks";
import { navigateToConversation, useStore } from "../../store";
import { TaskStatusIcon } from "./TaskStatus";

type Notice = Extract<MessagePart, { type: "notice" }>;

/** How the server words a task's ending in its chat (apps/server/tasks/tasks.ts endingNotice). */
const ENDING = /^“(.+?)” (is done|failed|was stopped|was cut off when TOT restarted)(?:[^:]*?)(?::\s*([\s\S]*))?\.?$/;
const STATUS: Record<string, TaskStatus> = {
  "is done": "done",
  failed: "failed",
  "was stopped": "stopped",
  "was cut off when TOT restarted": "interrupted",
};

/** A notice saying a task this chat started has ended ("“Research” is done: …"). */
export function isTaskEndingNotice(part: MessagePart): part is Notice {
  return part.type === "notice" && !part.group && (Boolean(part.taskId) || ENDING.test(part.text));
}

/** A message that is nothing but task endings: it joins its neighbours in one compact list. */
export function isTaskEndingMessage(message: Message): boolean {
  return message.role === "assistant" && message.status === "complete" && message.parts.length > 0 && message.parts.every(isTaskEndingNotice);
}

/**
 * The tasks a chat started, as they finish: one quiet line each (status icon, title, the start of its result), stacked
 * together however many messages they came in. A line opens its task.
 */
export const TaskNotices = memo(function TaskNotices({ messages, conversationId }: { messages: Message[]; conversationId: string }) {
  const all = useStore((s) => s.conversations);
  const notices = messages.flatMap((message) => message.parts.filter(isTaskEndingNotice));

  return (
    <ul className="-mx-2 flex flex-col">
      {notices.map((notice) => {
        const match = ENDING.exec(notice.text);
        const title = match?.[1] ?? notice.text;
        // Older notices carry no task id: find the task by its title among this chat's tasks.
        const task =
          all.find((c) => c.id === notice.taskId) ??
          all.find((c) => isTask(c) && c.parentId === conversationId && c.title === title);
        const status: TaskStatus = (match && STATUS[match[2]!]) ?? (notice.kind === "warning" ? "failed" : "done");
        const result = (match?.[3] ?? "").replace(/\s+/g, " ").replace(/…$/, "").trim();
        const body = (
          <>
            <TaskStatusIcon status={status} />
            <span className="min-w-0 flex-1 truncate">
              <span className="text-fg-muted">{task?.title ?? title}</span>
              {result && <span className="text-fg-subtle"> · {result}</span>}
            </span>
          </>
        );
        return (
          <li key={notice.id}>
            {task ? (
              <button
                type="button"
                onClick={() => navigateToConversation(task.id)}
                className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-ui transition-colors hover:bg-hover focus-visible:-outline-offset-2"
              >
                {body}
              </button>
            ) : (
              <div className="flex h-8 min-w-0 items-center gap-2 px-2 text-ui">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
});
