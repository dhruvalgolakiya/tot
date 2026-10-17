import { useMemo } from "react";
import { Archive } from "lucide-react";
import type { Conversation } from "@tot/shared/types";
import { conversationTitle, groupConversations, listedChats } from "../lib/conversations";
import { setArchivedOpen } from "../lib/organize";
import { useProjects } from "../lib/projects";
import { isTask } from "../lib/tasks";
import { loadConversations, selectActiveAgentId, useStore } from "../store";
import { ConversationItem } from "./ConversationItem";
import { PinnedChats } from "./PinnedChats";
import { ProjectsSection } from "./projects/ProjectsSection";
import { TaskList } from "./tasks/TaskList";
import { Callout } from "./ui/Callout";
import { EmptyState } from "./ui/EmptyState";
import { listRowClass } from "./ui/ListRow";
import { Skeleton } from "./ui/Skeleton";

export function ConversationList({ query = "" }: { query?: string }) {
  const conversations = useStore((s) => s.conversations);
  const state = useStore((s) => s.conversationsState);
  const currentId = useStore((s) => s.currentId);
  // The chats with a run streaming, as one string: runs' other changes (a message id, stopping) don't re-render the list.
  const streamingIds = useStore((s) => Object.keys(s.activeRuns).join(" "));
  const streaming = useMemo(() => new Set(streamingIds.split(" ")), [streamingIds]);
  const activeAgentId = useStore(selectActiveAgentId);
  const projects = useProjects((s) => s.projects);
  const projectsState = useProjects((s) => s.state);
  // Chats in a project are listed under it (Projects, above); an archived project's chats come back here.
  const filed = useMemo(() => new Set(projects.filter((p) => !p.archived).map((p) => p.id)), [projects]);
  const inProject = (c: { projectId: string | null }) =>
    Boolean(c.projectId) && (projectsState === "loading" || filed.has(c.projectId!));
  // Tasks have their own group above the chats; archived and snoozed chats are behind the link at the bottom.
  const { agentChats, looseChats, hidden } = useMemo(
    () => listedChats(conversations, activeAgentId, { projects, state: projectsState }),
    [conversations, activeAgentId, projects, projectsState],
  );
  const groups = useMemo(() => groupConversations(looseChats, query), [looseChats, query]);
  // Nothing to show below the projects: say so only when the projects don't hold this agent's chats (or matches) either.
  const needle = query.trim().toLowerCase();
  const shownAbove = needle
    ? agentChats.some((c) => inProject(c) && conversationTitle(c).toLowerCase().includes(needle)) ||
      projects.some((p) => !p.archived && p.name.toLowerCase().includes(needle))
    : agentChats.length > looseChats.length;
  /** Chats with tasks still working: they show a count. */
  const workingTasks = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of conversations) {
      if (isTask(c) && c.parentId && (c.task.status === "running" || c.task.status === "needs-input")) {
        counts.set(c.parentId, (counts.get(c.parentId) ?? 0) + 1);
      }
    }
    return counts;
  }, [conversations]);

  const renderItem = (conversation: Conversation) => (
    <ConversationItem
      conversation={conversation}
      active={conversation.id === currentId}
      streaming={streaming.has(conversation.id)}
      workingTasks={workingTasks.get(conversation.id) ?? 0}
    />
  );

  return (
    <nav aria-label="Chat history" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      <ProjectsSection query={query} />
      <TaskList query={query} />

      {state === "loading" && conversations.length === 0 && (
        <div className="space-y-2 px-2.5 pt-4" aria-busy="true" aria-label="Loading chats">
          {[72, 56, 64, 48, 60].map((width) => (
            <Skeleton key={width} className="h-3.5" style={{ width: `${width}%` }} />
          ))}
        </div>
      )}

      {state === "error" && conversations.length === 0 && (
        <div className="px-2.5 pt-4">
          <Callout
            tone="danger"
            action={
              <button type="button" onClick={() => void loadConversations()} className="link-muted">
                Retry
              </button>
            }
          >
            Couldn't load your chats.
          </Callout>
        </div>
      )}

      {state === "ready" && groups.length === 0 && !shownAbove && (
        <EmptyState
          size="sm"
          description={query.trim() ? `No chats match “${query.trim()}”` : "Your chats will show up here."}
        />
      )}

      {groups.map((group) => (
        <section key={group.label} className="mt-4 first:mt-2">
          <h2 className="group-label px-2.5 pb-1">{group.label}</h2>
          {group.label === "Pinned" && !query.trim() ? (
            <PinnedChats items={group.items}>{renderItem}</PinnedChats>
          ) : (
            <ul className="space-y-px">
              {group.items.map((conversation) => (
                <li key={conversation.id}>{renderItem(conversation)}</li>
              ))}
            </ul>
          )}
        </section>
      ))}

      {hidden.length > 0 && (
        <button
          type="button"
          onClick={() => setArchivedOpen(true)}
          className={listRowClass({ size: "sm", className: "mt-4 text-ui text-fg-muted hover:text-fg" })}
        >
          <Archive className="size-4 shrink-0 text-fg-subtle" />
          <span className="min-w-0 flex-1 truncate">{hiddenLabel(hidden)}</span>
          <span className="shrink-0 text-xs text-fg-subtle tabular-nums">{hidden.length}</span>
        </button>
      )}
    </nav>
  );
}

/** The link to the archived and snoozed chats: named after what's there. */
function hiddenLabel(hidden: { archivedAt?: number | null }[]): string {
  const archived = hidden.filter((c) => c.archivedAt).length;
  return archived === hidden.length ? "Archived" : archived === 0 ? "Snoozed" : "Archived and snoozed";
}
