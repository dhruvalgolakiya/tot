import type { ReactNode } from "react";
import clsx from "clsx";
import { Tabs } from "radix-ui";
import type { Project } from "@shared/types";
import { XL_QUERY, useMediaQuery } from "../../hooks/useMediaQuery";
import { PROJECT_TABS, setProjectTab, useLeadUi, type ProjectTab } from "../../lib/lead";
import { useProjects } from "../../lib/projects";
import { useStore } from "../../store";
import { KnowledgePanel } from "../knowledge/KnowledgePanel";
import { KnowledgeUpdates } from "../knowledge/KnowledgeUpdates";
import { ProjectMemoryRow } from "../memory/ProjectMemoryRow";
import { ProjectBoard } from "./ProjectBoard";
import { ProjectChats } from "./ProjectChats";
import { ProjectRepos } from "./ProjectRepos";

/**
 * The project page's side (roadmap module 11, lane D): Board (its mission control, compact), Chats (its
 * other chats and tasks), Knowledge (lane B's panel and lane C's updates) and Repos (lane A's list). Docked
 * beside the Lead on wide screens (ProjectPanel); on narrower ones the same tabs sit above the chat
 * (ProjectPage), with the Lead as the first.
 */

/** Underline tabs (DESIGN.md: side panel tabs), neutral. */
export const tabTrigger =
  "relative -mb-px flex h-10 shrink-0 items-center border-b-2 border-transparent px-2.5 text-sm text-fg-muted outline-none transition-colors " +
  "hover:text-fg focus-visible:text-fg data-[state=active]:border-fg data-[state=active]:text-fg";

/** Wide enough to show the side beside the Lead; narrower screens get tabs above the chat. */
export const useDockedSide = () => useMediaQuery(XL_QUERY);

export function ProjectTabContent({ project, tab }: { project: Project; tab: ProjectTab }): ReactNode {
  if (tab === "board") return <ProjectBoard project={project} />;
  if (tab === "chats") return <ProjectChats project={project} />;
  if (tab === "repos") return <ProjectRepos project={project} />;
  return (
    <div className="space-y-6">
      <KnowledgePanel project={project} />
      <KnowledgeUpdates project={project} />
      {/* Module 10's memory row, until the Knowledge panel's Facts replace it. */}
      <ProjectMemoryRow project={project} />
    </div>
  );
}

/** The tab row: the side's tabs, and on phones the Lead before them. */
export function ProjectTabList({ withLead = false, className }: { withLead?: boolean; className?: string }) {
  return (
    <Tabs.List aria-label="Project" className={clsx("flex shrink-0 gap-0.5 overflow-x-auto border-b border-hairline px-3", className)}>
      {withLead && (
        <Tabs.Trigger value="lead" className={tabTrigger}>
          Lead
        </Tabs.Trigger>
      )}
      {PROJECT_TABS.map((tab) => (
        <Tabs.Trigger key={tab.id} value={tab.id} className={tabTrigger}>
          {tab.label}
        </Tabs.Trigger>
      ))}
    </Tabs.List>
  );
}

/** The side docked beside the Lead on wide screens; it steps aside while another panel (the computer, a task, settings) is open. */
export function ProjectPanel() {
  const docked = useDockedSide();
  const projectId = useStore((s) => (s.page === "project" ? s.projectId : null));
  const otherPanel = useStore((s) => s.computerPanelOpen || s.taskPanelOpen || s.agentSettingsOpen);
  const project = useProjects((s) => (projectId ? s.projects.find((p) => p.id === projectId) : undefined));
  const tab = useLeadUi((s) => s.tab);
  if (!docked || !project || otherPanel) return null;

  return (
    <aside
      aria-label={`${project.name}: board, chats, knowledge and repos`}
      className="relative my-2 mr-2 flex w-[400px] shrink-0 flex-col overflow-hidden rounded-lg border border-hairline bg-canvas"
    >
      <Tabs.Root value={tab} onValueChange={(value) => setProjectTab(value as ProjectTab)} className="flex min-h-0 flex-1 flex-col">
        <ProjectTabList className="app-drag-region h-14 items-end" />
        {PROJECT_TABS.map((t) => (
          <Tabs.Content key={t.id} value={t.id} className="min-h-0 flex-1 overflow-y-auto p-4 outline-none">
            <ProjectTabContent project={project} tab={t.id} />
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </aside>
  );
}
