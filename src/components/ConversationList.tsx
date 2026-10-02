import { useMemo } from "react";
import { groupConversations } from "../lib/conversations";
import { loadConversations, selectActiveAgentId, useStore } from "../store";
import { ConversationItem } from "./ConversationItem";
import { Callout } from "./ui/Callout";
import { EmptyState } from "./ui/EmptyState";
import { Skeleton } from "./ui/Skeleton";

export function ConversationList({ query }: { query: string }) {
  const conversations = useStore((s) => s.conversations);
  const state = useStore((s) => s.conversationsState);
  const currentId = useStore((s) => s.currentId);
  const activeRuns = useStore((s) => s.activeRuns);
  const activeAgentId = useStore(selectActiveAgentId);
  const agentConversations = useMemo(
    () => (activeAgentId ? conversations.filter((c) => c.agentId === activeAgentId) : conversations),
    [conversations, activeAgentId],
  );
  const groups = useMemo(() => groupConversations(agentConversations, query), [agentConversations, query]);

  return (
    <nav aria-label="Chat history" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      {state === "loading" && conversations.length === 0 && (
        <div className="space-y-2 px-2.5 pt-4" aria-busy="true" aria-label="Loading chats">
          {[72, 56, 64, 48, 60].map((width) => (
            <Skeleton key={width} className="h-3.5" style={{ width: `${width}%` }} />
          ))}
        </div>
      )}

      {state === "error" && conversations.length === 0 && (
        <div className="px-2.5 pt-4">
          <Callout
            tone="danger"
            action={
              <button type="button" onClick={() => void loadConversations()} className="link-muted">
                Retry
              </button>
            }
          >
            Couldn't load your chats.
          </Callout>
        </div>
      )}

      {state === "ready" && groups.length === 0 && (
        <EmptyState
          size="sm"
          description={query.trim() ? `No chats match “${query.trim()}”` : "Your chats will show up here."}
        />
      )}

      {groups.map((group) => (
        <section key={group.label} className="mt-4 first:mt-2">
          <h2 className="group-label px-2.5 pb-1">{group.label}</h2>
          <ul className="space-y-px">
            {group.items.map((conversation) => (
              <li key={conversation.id}>
                <ConversationItem
                  conversation={conversation}
                  active={conversation.id === currentId}
                  streaming={Boolean(activeRuns[conversation.id])}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}
