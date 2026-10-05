import { useRef, useState, type DragEvent } from "react";
import { Paperclip } from "lucide-react";
import { useAttachments } from "../hooks/useAttachments";
import { selectActiveAgent, useStore } from "../store";
import { AgentHome } from "./AgentHome";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { Suggestions } from "./Suggestions";

const CAPTION = "TOT runs on your own ChatGPT & Claude subscriptions.";

const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

/**
 * Messages + composer. On an agent's home screen the composer sits centered
 * between the mascot and the suggestions; it keeps the same tree position
 * either way so it isn't remounted (and doesn't lose focus) when the first
 * message goes out — sendMessage sets currentId in place, without a route
 * change that would remount this view. Attachment state lives here (rather
 * than inside Composer) so a file can be dropped anywhere in the chat, not
 * just on the composer itself.
 */
export function ChatView() {
  const currentId = useStore((s) => s.currentId);
  const attachments = useAttachments(useStore((s) => selectActiveAgent(s)?.deviceId ?? null));
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  function onDragEnter(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }
  function onDragOver(event: DragEvent) {
    if (hasFiles(event)) event.preventDefault();
  }
  function onDragLeave(event: DragEvent) {
    if (!hasFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }
  function onDrop(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    attachments.addFiles(event.dataTransfer.files);
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {currentId ? <MessageList conversationId={currentId} /> : <AgentHome />}

      {/* Above the message list's bottom fade, which would otherwise cover the top of the composer's outline. */}
      <div className="relative z-10 shrink-0 px-3 pb-2 sm:px-4">
        <div className="mx-auto w-full max-w-3xl">
          <Composer attachments={attachments} />
        </div>
      </div>

      {currentId ? (
        <p className="shrink-0 px-4 pb-2.5 text-center text-xs text-fg-subtle">{CAPTION}</p>
      ) : (
        <div className="flex flex-1 flex-col pt-4">
          <Suggestions />
          <p className="mt-auto px-4 pt-6 pb-3 text-center text-xs text-fg-subtle">{CAPTION}</p>
        </div>
      )}

      {dragging && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-3 z-10 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-accent-edge bg-canvas/90 text-fg-muted backdrop-blur-sm"
        >
          <Paperclip className="size-6 text-accent-text" />
          <p className="text-sm font-medium">Drop to attach</p>
        </div>
      )}
    </div>
  );
}
