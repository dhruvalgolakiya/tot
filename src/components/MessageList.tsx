import { useEffect, useMemo } from "react";
import { ArrowDown } from "lucide-react";
import type { Message } from "@shared/types";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { retryConversation, selectActiveAgent, setChatScrolled, useStore } from "../store";
import { AssistantMessage } from "./AssistantMessage";
import { ForkedFrom } from "./ForkedFrom";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { UserMessage } from "./UserMessage";
import { Callout } from "./ui/Callout";
import { Skeleton } from "./ui/Skeleton";

const NO_MESSAGES: Message[] = [];

export function MessageList({ conversationId }: { conversationId: string }) {
  const messages = useStore((s) => s.messages[conversationId]) ?? NO_MESSAGES;
  const run = useStore((s) => s.activeRuns[conversationId]);
  const sending = useStore((s) => s.sending);
  const loadState = useStore((s) => s.detailState[conversationId]);
  const justFinished = useStore((s) => Boolean(s.justFinished[conversationId]));
  const agent = useStore(selectActiveAgent);
  const { scrollRef, contentRef, atBottom, scrollToBottom } = useStickToBottom();

  // Jump to the bottom whenever the user sends something.
  const lastUserMessageId = messages.findLast((m) => m.role === "user")?.id;
  useEffect(() => {
    scrollToBottom();
  }, [lastUserMessageId, scrollToBottom]);

  // The header floats over this list with a blurred background once its content
  // has scrolled past the top; report that up to the store so Header can react.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setChatScrolled(el.scrollTop > 4);
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      setChatScrolled(false);
    };
  }, [scrollRef]);

  // Steering notes handed to a reply mid-turn are shown inside that reply, where they arrived.
  const { shown, notesByReply } = useMemo(() => {
    const ids = new Set(messages.map((m) => m.id));
    const notes = new Map<string, Message[]>();
    const top: Message[] = [];
    for (const message of messages) {
      const into = message.steeredInto?.messageId;
      if (message.role === "user" && into && ids.has(into)) notes.set(into, [...(notes.get(into) ?? []), message]);
      else top.push(message);
    }
    return { shown: top, notesByReply: notes };
  }, [messages]);

  // Between "sent" and the run's first event there is no assistant message yet.
  const awaitingReply = run ? !run.messageId : sending;
  const lastAssistantId = messages.findLast((m) => m.role === "assistant")?.id;
  const agentName = agent?.name ?? "TOT";

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="h-full overflow-y-auto overscroll-contain">
        <div ref={contentRef} className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 pt-20 pb-10 sm:px-6">
          {messages.length === 0 && loadState === "loading" && (
            <div className="space-y-4 pt-6" aria-busy="true" aria-label="Loading chat">
              <Skeleton className="ml-auto h-10 w-2/5 rounded-3xl" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          )}

          {messages.length === 0 && loadState === "error" && (
            <div className="mx-auto max-w-sm pt-16">
              <Callout
                tone="danger"
                action={
                  <button type="button" onClick={() => retryConversation(conversationId)} className="link-muted">
                    Try again
                  </button>
                }
              >
                Couldn't load this chat.
              </Callout>
            </div>
          )}

          {messages.length > 0 && <ForkedFrom conversationId={conversationId} />}

          {shown.map((message) =>
            message.role === "user" ? (
              <UserMessage key={message.id} message={message} />
            ) : (
              <AssistantMessage
                key={message.id}
                message={message}
                notes={notesByReply.get(message.id)}
                live={run?.messageId === message.id}
                justFinished={justFinished && message.id === lastAssistantId}
                isLatest={message.id === lastAssistantId}
              />
            ),
          )}

          {awaitingReply && <ThinkingIndicator agentName={agentName} />}
        </div>
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-linear-to-t from-canvas to-transparent"
      />

      {!atBottom && (
        <button
          type="button"
          onClick={() => scrollToBottom("smooth")}
          aria-label="Jump to latest"
          className="absolute bottom-3 left-1/2 grid size-9 -translate-x-1/2 animate-fade-in place-items-center rounded-full border border-edge bg-elevated text-fg-muted shadow-popover transition-colors hover:bg-hover hover:text-fg"
        >
          <ArrowDown className="size-4" />
        </button>
      )}
    </div>
  );
}
