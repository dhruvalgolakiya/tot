import { memo } from "react";
import clsx from "clsx";
import type { Message, MessagePart } from "@shared/types";
import { selectActiveAgent, useStore } from "../store";
import { MessageMeta } from "./MessageMeta";
import { MessagePartView } from "./MessagePartView";
import { ThinkingIndicator } from "./ThinkingIndicator";

type AssistantMessageProps = {
  message: Message;
  /** This message belongs to the run we're currently following. */
  live: boolean;
  /** This is the conversation's most recent assistant message, and its run just completed. */
  justFinished: boolean;
  /** This is the conversation's most recent assistant message — its actions stay visible, not just on hover. */
  isLatest: boolean;
};

const PILL_TOOLS = new Set(["memory_save", "wiki_write", "wiki_edit"]);
const isToolCard = (part: MessagePart | undefined) => part?.type === "tool" && !PILL_TOOLS.has(part.name);

/** Tool cards stack tightly; everything else gets room to breathe. */
function spacing(previous: MessagePart | undefined, part: MessagePart) {
  if (!previous) return undefined;
  return isToolCard(previous) && isToolCard(part) ? "mt-1.5" : "mt-3";
}

/** The tail of a streaming message has nothing animating (e.g. a finished tool). */
function isIdleTail(part: MessagePart | undefined) {
  if (!part) return true;
  if (part.type === "tool") return part.status !== "running";
  return part.type === "notice";
}

export const AssistantMessage = memo(function AssistantMessage({ message, live, isLatest }: AssistantMessageProps) {
  const streaming = live && message.status === "streaming";
  const { parts } = message;
  const agent = useStore(selectActiveAgent);
  const name = agent?.name ?? "TOT";

  return (
    <div className="group/message min-w-0">
      {parts.map((part, index) => (
        <div key={part.id} className={spacing(parts[index - 1], part)}>
          <MessagePartView
            part={part}
            active={streaming && index === parts.length - 1}
            live={streaming}
            conversationId={message.conversationId}
          />
        </div>
      ))}
      {streaming && isIdleTail(parts.at(-1)) && (
        <div className={clsx(parts.length > 0 && "mt-3")}>
          <ThinkingIndicator agentName={name} message={message} live={streaming} />
        </div>
      )}
      {!streaming && <MessageMeta message={message} isLatest={isLatest} />}
    </div>
  );
});
