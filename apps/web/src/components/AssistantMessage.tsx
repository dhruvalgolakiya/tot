import { memo } from "react";
import clsx from "clsx";
import type { Message, MessagePart, ModelOption } from "@tot/shared/types";
import { foldedRows, partRows, partSpacing } from "../lib/toolGroups";
import { FoldedWork } from "./FoldedWork";
import { MessageMeta } from "./MessageMeta";
import { MessagePartView } from "./MessagePartView";
import { TaskGroupCard } from "./orchestration/TaskGroupCard";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { ToolGroup } from "./ToolGroup";
import { SteerNote } from "./UserMessage";

type AssistantMessageProps = {
  message: Message;
  /** This message belongs to the run we're currently following. */
  live: boolean;
  /** This is the conversation's most recent assistant message, and its run just completed. */
  justFinished: boolean;
  /** This is the conversation's most recent assistant message — its actions stay visible, not just on hover. */
  isLatest: boolean;
  /** The user's steering notes handed to this reply mid-turn, shown after the part each arrived after. */
  notes?: Message[];
  /** The active agent's name, for the "thinking" line. */
  agentName: string;
  /** Every model, to name the one that answered. Read once by the list, not by each message. */
  models: ModelOption[];
  /** The message is in a chat (they fork; tasks and TOT's own notices don't). */
  inChat: boolean;
  /** An older turn of a long chat: its work before the answer is folded into one line. */
  folded?: boolean;
};

/**
 * For a run of two or more task cards in a row: the run's task ids at its first part, null at the
 * others (folded into the group); otherwise [] (render the part as it is).
 */
function taskRun(parts: MessagePart[], index: number): string[] | null {
  const part = parts[index];
  if (part?.type !== "task") return [];
  if (parts[index - 1]?.type === "task") {
    let start = index;
    while (parts[start - 1]?.type === "task") start--;
    return taskRun(parts, start)!.length > 1 ? null : [];
  }
  const ids: string[] = [];
  for (let i = index; parts[i]?.type === "task"; i++) ids.push((parts[i] as Extract<MessagePart, { type: "task" }>).taskId);
  return ids.length > 1 ? ids : [];
}

/** The tail of a streaming message has nothing animating (e.g. a finished tool). */
function isIdleTail(part: MessagePart | undefined) {
  if (!part) return true;
  if (part.type === "tool") return part.status !== "running";
  return part.type === "notice";
}

export const AssistantMessage = memo(function AssistantMessage({ message, live, isLatest, notes, agentName, models, inChat, folded = false }: AssistantMessageProps) {
  const streaming = live && message.status === "streaming";
  const { parts } = message;
  const partIds = new Set(parts.map((part) => part.id));
  const notesAfter = (partId: string | null) => (notes ?? []).filter((note) => (note.steeredInto?.afterPartId ?? null) === partId);
  // Notes that arrived before the first part, or after a part that's gone, go at the start or the end.
  const leading = notesAfter(null);
  const trailing = (notes ?? []).filter((note) => note.steeredInto?.afterPartId && !partIds.has(note.steeredInto.afterPartId));
  const noted = new Set((notes ?? []).map((note) => note.steeredInto?.afterPartId));
  // Finished tool calls in a row show as one line; a note the user sent after one of them ends the run there. An older
  // turn folds all its work before the answer.
  const noteAfter = (id: string) => noted.has(id);
  const rows = folded && !streaming ? foldedRows(parts, { noteAfter }) : partRows(parts, { live: streaming, noteAfter });
  const folds = rows.filter((row) => row.kind === "work").length;

  return (
    <div className="group/message min-w-0">
      {leading.map((note) => (
        <SteerNote key={note.id} message={note} inline />
      ))}
      {rows.map((row) => {
        if (row.kind !== "part") {
          const run = row.indexes.map((index) => parts[index]!);
          return (
            <div key={run[0]!.id} className={partSpacing(parts[row.indexes[0]! - 1], run[0]!)}>
              {row.kind === "tools" ? (
                <ToolGroup parts={run} live={streaming} conversationId={message.conversationId} />
              ) : (
                <FoldedWork parts={run} durationMs={folds === 1 ? message.usage?.durationMs : undefined} conversationId={message.conversationId} />
              )}
              {notesAfter(run.at(-1)!.id).map((note) => (
                <div key={note.id} className="mt-3">
                  <SteerNote message={note} inline />
                </div>
              ))}
            </div>
          );
        }
        const { index } = row;
        const part = parts[index]!;
        // Tasks started together stack into one group card (at the first of them; the rest are folded in).
        const group = taskRun(parts, index);
        if (group === null) return null;
        return (
          <div key={part.id} className={partSpacing(parts[index - 1], part)}>
            {group.length > 1 ? (
              <TaskGroupCard taskIds={group} />
            ) : (
              <MessagePartView
                part={part}
                active={streaming && index === parts.length - 1}
                live={streaming}
                conversationId={message.conversationId}
              />
            )}
            {notesAfter(part.id).map((note) => (
              <div key={note.id} className="mt-3">
                <SteerNote message={note} inline />
              </div>
            ))}
          </div>
        );
      })}
      {trailing.map((note) => (
        <SteerNote key={note.id} message={note} inline />
      ))}
      {streaming && isIdleTail(parts.at(-1)) && (
        <div className={clsx(parts.length > 0 && "mt-3")}>
          <ThinkingIndicator agentName={agentName} message={message} live={streaming} />
        </div>
      )}
      {!streaming && <MessageMeta message={message} isLatest={isLatest} models={models} inChat={inChat} />}
    </div>
  );
});
