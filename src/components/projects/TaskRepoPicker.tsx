import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import type { ProjectRepo } from "@shared/types";
import { repoSourceLabel } from "../../lib/project-repos";
import { PROJECT_ICONS } from "../../lib/projects";
import { Tip } from "../ui/Tip";

/**
 * Module 11 (lane A): which of the project's repos a task from the composer works in, as a pill next to
 * Task. Only shown in a project with several repos; `value` null is the primary. A folder not allowed yet
 * is listed but can't be picked.
 */
export function TaskRepoPicker({
  repos,
  value,
  onChange,
  className,
}: {
  repos: ProjectRepo[];
  value: string | null;
  onChange: (name: string) => void;
  className: string;
}) {
  const current = repos.find((repo) => repo.name === value) ?? repos.find((repo) => repo.primary) ?? repos[0];
  if (!current) return null;
  const Icon = PROJECT_ICONS[current.kind];

  return (
    <DropdownMenu.Root modal={false}>
      <Tip content="The repo the task works in">
        <DropdownMenu.Trigger asChild>
          <button type="button" aria-label={`Repo: ${current.name}`} className={className}>
            <Icon className="size-3.5" />
            <span className="max-w-28 truncate">{current.name}</span>
            <ChevronDown className="size-3.5 text-fg-subtle" />
          </button>
        </DropdownMenu.Trigger>
      </Tip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="top" align="start" sideOffset={6} className="menu w-64">
          <DropdownMenu.Label className="menu-label">Run the task in</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={current.name} onValueChange={onChange}>
            {repos.map((repo) => {
              const RepoIcon = PROJECT_ICONS[repo.kind];
              // A folder the user hasn't allowed yet can't take tasks (they allow it in the project's Repos).
              const waiting = repo.kind === "folder" && !repo.folderGranted;
              return (
                <DropdownMenu.RadioItem key={repo.name} value={repo.name} disabled={waiting} className="menu-item">
                  <RepoIcon className="size-4 shrink-0 text-fg-muted" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">
                      {repo.name}
                      {repo.primary && <span className="text-fg-subtle"> · primary</span>}
                    </span>
                    <span className="truncate text-xs text-fg-subtle">{waiting ? "Not allowed yet" : repoSourceLabel(repo)}</span>
                  </span>
                  <DropdownMenu.ItemIndicator>
                    <Check className="size-4 shrink-0 text-fg" />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              );
            })}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
