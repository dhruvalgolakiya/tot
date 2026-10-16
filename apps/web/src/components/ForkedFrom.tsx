import type { MouseEvent } from "react";
import { GitFork } from "lucide-react";
import { conversationPath } from "../lib/router";
import { navigateToConversation, useStore } from "../store";

/** At the top of a forked chat: "Forked from X", a link back to it. */
export function ForkedFrom({ conversationId }: { conversationId: string }) {
  const origin = useStore((s) => s.conversations.find((c) => c.id === conversationId)?.forkedFrom ?? null);
  const source = useStore((s) => (origin ? s.conversations.find((c) => c.id === origin.conversationId) : undefined));
  if (!origin) return null;

  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!source || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigateToConversation(source.id);
  };

  return (
    <p className="-mt-3 flex min-w-0 items-center justify-center gap-1.5 text-xs text-fg-subtle">
      <GitFork className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="shrink-0">Forked from</span>
      {source ? (
        <a href={conversationPath(source.id)} onClick={open} className="link-muted min-w-0 truncate">
          {source.title}
        </a>
      ) : (
        <span>a chat that was deleted</span>
      )}
    </p>
  );
}
