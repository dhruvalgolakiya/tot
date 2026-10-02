import type { LucideIcon } from "lucide-react";
import { BookOpen, Brain, Info, Monitor, Sparkles, TriangleAlert } from "lucide-react";
import clsx from "clsx";
import type { MessagePart } from "@shared/types";
import { navigateToWiki, selectActiveAgentId, useStore } from "../store";

type Notice = Extract<MessagePart, { type: "notice" }>;

const ICONS: Record<Notice["kind"], LucideIcon> = {
  memory: Brain,
  wiki: BookOpen,
  computer: Monitor,
  route: Sparkles,
  info: Info,
  warning: TriangleAlert,
};

/** A small muted status line, e.g. "Auto → Opus 5.5 · complex task". A "wiki" notice opens the page it refers to. */
export function NoticePart({ part }: { part: Notice }) {
  const Icon = ICONS[part.kind] ?? Info;
  const agentId = useStore(selectActiveAgentId);
  const openWiki = part.kind === "wiki" && agentId ? () => navigateToWiki(agentId, part.pageIds?.[0]) : undefined;

  const content = (
    <>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 text-left">{part.text}</span>
    </>
  );

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
