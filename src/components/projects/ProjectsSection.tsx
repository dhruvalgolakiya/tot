import { useMemo, type MouseEvent } from "react";
import clsx from "clsx";
import { ChevronRight, Plus } from "lucide-react";
import type { Conversation, Project } from "@shared/types";
import { conversationTitle } from "../../lib/conversations";
import { PROJECT_ICONS, setNewProjectOpen, toggleProjectExpanded, useProjects } from "../../lib/projects";
import { projectPath } from "../../lib/router";
import { isTask } from "../../lib/tasks";
import { toMs } from "../../lib/format";
import { navigateToProject, selectActiveAgentId, selectCurrentConversation, useStore } from "../../store";
import { ConversationItem } from "../ConversationItem";
import { TaskRow } from "../tasks/TaskRow";
import { listRowClass } from "../ui/ListRow";
import { StatusDot } from "../ui/StatusDot";

/** How many of a project's chats its sidebar row lists; the rest are on its page. */
const SHOWN = 8;

type ProjectsSectionProps = {
  query: string;
  /** Chats with tasks still working, and how many (from the chat list). */
  workingTasks: Map<string, number>;
};

/**
 * "Projects", above the selected agent's chats: one row per project (shared by every agent), each
 * expanding to this agent's chats and tasks in it. With no projects, just a quiet "New project" row.
 */
export function ProjectsSection({ query, workingTasks }: ProjectsSectionProps) {
  const projects = useProjects((s) => s.projects);
  const expanded = useProjects((s) => s.expanded);
  const conversations = useStore((s) => s.conversations);
  const agentId = useStore(selectActiveAgentId);
  const currentProjectId = useStore((s) => selectCurrentConversation(s)?.projectId ?? null);
  const pageProjectId = useStore((s) => (s.page === "project" && s.currentId === null ? s.projectId : null));
  const needle = query.trim().toLowerCase();

  const live = useMemo(() => projects.filter((p) => !p.archived), [projects]);
  /** This agent's chats in each project, and the tasks it started there on their own; newest first. */
  const items = useMemo(() => {
    const byProject = new Map<string, Conversation[]>();
    for (const c of conversations) {
      if (!c.projectId || c.agentId !== agentId) continue;
      if (isTask(c) && c.parentId) continue; // A chat's tasks show as its count.
      byProject.set(c.projectId, [...(byProject.get(c.projectId) ?? []), c]);
    }
    for (const list of byProject.values()) list.sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt));
    return byProject;
  }, [conversations, agentId]);

  const rows = live.flatMap((project) => {
    const all = items.get(project.id) ?? [];
    if (!needle) return [{ project, list: all, open: expanded.has(project.id) || project.id === currentProjectId }];
    const matches = all.filter((c) => conversationTitle(c).toLowerCase().includes(needle));
    if (!matches.length && !project.name.toLowerCase().includes(needle)) return [];
    return [{ project, list: matches, open: matches.length > 0 }];
  });

  if (needle && rows.length === 0) return null;

  return (
    <section aria-label="Projects" className="mt-2 pb-2">
      {live.length > 0 && <h2 className="group-label px-2.5 pb-1">Projects</h2>}
      <ul className="space-y-px">
        {rows.map(({ project, list, open }) => (
          <ProjectRow
            key={project.id}
            project={project}
            agentId={agentId}
            list={list}
            open={open}
            selected={project.id === pageProjectId}
            canToggle={!needle}
            workingTasks={workingTasks}
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
  agentId: string | null;
  list: Conversation[];
  open: boolean;
  selected: boolean;
  canToggle: boolean;
  workingTasks: Map<string, number>;
};

/** The kind icon turns into a chevron on hover (always, on touch screens): it shows or hides the chats; the name opens the page. */
function ProjectRow({ project, agentId, list, open, selected, canToggle, workingTasks }: ProjectRowProps) {
  const currentId = useStore((s) => s.currentId);
  const activeRuns = useStore((s) => s.activeRuns);
  const Icon = PROJECT_ICONS[project.kind];
  const shown = list.slice(0, SHOWN);

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
          aria-current={selected ? "page" : undefined}
          title={project.name}
          className={listRowClass({ selected })}
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
            <span
              title={`${project.running} task${project.running === 1 ? "" : "s"} running`}
              className="flex shrink-0 items-center gap-1.5 text-xs text-fg-subtle tabular-nums"
            >
              <StatusDot tone="green" pulse />
              {project.running}
            </span>
          )}
        </a>
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
          {shown.map((conversation) => (
            <li key={conversation.id}>
              {isTask(conversation) ? (
                <TaskRow task={conversation} active={conversation.id === currentId} />
              ) : (
                <ConversationItem
                  conversation={conversation}
                  active={conversation.id === currentId}
                  streaming={Boolean(activeRuns[conversation.id])}
                  workingTasks={workingTasks.get(conversation.id) ?? 0}
                />
              )}
            </li>
          ))}
          {list.length === 0 && <li className="flex h-8 items-center px-2.5 text-xs text-fg-subtle">No chats yet</li>}
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
