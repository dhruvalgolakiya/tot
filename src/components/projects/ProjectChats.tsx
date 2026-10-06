import { useMemo, type MouseEvent } from "react";
import clsx from "clsx";
import { SquarePen } from "lucide-react";
import type { Agent, Conversation, Project } from "@shared/types";
import { useNow } from "../../hooks/useNow";
import { conversationTitle } from "../../lib/conversations";
import { toMs } from "../../lib/format";
import { setNewProjectChat } from "../../lib/lead";
import { shortTime } from "../../lib/projects";
import { conversationPath } from "../../lib/router";
import { isOpenTask, isTask, TASK_STATUS_LABELS } from "../../lib/tasks";
import { navigateToConversation, useStore } from "../../store";
import { Mascot } from "../mascot";
import { TaskDot } from "../tasks/TaskStatus";
import { Badge } from "../ui/Badge";
import { EmptyState } from "../ui/EmptyState";
import { listRowClass } from "../ui/ListRow";
import { Skeleton } from "../ui/Skeleton";

/**
 * The project's other chats and tasks (roadmap module 11, lane D; module 06's list, moved off the page into
 * its Chats tab): every agent's, newest first, the Lead left out (it's the page itself). "New chat" turns
 * the page's middle into a new chat in the project.
 */
export function ProjectChats({ project }: { project: Project }) {
  const conversations = useStore((s) => s.conversations);
  const state = useStore((s) => s.conversationsState);
  const agents = useStore((s) => s.agents);
  const list = useMemo(
    () => conversations.filter((c) => c.projectId === project.id && !c.lead).sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt)),
    [conversations, project.id],
  );
  const now = useNow(true, 60_000);

  return (
    <div className="space-y-1">
      {!project.archived && (
        <button type="button" onClick={() => setNewProjectChat(true)} className={listRowClass()}>
          <SquarePen className="size-4 shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1 truncate">New chat in {project.name}</span>
        </button>
      )}
      {state === "loading" && list.length === 0 ? (
        <div aria-busy="true" aria-label="Loading chats" className="space-y-3 px-2.5 pt-3">
          {[64, 48, 56].map((width) => (
            <Skeleton key={width} className="h-4" style={{ width: `${width}%` }} />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState size="sm" variant="dashed" className="mt-2" description={`Chats and tasks in ${project.name} show up here, from every agent.`} />
      ) : (
        <ul className="space-y-px">
          {list.map((conversation) => (
            <li key={conversation.id}>
              <ProjectChatRow conversation={conversation} agent={agents.find((a) => a.id === conversation.agentId)} now={now} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProjectChatRow({ conversation, agent, now }: { conversation: Conversation; agent: Agent | undefined; now: number }) {
  const streaming = useStore((s) => Boolean(s.activeRuns[conversation.id]));
  const title = conversationTitle(conversation);
  const task = isTask(conversation) ? conversation.task : null;
  const key = conversation.origin?.key;
  const working = streaming || task?.status === "running";

  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigateToConversation(conversation.id);
  };

  return (
    <a
      href={conversationPath(conversation.id)}
      onClick={open}
      title={title}
      className="flex h-10 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-sm text-fg transition-colors hover:bg-hover focus-visible:-outline-offset-2"
    >
      <span className="grid size-6 shrink-0 place-items-center" title={agent?.name}>
        {agent ? (
          <Mascot spec={agent.mascot} size={22} state={working ? "working" : "idle"} title={agent.name} />
        ) : (
          <span className="size-5 rounded-full bg-fill" />
        )}
      </span>
      <span className={clsx("min-w-0 flex-1 truncate", task && !isOpenTask(task.status) && "text-fg-muted")}>{title}</span>
      {key && <Badge className="font-mono max-sm:hidden">{key}</Badge>}
      {task && (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-fg-subtle" title={TASK_STATUS_LABELS[task.status]}>
          <TaskDot status={task.status} />
        </span>
      )}
      <span className="w-10 shrink-0 text-right text-xs text-fg-subtle tabular-nums">{shortTime(conversation.updatedAt, now)}</span>
    </a>
  );
}
