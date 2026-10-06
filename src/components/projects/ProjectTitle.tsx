import type { Project } from "@shared/types";
import { PROJECT_ICONS, sourceLabel } from "../../lib/projects";

/**
 * The project's name, and where its files are, in the header of its page (roadmap module 11, lane D): the
 * page is its Lead chat, so this stands where a chat's crumb would. Phones show just the name.
 */
export function ProjectTitle({ project }: { project: Project }) {
  const Icon = PROJECT_ICONS[project.kind];
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
      <h1 className="flex min-w-0 items-center gap-2 text-sm font-medium text-fg">
        <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-muted max-sm:hidden" />
        <span className="truncate">{project.name}</span>
      </h1>
      <span
        title={project.source ?? undefined}
        className="inline-flex h-6 min-w-0 items-center truncate rounded-full bg-fill px-2.5 text-xs text-fg-muted max-lg:hidden"
      >
        <span className="truncate">{sourceLabel(project)}</span>
      </span>
    </div>
  );
}
