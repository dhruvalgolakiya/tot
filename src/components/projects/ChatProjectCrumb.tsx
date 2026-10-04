import type { MouseEvent } from "react";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import type { Conversation } from "@shared/types";
import { conversationTitle } from "../../lib/conversations";
import { useProjects } from "../../lib/projects";
import { projectPath } from "../../lib/router";
import { navigateToProject } from "../../store";
import { Tip } from "../ui/Tip";

/**
 * "web › Fix the flaky checkout test" at the top of a chat that's in a project; the name opens the
 * project's page. Tasks show their own title next to it, so they pass `withTitle={false}`.
 */
export function ChatProjectCrumb({ chat, withTitle = true }: { chat: Conversation; withTitle?: boolean }) {
  const project = useProjects((s) => (chat.projectId ? s.projects.find((p) => p.id === chat.projectId) : undefined));
  if (!project) return null;

  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigateToProject(project.id, chat.agentId);
  };

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-0.5 text-sm">
      <a
        href={projectPath(chat.agentId, project.id)}
        onClick={open}
        className="max-w-40 shrink-0 truncate rounded-md px-1.5 py-1 font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg"
      >
        {project.name}
      </a>
      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-fg-subtle max-sm:hidden" />
      {withTitle && (
        <span aria-current="page" className="min-w-0 truncate px-1 text-fg max-sm:hidden">
          {conversationTitle(chat)}
        </span>
      )}
    </nav>
  );
}

/** "ENG-123 ↗": the ticket a chat came from (Linear or GitHub), linking to it. */
export function TicketChip({ chat }: { chat: Conversation }) {
  const origin = chat.origin;
  if (!origin || (origin.kind !== "linear" && origin.kind !== "github") || !origin.key) return null;
  const className =
    "inline-flex h-7 max-w-40 shrink-0 items-center gap-1 rounded-full border border-edge px-2.5 text-xs font-medium text-fg-muted transition-colors";
  const label = <span className="truncate font-mono">{origin.key}</span>;

  return (
    <Tip content={origin.label}>
      {origin.url ? (
        <a
          href={origin.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${origin.key}`}
          className={`${className} hover:border-edge-strong hover:bg-hover hover:text-fg`}
        >
          {label}
          <ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0" />
        </a>
      ) : (
        <span tabIndex={0} className={className}>
          {label}
        </span>
      )}
    </Tip>
  );
}
