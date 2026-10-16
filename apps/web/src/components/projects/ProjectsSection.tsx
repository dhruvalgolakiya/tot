import { useMemo, type MouseEvent } from "react";
import clsx from "clsx";
import { ChevronRight, Plus, SquarePen } from "lucide-react";
import type { Conversation, Project } from "@tot/shared/types";
import { conversationTitle } from "../../lib/conversations";
import { PROJECT_ICONS, setNewProjectOpen, toggleProjectExpanded, useProjects } from "../../lib/projects";
import { projectPath } from "../../lib/router";
import { isOpenTask, isTask } from "../../lib/tasks";
import { toMs } from "../../lib/format";
import { navigateToProject, newChatInProject, selectActiveAgent, selectActiveAgentId, selectCurrentConversation, useStore } from "../../store";
import { ConversationItem } from "../ConversationItem";
import { MissionButton } from "../mission/MissionButton";
import { TaskRow } from "../tasks/TaskRow";
import { listRowClass } from "../ui/ListRow";
import { Working } from "../ui/Working";

/** How many of a project's chats its sidebar row lists; the rest are on its page. */
const SHOWN = 8;

/**
 * "Projects", above the selected agent's chats: one row per project (shared by every agent), each
 * expanding to this agent's chats and tasks in it, a chat's open tasks one step in under it. With no
 * projects, just a quiet "New project" row.
 */
