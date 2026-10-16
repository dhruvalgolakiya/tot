import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown, GitBranch, Laptop } from "lucide-react";
import type { ChatWorkspaceMode } from "@shared/types";
import { isCodeProject, useProjects } from "../../lib/projects";
import { setDraftWorkspace, useStore } from "../../store";

const OPTIONS: { mode: ChatWorkspaceMode; label: string; Icon: typeof Laptop }[] = [
  { mode: "checkout", label: "Main checkout", Icon: Laptop },
  { mode: "worktree", label: "New worktree", Icon: GitBranch },
];

/**
 * Where a new chat in a code project works, next to the project picker (like T3 Code): the project's main
 * checkout, or a worktree of its own on a new tot/… branch, made when the first message is sent.
 */
export function WorkspacePicker({ projectId }: { projectId: string | null }) {
  const workspace = useStore((s) => s.draftWorkspace);
  const project = useProjects((s) => (projectId ? s.projects.find((p) => p.id === projectId) : undefined));
  // A folder the user hasn't let agents into yet has nowhere to work.
  if (!project || !isCodeProject(project) || (project.kind === "folder" && !project.folderGranted)) return null;
  const picked = OPTIONS.find((option) => option.mode === workspace) ?? OPTIONS[0]!;

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        aria-label={`Works in: ${picked.label}`}
        className="flex h-9 min-w-0 items-center gap-1.5 rounded-full px-3 text-ui font-medium text-fg-muted transition-colors outline-none hover:bg-hover hover:text-fg focus-visible:bg-hover data-[state=open]:bg-hover data-[state=open]:text-fg"
      >
        <picked.Icon className="size-3.5 shrink-0" />
        <span className="truncate">{picked.label}</span>
        <ChevronDown className="size-3.5 shrink-0 text-fg-subtle" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className="menu w-56">
          <DropdownMenu.Label className="px-2.5 pt-1.5 pb-1 text-xs text-fg-subtle">Work in</DropdownMenu.Label>
          {OPTIONS.map(({ mode, label, Icon }) => (
            <DropdownMenu.Item key={mode} className="menu-item" onSelect={() => setDraftWorkspace(mode)}>
              <Icon className="size-4 text-fg-muted" />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {picked.mode === mode && <Check className="size-4 text-fg-muted" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
