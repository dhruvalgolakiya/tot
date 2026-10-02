import { useMemo } from "react";
import type { Message } from "@shared/types";
import { toMs } from "../lib/format";
import { computerActivity } from "../lib/tools";
import { useStore } from "../store";
import { ComputerActivityItem } from "./ComputerActivityItem";

/** Newest-first log of the computer_* tool calls across an agent's chats. */
export function ComputerActivity({ agentId }: { agentId: string }) {
  const conversations = useStore((s) => s.conversations);
  const messages = useStore((s) => s.messages);
  const activeRuns = useStore((s) => s.activeRuns);

  const agentConversationIds = useMemo(
    () => conversations.filter((c) => c.agentId === agentId).map((c) => c.id),
    [conversations, agentId],
  );
  const live = agentConversationIds.some((id) => Boolean(activeRuns[id]));
  const entries = useMemo(() => {
    const merged: Message[] = agentConversationIds
      .flatMap((id) => messages[id] ?? [])
      .sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
    return computerActivity(merged);
  }, [agentConversationIds, messages]);

  return (
    <section>
      <h3 className="label-caps mb-2">Activity</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-zinc-500">Commands and file changes will show up here as TOT works.</p>
      ) : (
        <ol className="space-y-1.5">
          {entries.map((part) => (
            <ComputerActivityItem key={part.id} part={part} live={live} />
          ))}
        </ol>
      )}
    </section>
  );
}
