import { useEffect, useState } from "react";
import { ArrowUp, CornerDownRight, X } from "lucide-react";
import type { QueuedMessage } from "@tot/shared/types";
import { loadQueue, queuedPreview, removeQueued, useQueue } from "../../lib/queue";
import { notifyError, sendQueuedNow, useStore } from "../../store";
import { IconButton } from "../ui/IconButton";
import { Tip } from "../ui/Tip";

/**
 * Messages sent while the chat's turn runs, as quiet rows above the composer: each goes out when the turn before it
 * ends. On hover, "Send now" hands one to the running reply (or right after it), and × takes it back.
 */
export function QueuedMessages({ conversationId }: { conversationId: string }) {
  const queue = useQueue(conversationId);
  const running = useStore((s) => Boolean(s.activeRuns[conversationId]));
  const asking = useStore((s) => s.pendingApprovals.has(conversationId));
  useEffect(() => void loadQueue(conversationId), [conversationId]);
  if (queue.length === 0) return null;

  return (
    <ul aria-label="Queued messages" className="mb-2 flex flex-col gap-1">
      {queue.map((item) => (
        <QueuedRow key={item.id} item={item} running={running} asking={asking} />
      ))}
    </ul>
  );
}

function QueuedRow({ item, running, asking }: { item: QueuedMessage; running: boolean; asking: boolean }) {
  const [busy, setBusy] = useState(false);
  const preview = queuedPreview(item.request);
  const nowHint = asking
    ? "Answer the request in the reply first"
    : running
      ? "Send now, into the reply as it works"
      : "Send it now";

  async function sendNow() {
    setBusy(true);
    await sendQueuedNow(item.conversationId, item.id);
    setBusy(false);
  }

  return (
    <li className="group/queued flex h-9 min-w-0 items-center gap-2 rounded-2xl border border-hairline bg-fill-subtle pr-1 pl-3 text-ui">
      <CornerDownRight className="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
      <span title={preview} className="min-w-0 flex-1 truncate text-fg-muted">
        {preview}
      </span>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/queued:opacity-100 group-focus-within/queued:opacity-100 pointer-coarse:opacity-100">
        <Tip content={nowHint}>
          {/* A disabled button gets no hover, so the tip explains through a wrapper. */}
          <span>
            <IconButton label="Send now" size="sm" disabled={busy || asking} onClick={() => void sendNow()}>
              <ArrowUp />
            </IconButton>
          </span>
        </Tip>
        <Tip content="Remove">
          <IconButton label="Remove from queue" size="sm" onClick={() => void removeQueued(item.conversationId, item.id).catch(notifyError)}>
            <X />
          </IconButton>
        </Tip>
      </span>
    </li>
  );
}
