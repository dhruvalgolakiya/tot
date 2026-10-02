import { useMemo } from "react";
import { groupConversations } from "../lib/conversations";
import { loadConversations, selectActiveAgentId, useStore } from "../store";
import { ConversationItem } from "./ConversationItem";

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
        <div className="space-y-2 px-2.5 pt-4" aria-hidden="true">
          {[72, 56, 64, 48, 60].map((width) => (
            <div key={width} className="h-3.5 animate-pulse rounded bg-white/[0.05]" style={{ width: `${width}%` }} />
          ))}
        </div>
      )}

      {state === "error" && conversations.length === 0 && (
        <div className="px-2.5 pt-6 text-center text-sm text-zinc-500">
          Couldn't load your chats.{" "}
          <button type="button" onClick={() => void loadConversations()} className="text-zinc-300 hover:underline">
            Retry
          </button>
        </div>
      )}

      {state === "ready" && groups.length === 0 && (
        <p className="px-2.5 pt-6 text-center text-sm text-zinc-500">
          {query.trim() ? `No chats match “${query.trim()}”` : "Your chats will show up here."}
        </p>
      )}

      {groups.map((group) => (
        <section key={group.label} className="mt-4 first:mt-2">
          <h2 className="label-caps px-2.5 pb-1">{group.label}</h2>
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