export function ProjectsSection({ query }: { query: string }) {
  const projects = useProjects((s) => s.projects);
  const expanded = useProjects((s) => s.expanded);
  const conversations = useStore((s) => s.conversations);
  const agentId = useStore(selectActiveAgentId);
  // A project's Lead is open on its page (module 11): that doesn't unfold the project's row.
  const currentProjectId = useStore((s) => {
    const current = selectCurrentConversation(s);
    return current && !current.lead ? current.projectId : null;
  });
  // On a project's page (its Lead open in the middle, module 11), its row is the current one.
  const pageProjectId = useStore((s) => (s.page === "project" ? s.projectId : null));
  const needle = query.trim().toLowerCase();

  const currentId = useStore((s) => s.currentId);

  // The active agent's device's projects (module 07): an agent works on what's on its own device.
  const agentDevice = useStore((s) => selectActiveAgent(s)?.deviceId);
  const live = useMemo(() => projects.filter((p) => !p.archived && p.deviceId === agentDevice), [projects, agentDevice]);
  /** This agent's conversations in each project, newest first; and the open tasks under each chat or task. */
  const { byProject, childrenOf, leads, leadOf } = useMemo(() => {
    const byProject = new Map<string, Conversation[]>();
    const childrenOf = new Map<string, Conversation[]>();
    // A project's Lead (module 11, optional: started from the project menu) is pinned first under it; its tasks show as the project's own.
    const leads = new Set(conversations.filter((c) => c.lead).map((c) => c.id));
    const leadOf = new Map(conversations.filter((c) => c.lead && c.projectId).map((c) => [c.projectId!, c]));
    for (const c of conversations) {
      if (!c.projectId || c.agentId !== agentId || c.lead) continue;
      byProject.set(c.projectId, [...(byProject.get(c.projectId) ?? []), c]);
      // A finished task stays on its chat's card (and the project's page), unless it's the one open.
      if (isTask(c) && c.parentId && !leads.has(c.parentId) && (isOpenTask(c.task.status) || c.id === currentId)) {
        childrenOf.set(c.parentId, [...(childrenOf.get(c.parentId) ?? []), c]);
      }
    }
    const newest = (a: Conversation, b: Conversation) => toMs(b.updatedAt) - toMs(a.updatedAt);
    for (const list of byProject.values()) list.sort(newest);
    for (const list of childrenOf.values()) list.sort(newest);
    return { byProject, childrenOf, leads, leadOf };
  }, [conversations, agentId, currentId]);

  type Row = { project: Project; lead: Conversation | null; list: Conversation[]; nested: Map<string, Conversation[]> | null; open: boolean };
  const rows = live.flatMap((project): Row[] => {
    const all = byProject.get(project.id) ?? [];
    if (!needle) {
      const top = all.filter((c) => !(isTask(c) && c.parentId && !leads.has(c.parentId)));
      return [{ project, lead: leadOf.get(project.id) ?? null, list: top, nested: childrenOf, open: expanded.has(project.id) || project.id === currentProjectId || project.id === pageProjectId }];
    }
    // Searching: every match, chats and tasks alike, without nesting.
    const matches = all.filter((c) => conversationTitle(c).toLowerCase().includes(needle));
    if (!matches.length && !project.name.toLowerCase().includes(needle)) return [];
    return [{ project, lead: null, list: matches, nested: null, open: matches.length > 0 }];
  });

  if (needle && rows.length === 0) return null;

  return (
    <section aria-label="Projects" className="mt-2 pb-2">
      {live.length > 0 && (
        <div className="group/projects flex items-center pr-1 pb-1 pl-2.5">
          <h2 className="group-label mr-auto">Projects</h2>
          {/* Mission control (module 09): the tasks in every project, on one board. */}
          <MissionButton group="projects" />
        </div>
      )}
      <ul className="space-y-px">
        {rows.map(({ project, lead, list, nested, open }) => (
          <ProjectRow
            key={project.id}
            project={project}
            lead={lead}
            agentId={agentId}
            list={list}
            nested={nested}
            open={open}
            selected={project.id === pageProjectId}
            canToggle={!needle}
          />
        ))}
        {!needle && (
          <li>
            <button type="button" onClick={() => setNewProjectOpen(true)} className={listRowClass()}>
              <Plus className="size-4 shrink-0 text-fg-subtle" />
              <span className="min-w-0 flex-1 truncate text-fg-muted">New project</span>
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}

type ProjectRowProps = {
  project: Project;
  /** The project's Lead chat, pinned first under it; null while searching or when there's none. */
  lead: Conversation | null;
  agentId: string | null;
  /** The rows to list: chats and the tasks started on their own (or, while searching, every match). */
  list: Conversation[];
  /** Open tasks to show one step in under the chat or task that started them; null while searching. */
  nested: Map<string, Conversation[]> | null;
  open: boolean;
  selected: boolean;
  canToggle: boolean;
};

/** The kind icon turns into a chevron on hover (always, on touch screens): it shows or hides the chats; the name opens the page. */
function ProjectRow({ project, lead, agentId, list, nested, open, selected, canToggle }: ProjectRowProps) {
  const currentId = useStore((s) => s.currentId);
  const activeRuns = useStore((s) => s.activeRuns);
  const Icon = PROJECT_ICONS[project.kind];
  const rows: { conversation: Conversation; depth: number }[] = [];
  const add = (conversation: Conversation, depth: number) => {
    rows.push({ conversation, depth });
    for (const child of nested?.get(conversation.id) ?? []) if (depth < 4) add(child, depth + 1);
  };
  for (const conversation of list.slice(0, SHOWN)) add(conversation, 0);

  const openPage = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigateToProject(project.id);
  };

  return (
    <li>
      <div className="group/project relative">
        <a
          href={agentId ? projectPath(agentId, project.id) : undefined}
          onClick={openPage}
          aria-current={selected && !(open && lead) ? "page" : undefined}
          title={project.name}
          className={listRowClass({ selected: selected && !(open && lead) })}
        >
          <Icon
            aria-hidden="true"
            className={clsx(
              "size-4 shrink-0 text-fg-muted transition-opacity",
              canToggle && "group-hover/project:opacity-0 group-has-[:focus-visible]/project:opacity-0 pointer-coarse:opacity-0",
            )}
          />
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
          {project.running > 0 && (
            <Working
              label={`${project.running} task${project.running === 1 ? "" : "s"} running`}
              className="group-hover/project:opacity-0 group-has-[:focus-visible]/project:opacity-0 pointer-coarse:opacity-0"
            />
          )}
        </a>
        <button
          type="button"
          aria-label={`New chat in ${project.name}`}
          title={`New chat in ${project.name}`}
          onClick={() => newChatInProject(project.id)}
          className="absolute top-1/2 right-1 grid size-7 -translate-y-1/2 place-items-center rounded-md text-fg-muted opacity-0 transition-opacity group-hover/project:opacity-100 group-has-[:focus-visible]/project:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          <SquarePen className="size-3.5" />
        </button>
        {canToggle && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? `Hide chats in ${project.name}` : `Show chats in ${project.name}`}
            onClick={() => toggleProjectExpanded(project.id, !open)}
            className="absolute top-1/2 left-1 grid size-7 -translate-y-1/2 place-items-center rounded-md text-fg-muted opacity-0 transition-opacity group-hover/project:opacity-100 group-has-[:focus-visible]/project:opacity-100 hover:text-fg focus-visible:opacity-100 pointer-coarse:opacity-100"
          >
            <ChevronRight className={clsx("size-4 transition-transform", open && "rotate-90")} />
          </button>
        )}
      </div>

      {open && (
        <ul className="space-y-px pt-px pl-6">
          {lead && (
            <li>
              <ConversationItem
                conversation={lead}
                active={lead.id === currentId}
                streaming={Boolean(activeRuns[lead.id])}
              />
            </li>
          )}
          {rows.map(({ conversation, depth }) => (
            <li key={conversation.id} className={clsx(depth > 0 && "pl-4")}>
              {isTask(conversation) ? (
                <TaskRow task={conversation} active={conversation.id === currentId} />
              ) : (
                // Its open tasks are listed right under it, so no count.
                <ConversationItem
                  conversation={conversation}
                  active={conversation.id === currentId}
                  streaming={Boolean(activeRuns[conversation.id])}
                />
              )}
            </li>
          ))}
          {list.length === 0 && !lead && <li className="flex h-8 items-center px-2.5 text-xs text-fg-subtle">No chats yet</li>}
          {list.length > SHOWN && (
            <li>
              <button
                type="button"
                onClick={() => navigateToProject(project.id)}
                className="flex h-8 w-full items-center rounded-lg px-2.5 text-xs text-fg-subtle transition-colors hover:bg-hover hover:text-fg-muted"
              >
                Show all · {list.length}
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}
