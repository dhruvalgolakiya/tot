import { useEffect } from "react";
import { ArrowDown } from "lucide-react";
import type { Message } from "@shared/types";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { retryConversation, selectActiveAgent, setChatScrolled, useStore } from "../store";
import { defaultMascot } from "./mascot";
import { AssistantAvatar } from "./AssistantAvatar";
import { AssistantMessage } from "./AssistantMessage";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { UserMessage } from "./UserMessage";

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

  // Between "sent" and the run's first event there is no assistant message yet.
  const awaitingReply = run ? !run.messageId : sending;
  const lastAssistantId = messages.findLast((m) => m.role === "assistant")?.id;
  const mascot = agent?.mascot ?? defaultMascot;
  const agentName = agent?.name ?? "TOT";

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="h-full overflow-y-auto overscroll-contain">
        <div ref={contentRef} className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 pt-20 pb-10 sm:px-6">
          {messages.length === 0 && loadState === "loading" && (
            <div className="space-y-4 pt-6" aria-label="Loading chat">
              <div className="ml-auto h-10 w-2/5 animate-pulse rounded-3xl bg-white/[0.05]" />
              <div className="h-4 w-4/5 animate-pulse rounded bg-white/[0.05]" />
              <div className="h-4 w-3/5 animate-pulse rounded bg-white/[0.05]" />
            </div>
          )}

          {messages.length === 0 && loadState === "error" && (
            <div className="pt-16 text-center text-sm text-zinc-400">
              Couldn't load this chat.{" "}
              <button
                type="button"
                onClick={() => retryConversation(conversationId)}
                className="font-medium text-zinc-200 hover:underline"
              >
                Try again
              </button>
            </div>
          )}

          {messages.map((message) =>
            message.role === "user" ? (
              <UserMessage key={message.id} message={message} />
            ) : (
              <AssistantMessage
                key={message.id}
                message={message}
                live={run?.messageId === message.id}
                justFinished={justFinished && message.id === lastAssistantId}
              />
            ),
          )}

          {awaitingReply && (
            <div className="flex gap-3 sm:gap-4">
              <AssistantAvatar mascot={mascot} name={agentName} state="thinking" />
              <ThinkingIndicator agentName={agentName} />
            </div>
          )}
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
          className="absolute bottom-3 left-1/2 grid size-9 -translate-x-1/2 animate-fade-in place-items-center rounded-full border border-white/10 bg-zinc-900/90 text-zinc-300 shadow-lg shadow-shade/40 backdrop-blur transition-colors hover:bg-zinc-800 hover:text-zinc-100"
        >
          <ArrowDown className="size-4" />
        </button>
      )}
    </div>
  );
}
