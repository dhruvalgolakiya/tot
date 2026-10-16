import type { LucideIcon } from "lucide-react";
import { BookOpen, Brain, Info, Monitor, Sparkles, TriangleAlert } from "lucide-react";
import clsx from "clsx";
import type { MessagePart } from "@shared/types";
import { comparePath } from "../lib/router";
import { navigateToCompare, navigateToWiki, selectActiveAgentId, selectCurrentConversation, useStore } from "../store";
import { MoveToProjectButton } from "./projects/MoveToProjectMenu";

type Notice = Extract<MessagePart, { type: "notice" }>;

const ICONS: Record<Notice["kind"], LucideIcon> = {
  memory: Brain,
  wiki: BookOpen,
  computer: Monitor,
  route: Sparkles,
  info: Info,
  warning: TriangleAlert,
};

/**
 * A small muted status line, e.g. "Auto → Opus 5.5 · complex task". A "wiki" notice opens the page it refers to;
 * "Filed under web" (it has a `projectId`) offers Move, to undo the filing in one step; "Best of 2 finished"
 * (it has a `group`, module 09) offers Compare.
 */
export function NoticePart({ part }: { part: Notice }) {
  const Icon = ICONS[part.kind] ?? Info;
  const agentId = useStore(selectActiveAgentId);
  const chat = useStore(selectCurrentConversation);
  const openWiki = part.kind === "wiki" && agentId ? () => navigateToWiki(agentId, part.pageIds?.[0]) : undefined;

  const content = (
    <>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 text-left">{part.text}</span>
    </>
  );

  if (part.group) {
    const group = part.group;
    return (
      <div className={clsx("flex items-start gap-2 text-xs leading-5", part.kind === "warning" ? "text-warning" : "text-fg-subtle")}>
        {content}
        <a
          href={comparePath(group)}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
            event.preventDefault();
            navigateToCompare(group);
          }}
          className="link-muted shrink-0"
        >
          Compare
        </a>
      </div>
    );
  }

  if (part.projectId && chat) {
    return (
      <div className="flex items-start gap-2 text-xs leading-5 text-fg-subtle">
        {content}
        <MoveToProjectButton chat={chat} className="link-muted shrink-0">
          Move
        </MoveToProjectButton>
      </div>
    );
  }

  if (openWiki) {
    return (
      <button
        type="button"
        onClick={openWiki}
        className="flex items-start gap-2 text-xs leading-5 text-fg-subtle transition-colors hover:text-fg-muted"
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className={clsx(
        "flex items-start gap-2 text-xs leading-5",
        part.kind === "warning" ? "text-warning" : "text-fg-subtle",
      )}
    >
      {content}
    </div>
  );
}
