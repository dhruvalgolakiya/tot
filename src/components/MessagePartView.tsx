import { memo } from "react";
import type { MessagePart } from "@shared/types";
import { ApprovalCard } from "./ApprovalCard";
import { LazyMarkdown } from "./LazyMarkdown";
import { MemoryPill } from "./MemoryPill";
import { NoticePart } from "./NoticePart";
import { ReasoningPart } from "./ReasoningPart";
import { ToolPart } from "./ToolPart";
import { WikiPill } from "./WikiPill";

type MessagePartViewProps = {
  part: MessagePart;
  /** This is the newest part of a streaming message. */
  active: boolean;
  /** The message is still streaming. */
  live: boolean;
  /** The conversation this message belongs to; "approval" parts need it to find the active run. */
  conversationId: string;
};

/** Renders one part; memoized so finished parts don't re-render while streaming. */
export const MessagePartView = memo(function MessagePartView({ part, active, live, conversationId }: MessagePartViewProps) {
  switch (part.type) {
    case "text":
      if (!part.text && active) return <span className="caret" aria-hidden="true" />;
      return <LazyMarkdown text={part.text} caret={active} />;
    case "reasoning":
      return <ReasoningPart part={part} active={active} />;
    case "tool":
      if (part.name === "memory_save") return <MemoryPill part={part} live={live} />;
      if (part.name === "wiki_write" || part.name === "wiki_edit") return <WikiPill part={part} live={live} />;
      return <ToolPart part={part} live={live} />;
    case "notice":
      return <NoticePart part={part} />;
    case "file":
      return null;
    case "approval":
      return <ApprovalCard part={part} conversationId={conversationId} />;
  }
});
