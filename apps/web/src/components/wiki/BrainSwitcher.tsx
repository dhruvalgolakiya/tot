import type { ReactNode } from "react";
import clsx from "clsx";
import { DropdownMenu } from "radix-ui";
import { Brain as BrainGlyph, Check, ChevronsUpDown, NotebookPen, Plus, Settings2, ShieldCheck } from "lucide-react";
import type { Agent, Brain } from "@shared/types";
import { accessOf, brainName, brainsFor } from "../../lib/brains";
import { GitHubMark } from "../ui/GitHubMark";
import { Skeleton } from "../ui/Skeleton";

/** A brain's kind at a glance: notebook, repo (GitHub mark), or notes. */
export function BrainIcon({ brain, className }: { brain: Pick<Brain, "kind">; className?: string }) {
  if (brain.kind === "notebook") return <NotebookPen aria-hidden="true" className={className} />;
  if (brain.kind === "repo") return <GitHubMark className={className} />;
  return <BrainGlyph aria-hidden="true" className={className} />;
}

type BrainSwitcherProps = {
  agent: Agent;
  agents: Agent[];
  brains: Brain[] | null;
  current: Brain | null;
  onOpen: (brainId: string) => void;
  onNew: () => void;
  onSettings: () => void;
  /** A repo brain's profile: the checks TOT runs on work there. */
  onProfile: () => void;
  /** The brains that are projects' knowledge: listed under Projects. */
  projectBrainIds: Set<string>;
  /** Shown while no brain is open once they've loaded (another device's project, say). */
  placeholder?: string;
};

/** The top of the Knowledge page's sidebar: whose knowledge is open, and a menu to switch, add or set one up. */
export function BrainSwitcher({ agent, agents, brains, current, onOpen, onNew, onSettings, onProfile, projectBrainIds, placeholder }: BrainSwitcherProps) {
  if (!brains || (!current && !placeholder)) {
    return (
      <div className="px-2 pt-2" aria-busy="true" aria-label="Loading brains">
        <Skeleton className="h-11 rounded-lg" />
      </div>
    );
  }
  const { mine: all, others } = brainsFor(brains, agent.id);
  const mine = all.filter((brain) => !projectBrainIds.has(brain.id));
  const projects = all.filter((brain) => projectBrainIds.has(brain.id));
  const access = current ? accessOf(current, agent.id) : null;
  const subtitle = !current
    ? "Not on this Mac"
    : current.kind === "notebook"
      ? `Private to ${agents.find((a) => a.id === current.ownerAgentId)?.name ?? "its agent"}`
      : projectBrainIds.has(current.id)
        ? "Project"
        : access === "read"
          ? `Read-only for ${agent.name}`
          : access === null
            ? `Not attached to ${agent.name}`
            : current.allAgents
              ? "Shared with all agents"
              : "Shared";

  return (
    <div className="px-2 pt-2">
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover data-[state=open]:bg-selected"
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-fill text-fg-muted">
              {current ? <BrainIcon brain={current} className="size-3.5" /> : <BrainGlyph aria-hidden="true" className="size-3.5" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-fg">{current ? brainName(current, agents, agent.id) : placeholder}</span>
              <span className="block truncate text-xs text-fg-subtle">{subtitle}</span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-fg-subtle" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={4} className="menu w-[var(--radix-dropdown-menu-trigger-width)] min-w-60">
            <DropdownMenu.Label className="menu-label">{agent.name}'s knowledge</DropdownMenu.Label>
            {mine.map((brain) => (
              <BrainItem key={brain.id} brain={brain} active={brain.id === current?.id} onSelect={() => onOpen(brain.id)}>
                {brainName(brain, agents, agent.id)}
                {accessOf(brain, agent.id) === "read" && <span className="text-xs text-fg-subtle">read-only</span>}
              </BrainItem>
            ))}
            {projects.length > 0 && (
              <>
                <DropdownMenu.Separator className="menu-separator" />
                <DropdownMenu.Label className="menu-label">Projects</DropdownMenu.Label>
                {projects.map((brain) => (
                  <BrainItem key={brain.id} brain={brain} active={brain.id === current?.id} onSelect={() => onOpen(brain.id)}>
                    {brain.name}
                  </BrainItem>
                ))}
              </>
            )}
            {others.length > 0 && (
              <>
                <DropdownMenu.Separator className="menu-separator" />
                <DropdownMenu.Label className="menu-label">Not attached</DropdownMenu.Label>
                {others.map((brain) => (
                  <BrainItem key={brain.id} brain={brain} active={brain.id === current?.id} muted onSelect={() => onOpen(brain.id)}>
                    {brain.name}
                  </BrainItem>
                ))}
              </>
            )}
            <DropdownMenu.Separator className="menu-separator" />
            <DropdownMenu.Item className="menu-item" onSelect={onNew}>
              <Plus className="size-4 text-fg-muted" /> New knowledge base…
            </DropdownMenu.Item>
            {current && (
              <DropdownMenu.Item className="menu-item" onSelect={onSettings}>
                <Settings2 className="size-4 text-fg-muted" /> Settings…
              </DropdownMenu.Item>
            )}
            {current?.kind === "repo" && (
              <DropdownMenu.Item className="menu-item" onSelect={onProfile}>
                <ShieldCheck className="size-4 text-fg-muted" /> Repo profile…
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function BrainItem({
  brain,
  active,
  muted = false,
  onSelect,
  children,
}: {
  brain: Brain;
  active: boolean;
  muted?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.Item className="menu-item" onSelect={onSelect}>
      <BrainIcon brain={brain} className="size-4 shrink-0 text-fg-muted" />
      <span className={clsx("flex min-w-0 flex-1 items-baseline gap-2", muted && "text-fg-muted")}>
        <span className="truncate">{children}</span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-fg-subtle tabular-nums">
        {brain.pageCount}
        <Check aria-hidden="true" className={clsx("size-3.5 text-fg", !active && "invisible")} />
      </span>
    </DropdownMenu.Item>
  );
}
