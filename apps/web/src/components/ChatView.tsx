import { Activity, useEffect, useRef, useState, type DragEvent } from "react";
import { Paperclip } from "lucide-react";
import { useAttachments } from "../hooks/useAttachments";
import { selectActiveAgent, useStore } from "../store";
import { AgentHome } from "./AgentHome";
import { Composer } from "./Composer";
import { HomeLedger } from "./home/HomeLedger";
import { MessageList } from "./MessageList";

const CAPTION = "TOT runs on your own ChatGPT & Claude subscriptions.";

/** Chats kept mounted, the open one included: switching back to a recent chat shows it as it was, at once. */
const KEPT_CHATS = 3;

const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

/**
 * Messages + composer. On an agent's home screen the composer sits centered
 * between the hero and Home's ledger; it keeps the same tree position
 * either way so it isn't remounted (and doesn't lose focus) when the first
 * message goes out — sendMessage sets currentId in place, without a route
 * change. Attachment state lives here (rather than inside Composer) so a file
 * can be dropped anywhere in the chat, not just on the composer itself.
 *
 * This view stays mounted from chat to chat. The last few chats' message lists
 * stay mounted too, hidden (<Activity>: no effects, no store subscriptions), so
 * going back to one doesn't render it again. Each navigation still starts with
 * a fresh composer, home and no attachments, as when the whole view remounted.
 */
export function ChatView() {
  const currentId = useStore((s) => s.currentId);
  const viewKey = useStore((s) => s.viewKey);
  const attachments = useAttachments(useStore((s) => selectActiveAgent(s)?.deviceId ?? null));
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  // The chats whose lists are mounted, in a stable order (moving a big list in the DOM costs), and from the most
  // recently open to the least, for which one to let go.
  const [kept, setKept] = useState<{ ids: string[]; recent: string[] }>({ ids: [], recent: [] });
  if (currentId && kept.recent[0] !== currentId) {
    const recent = [currentId, ...kept.recent.filter((id) => id !== currentId)].slice(0, KEPT_CHATS);
    const ids = [...kept.ids.filter((id) => recent.includes(id)), ...(kept.ids.includes(currentId) ? [] : [currentId])];
    setKept({ ids, recent });
  }

  // A new route: what was attached or being dragged belonged to the last one.
  const { clear } = attachments;
  useEffect(() => {
    clear();
    dragDepth.current = 0;
    setDragging(false);
  }, [viewKey, clear]);

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
      {kept.ids.map((id) => (
        <Activity key={id} mode={id === currentId ? "visible" : "hidden"}>
          <MessageList conversationId={id} />
        </Activity>
      ))}
      {!currentId && <AgentHome key={viewKey} />}

      {/* Above the message list's bottom fade, which would otherwise cover the top of the composer's outline. */}
      <div className="relative z-10 shrink-0 px-3 pb-2 sm:px-4">
        <div className="mx-auto w-full max-w-3xl">
          <Composer key={viewKey} attachments={attachments} />
        </div>
      </div>

      {currentId ? (
        <p className="shrink-0 px-4 pb-2.5 text-center text-xs text-fg-subtle">{CAPTION}</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-4">
          {/* What's working, what's waiting on you, every project and its Lead; the starter prompts until there's anything. */}
          <HomeLedger key={viewKey} />
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
