import { useMemo } from "react";
import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown, MessageCircle } from "lucide-react";
import { PROJECT_ICONS, useProjects } from "../../lib/projects";
import { selectActiveAgent, setDraftProject, useStore } from "../../store";

/**
 * Where a new chat starts, in the composer of a chat not sent yet (like T3 Code's thread target): no project, or one
 * of the agent's device's projects. A chat in a project works in its folder or repos, with its instructions and
 * knowledge.
 */
export function ProjectPicker() {
  const draftProjectId = useStore((s) => s.draftProjectId);
  const deviceId = useStore((s) => selectActiveAgent(s)?.deviceId);
  const all = useProjects((s) => s.projects);
  const projects = useMemo(() => all.filter((p) => !p.archived && p.deviceId === deviceId), [all, deviceId]);
  const picked = projects.find((p) => p.id === draftProjectId) ?? null;
  if (projects.length === 0) return null;
  const Icon = picked ? PROJECT_ICONS[picked.kind] : MessageCircle;

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        aria-label={picked ? `Starts in ${picked.name}` : "No project"}
        className="flex h-9 min-w-0 items-center gap-1.5 rounded-full px-3 text-ui font-medium text-fg-muted transition-colors outline-none hover:bg-hover hover:text-fg focus-visible:bg-hover data-[state=open]:bg-hover data-[state=open]:text-fg"
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="max-w-44 truncate">{picked ? picked.name : "No project"}</span>
        <ChevronDown className="size-3.5 shrink-0 text-fg-subtle" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className="menu w-64">
          <DropdownMenu.Label className="px-2.5 pt-1.5 pb-1 text-xs text-fg-subtle">Start this chat in</DropdownMenu.Label>
          <DropdownMenu.Item className="menu-item" onSelect={() => setDraftProject(null)}>
            <MessageCircle className="size-4 text-fg-muted" />
            <span className="min-w-0 flex-1 truncate">No project</span>
            {!picked && <Check className="size-4 text-fg-muted" />}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="menu-separator" />
          {projects.map((project) => {
            const ProjectIcon = PROJECT_ICONS[project.kind];
            return (
              <DropdownMenu.Item key={project.id} className="menu-item" onSelect={() => setDraftProject(project.id)}>
                <ProjectIcon className="size-4 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {picked?.id === project.id && <Check className="size-4 text-fg-muted" />}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
