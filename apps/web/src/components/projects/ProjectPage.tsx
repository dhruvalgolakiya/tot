import { useMemo, useState } from "react";
import type { Project } from "@shared/types";
import { useAttachments } from "../../hooks/useAttachments";
import { useNow } from "../../hooks/useNow";
import { conversationTitle } from "../../lib/conversations";
import { toMs } from "../../lib/format";
import { PROJECT_ICONS, shortTime, sourceLabel, useProjects } from "../../lib/projects";
import { isTask } from "../../lib/tasks";
import { navigateToAgentHome, navigateToConversation, selectActiveAgent, useStore } from "../../store";
import { Composer } from "../Composer";
import { TaskStatusIcon } from "../tasks/TaskStatus";
import { LedgerGroup, ledgerRowClass } from "../ui/Ledger";
import { Working } from "../ui/Working";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { Skeleton } from "../ui/Skeleton";
import { FolderConsentDialog } from "./FolderConsent";

/**
 * A project's page (roadmap module 11), like a Cursor project: its name, a composer that starts a new chat in it
 * (where it works: main checkout or a new worktree), and its chats from every agent, newest first. The project's
 * Lead is optional: started from the project menu, it's then one of these chats. Repos and Knowledge are in the
 * menu too. Mounted in the main column while `page === "project"` (see App.tsx).
 */
export function ProjectPage() {
  const projectId = useStore((s) => s.projectId);
  const agent = useStore(selectActiveAgent);
  const project = useProjects((s) => s.projects.find((p) => p.id === projectId));
  const state = useProjects((s) => s.state);

  if (project) return <ProjectHome key={project.id} project={project} />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pt-20 pb-12 sm:px-6 md:pt-24">
        {state === "loading" ? (
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

/** The project's name and source, a composer for a new chat in it, and its chats. */
function ProjectHome({ project }: { project: Project }) {
  const attachments = useAttachments(project.deviceId ?? null);
  const [consentOpen, setConsentOpen] = useState(false);
  const Icon = PROJECT_ICONS[project.kind];

  const notice = project.archived ? (
    <Callout className="mb-2">This project is archived. Its chats stay here, but nothing new starts in it.</Callout>
  ) : project.kind === "folder" && !project.folderGranted ? (
    <Callout
      className="mb-2"
      action={
        <button type="button" onClick={() => setConsentOpen(true)} className="link-muted">
          Allow…
        </button>
      }
    >
      Agents can't work in this folder until you allow it.
    </Callout>
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col px-3 pt-24 pb-10 sm:px-4 md:pt-32">
        <div className="mb-6 flex flex-col items-center text-center">
          <Icon aria-hidden="true" className="size-6 text-fg-muted" />
          <h1 className="mt-3 font-display text-3xl font-semibold text-balance text-fg-strong">{project.name}</h1>
          <p className="mt-1.5 max-w-md truncate text-sm text-fg-muted" title={project.source ?? undefined}>
            {sourceLabel(project)}
          </p>
        </div>
        {notice}
        {!project.archived && <Composer attachments={attachments} placeholder={`New chat in ${project.name}`} />}
        <ProjectChats project={project} />
      </div>
      <FolderConsentDialog project={project} open={consentOpen} onOpenChange={setConsentOpen} />
    </div>
  );
}

/** Every agent's chats and top-level tasks in the project (the Lead too, if it was started), newest first. */
function ProjectChats({ project }: { project: Project }) {
  const conversations = useStore((s) => s.conversations);
  const activeRuns = useStore((s) => s.activeRuns);
  const now = useNow(true, 60_000);
  const list = useMemo(
    () =>
      conversations
        .filter((c) => c.projectId === project.id && !(isTask(c) && c.parentId))
        .sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt)),
    [conversations, project.id],
  );
  if (!list.length) return null;
  return (
    <LedgerGroup title="Chats" count={list.length} body="rows" className="mt-10">
      <ul>
        {list.map((chat) => (
          <li key={chat.id}>
            <button type="button" onClick={() => navigateToConversation(chat.id)} className={ledgerRowClass({ interactive: true })}>
              {isTask(chat) ? (
                <TaskStatusIcon status={chat.task.status} className="-mx-0.5" />
              ) : activeRuns[chat.id] ? (
                <Working label="Replying" />
              ) : null}
              <span className="min-w-0 flex-1 truncate text-ui text-fg">{conversationTitle(chat)}</span>
              <span className="shrink-0 text-xs text-fg-subtle tabular-nums">{shortTime(toMs(chat.updatedAt), now)}</span>
            </button>
          </li>
        ))}
      </ul>
    </LedgerGroup>
  );
}
