import { useMemo, useState, type MouseEvent } from "react";
import clsx from "clsx";
import type { Agent, Conversation, Project } from "@shared/types";
import { useAttachments } from "../../hooks/useAttachments";
import { useNow } from "../../hooks/useNow";
import { conversationTitle } from "../../lib/conversations";
import { toMs } from "../../lib/format";
import { PROJECT_ICONS, shortTime, sourceLabel, useProjects } from "../../lib/projects";
import { conversationPath } from "../../lib/router";
import { isOpenTask, isTask, TASK_STATUS_LABELS } from "../../lib/tasks";
import { navigateToAgentHome, navigateToConversation, selectActiveAgent, useStore } from "../../store";
import { Composer } from "../Composer";
import { Mascot } from "../mascot";
import { ProjectMemoryRow } from "../memory/ProjectMemoryRow";
import { TaskDot } from "../tasks/TaskStatus";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { Skeleton } from "../ui/Skeleton";
import { FolderConsentDialog } from "./FolderConsent";
import { ProjectMenu } from "./ProjectMenu";

/**
 * A project's page: its name, where its files are and its one "…" menu; a composer that starts a
 * chat in it with the agent selected in the rail; and every agent's chats and tasks in it.
 * Mounted in the main column in place of ChatView while `page === "project"` (see App.tsx).
 */
export function ProjectPage() {
  const projectId = useStore((s) => s.projectId);
  const agent = useStore(selectActiveAgent);
  const project = useProjects((s) => s.projects.find((p) => p.id === projectId));
  const state = useProjects((s) => s.state);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pt-20 pb-12 sm:px-6 md:pt-24">
        {project ? (
          <ProjectContent project={project} agent={agent} />
        ) : state === "loading" ? (
          <div aria-busy="true" aria-label="Loading the project" className="space-y-4">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-16 rounded-3xl" />
          </div>
        ) : (
          <EmptyState
            title="This project isn't here anymore"
            description="It may have been removed, or the link is wrong."
            action={
              agent && (
                <Button size="sm" onClick={() => navigateToAgentHome(agent.id)}>
                  Back to {agent.name}
                </Button>
              )
            }
          />
        )}
      </div>
    </div>
  );
}

function ProjectContent({ project, agent }: { project: Project; agent: Agent | undefined }) {
  const attachments = useAttachments(project.deviceId ?? null);
  const [consentOpen, setConsentOpen] = useState(false);
  const Icon = PROJECT_ICONS[project.kind];

  return (
    <>
      <header className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="flex min-w-0 items-center gap-2.5 text-title text-fg-strong">
            <Icon aria-hidden="true" className="size-5 shrink-0 text-fg-muted" />
            <span className="truncate">{project.name}</span>
          </h1>
          <span
            title={project.source ?? undefined}
            className="inline-flex h-6 max-w-full min-w-0 items-center truncate rounded-full bg-fill px-2.5 text-xs text-fg-muted"
          >
            <span className="truncate">{sourceLabel(project)}</span>
          </span>
        </div>
        <ProjectMenu project={project} agent={agent} />
      </header>

      {project.archived ? (
        <Callout className="mt-6">This project is archived. Its chats stay here, but new ones can't start in it.</Callout>
      ) : (
        project.kind === "folder" &&
        !project.folderGranted && (
          <Callout
            className="mt-6"
            action={
              <button type="button" onClick={() => setConsentOpen(true)} className="link-muted">
                Allow…
              </button>
            }
          >
            Agents can't work in this folder until you allow it.
          </Callout>
        )
      )}

      {!project.archived && (
        <div className="mt-6">
          <Composer attachments={attachments} placeholder={`New chat in ${project.name}…`} />
        </div>
      )}

      {/* Memory repo (module 10): what agents learned in this project. */}
      <ProjectMemoryRow project={project} />
      <ProjectChats project={project} />
      <FolderConsentDialog project={project} open={consentOpen} onOpenChange={setConsentOpen} />
    </>
  );
}

/** Every agent's chats and tasks in the project, newest first: the one place to see everything going on in it. */
function ProjectChats({ project }: { project: Project }) {
  const conversations = useStore((s) => s.conversations);
  const state = useStore((s) => s.conversationsState);
  const agents = useStore((s) => s.agents);
  const list = useMemo(
    () => conversations.filter((c) => c.projectId === project.id).sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt)),
    [conversations, project.id],
  );
  const now = useNow(true, 60_000);

  return (
    <section aria-labelledby="project-chats" className="mt-10">
      <h2 id="project-chats" className="group-label px-2.5 pb-1">
        Chats and tasks
      </h2>
      {state === "loading" && list.length === 0 ? (
        <div aria-busy="true" aria-label="Loading chats" className="space-y-3 px-2.5 pt-2">
          {[64, 48, 56].map((width) => (
            <Skeleton key={width} className="h-4" style={{ width: `${width}%` }} />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          size="sm"
          variant="dashed"
          className="mt-1"
          description={`Chats and tasks in ${project.name} show up here, from every agent.`}
        />
      ) : (
        <ul className="space-y-px">
          {list.map((conversation) => (
            <li key={conversation.id}>
              <ProjectChatRow conversation={conversation} agent={agents.find((a) => a.id === conversation.agentId)} now={now} />
            </li>
          ))}
        </ul>
      )}
    </section>
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
      className="flex h-11 w-full min-w-0 items-center gap-3 rounded-lg px-2.5 text-sm text-fg transition-colors hover:bg-hover focus-visible:-outline-offset-2"
    >
      <span className="grid size-6 shrink-0 place-items-center" title={agent?.name}>
        {agent ? (
          <Mascot spec={agent.mascot} size={24} state={working ? "working" : "idle"} title={agent.name} />
        ) : (
          <span className="size-5 rounded-full bg-fill" />
        )}
      </span>
      <span className={clsx("min-w-0 flex-1 truncate", task && !isOpenTask(task.status) && "text-fg-muted")}>{title}</span>
      {key && <Badge className="font-mono max-sm:hidden">{key}</Badge>}
      {task && (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-fg-subtle">
          <TaskDot status={task.status} />
          <span className="max-sm:hidden">{TASK_STATUS_LABELS[task.status]}</span>
        </span>
      )}
      <span className="w-12 shrink-0 text-right text-xs text-fg-subtle tabular-nums">{shortTime(conversation.updatedAt, now)}</span>
    </a>
  );
}
