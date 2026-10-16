import { useMemo, type ReactNode } from "react";
import { DropdownMenu } from "radix-ui";
import { Check, ChevronRight, FolderInput, Minus } from "lucide-react";
import type { Conversation, Project } from "@tot/shared/types";
import { PROJECT_ICONS, useProjects } from "../../lib/projects";
import { deviceOf } from "../../lib/devices";
import { moveToProject } from "../../store";

/** Projects a chat can move to: on its agent's device (module 07), and not archived. */
function useLiveProjects(chat: Conversation): Project[] {
  const projects = useProjects((s) => s.projects);
  const device = deviceOf(chat.agentId) ?? undefined;
  return useMemo(() => projects.filter((p) => !p.archived && p.deviceId === device), [projects, device]);
}

/** Not for tasks (they move with their chat), nor while there's nowhere to move the chat to. */
function canMove(chat: Conversation, live: Project[]): boolean {
  return chat.kind !== "task" && (live.length > 0 || chat.projectId !== null);
}

const choicesClass = "menu max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] w-52 overflow-y-auto";

/** "Move to project" in a chat's "…" menu: a submenu of projects plus "No project". */
export function MoveToProjectSub({ chat }: { chat: Conversation }) {
  const live = useLiveProjects(chat);
  if (!canMove(chat, live)) return null;

  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className="menu-item data-[state=open]:bg-hover">
        <FolderInput className="size-4 text-fg-muted" />
        <span className="flex-1">Move to project</span>
        <ChevronRight className="size-4 text-fg-subtle" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent sideOffset={6} alignOffset={-4} collisionPadding={8} className={choicesClass}>
          <ProjectChoices chat={chat} live={live} />
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

/** The same choices behind a quiet text action, e.g. "Move" on a "Filed under web" notice. */
export function MoveToProjectButton({ chat, children, className }: { chat: Conversation; children: ReactNode; className?: string }) {
  const live = useLiveProjects(chat);
  if (!canMove(chat, live)) return null;

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={className}>
          {children}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} collisionPadding={8} className={choicesClass}>
          <DropdownMenu.Label className="menu-label">Move to project</DropdownMenu.Label>
          <ProjectChoices chat={chat} live={live} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ProjectChoices({ chat, live }: { chat: Conversation; live: Project[] }) {
  return (
    <DropdownMenu.RadioGroup value={chat.projectId ?? ""} onValueChange={(value) => void moveToProject(chat.id, value || null)}>
      {live.map((project) => {
        const Icon = PROJECT_ICONS[project.kind];
        return (
          <DropdownMenu.RadioItem key={project.id} value={project.id} className="menu-item">
            <Icon className="size-4 shrink-0 text-fg-muted" />
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            <Indicator />
          </DropdownMenu.RadioItem>
        );
      })}
      {live.length > 0 && <DropdownMenu.Separator className="menu-separator" />}
      <DropdownMenu.RadioItem value="" className="menu-item">
        <Minus className="size-4 shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate">No project</span>
        <Indicator />
      </DropdownMenu.RadioItem>
    </DropdownMenu.RadioGroup>
  );
}

function Indicator() {
  return (
    <span className="grid size-4 shrink-0 place-items-center">
      <DropdownMenu.ItemIndicator>
        <Check className="size-4 text-fg" />
      </DropdownMenu.ItemIndicator>
    </span>
  );
}
