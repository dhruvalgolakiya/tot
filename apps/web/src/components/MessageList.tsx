import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowDown } from "lucide-react";
import type { Message } from "@tot/shared/types";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { whenIdle } from "../lib/idle";
import { loadMarkdown, useMarkdownReady } from "../lib/markdownLoader";
import { isTask } from "../lib/tasks";
import { retryConversation, selectActiveAgent, setChatScrolled, useStore } from "../store";
import { AssistantMessage } from "./AssistantMessage";
import { ForkedFrom } from "./ForkedFrom";
import { QuoteSelection } from "./QuoteSelection";
import { TaskEmptyState } from "./tasks/TaskEmptyState";
import { isTaskEndingMessage, TaskNotices } from "./tasks/TaskNotices";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { UserMessage } from "./UserMessage";
import { Callout } from "./ui/Callout";
import { Skeleton } from "./ui/Skeleton";

const NO_MESSAGES: Message[] = [];

/** One row of the list: a message, or tasks' "… is done" notices in a row, shown as one compact list. */
type Row = Message | Message[];
const rowKey = (row: Row) => (Array.isArray(row) ? row[0]!.id : row.id);

// A long chat opens with its newest rows (about a screenful), then renders older ones a batch at a time while
// the browser is idle, or right away once the user scrolls up to them.
const BATCH_ROWS = 15;
const BATCH_PARTS = 40;

/** Where the batch of rows that ends just before `end` starts. */
function batchStart(rows: Row[], end: number): number {
  let start = end;
  let parts = 0;
  while (start > 0 && end - start < BATCH_ROWS && parts < BATCH_PARTS) {
    start -= 1;
    const row = rows[start]!;
    parts += Array.isArray(row) ? row.length : Math.max(1, row.parts.length);
  }
  return start;
}

/** `previous` if it holds the same messages as `next`, so memoized rows aren't handed a new array. */
function sameMessages(previous: Message[] | undefined, next: Message[]): Message[] {
  return previous && previous.length === next.length && previous.every((message, i) => message === next[i]) ? previous : next;
}

// Rows off-screen skip layout and paint (content-visibility), and the browser keeps the view steady when their
// real size replaces the estimate (scroll anchoring). Safari has no scroll anchoring, so there rows render as usual.
const anchoring = typeof CSS !== "undefined" && CSS.supports("overflow-anchor", "auto");

/** The newest rows always render in full: they're what a chat opens on. */
const ALWAYS_RENDERED = 4;

/** From this many replies on, a chat folds the work of every turn but the latest. */
const FOLD_FROM = 3;

/**
 * Each row's box. Paint containment clips at its edge, so it reaches 8px past the row on every side (padding,
 * taken back by negative margins: the layout doesn't move) for focus rings and the task notices' bleed.
 */
function rowClass(row: Row, recent: boolean, folded: boolean) {
  return clsx(
    "-mx-2 -my-2 min-w-0 px-2 py-2",
    anchoring &&
      !recent &&
      (Array.isArray(row)
        ? "[content-visibility:auto] [contain-intrinsic-size:auto_96px]"
        : row.role === "user"
          ? "[content-visibility:auto] [contain-intrinsic-size:auto_120px]"
          : folded
            ? "[content-visibility:auto] [contain-intrinsic-size:auto_320px]"
            : "[content-visibility:auto] [contain-intrinsic-size:auto_600px]"),
  );
}

/** `topPadding`: room above the first message (the floating header's by default; less under a project page's tab row on phones). */
export function MessageList({ conversationId, topPadding = "pt-20" }: { conversationId: string; topPadding?: string }) {
  const messages = useStore((s) => s.messages[conversationId]) ?? NO_MESSAGES;
  const run = useStore((s) => s.activeRuns[conversationId]);
  const sending = useStore((s) => s.sending);
  const loadState = useStore((s) => s.detailState[conversationId]);
  const justFinished = useStore((s) => Boolean(s.justFinished[conversationId]));
  const agentName = useStore((s) => selectActiveAgent(s)?.name ?? "TOT");
  const models = useStore((s) => s.models);
  const conversation = useStore((s) => s.conversations.find((c) => c.id === conversationId));
  const task = isTask(conversation) ? conversation : null;
  // Replies in chats fork (not TOT's own notices; tasks don't fork yet), and chats rewind to the user's messages.
  const inChat = conversation?.kind === "chat";
  const { scrollRef, contentRef, atBottom, stuck, scrollToBottom } = useStickToBottom();
  // Messages wait for the markdown renderer, so they render once, as markdown (the skeleton shows meanwhile).
  const markdownReady = useMarkdownReady();
  useEffect(() => {
    if (!markdownReady) loadMarkdown().catch(() => {});
  }, [markdownReady]);

  // Jump to the bottom whenever the user sends something (not when a hidden chat is shown again).
  const lastUserMessageId = messages.findLast((m) => m.role === "user")?.id;
  const seenUserMessage = useRef(lastUserMessageId);
  useEffect(() => {
    if (seenUserMessage.current === lastUserMessageId) return;
    seenUserMessage.current = lastUserMessageId;
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
  const arrays = useRef(new Map<string, Message[]>());
  const { shown, notesByReply } = useMemo(() => {
    const ids = new Set(messages.map((m) => m.id));
    const notes = new Map<string, Message[]>();
    const top: Message[] = [];
    for (const message of messages) {
      const into = message.steeredInto?.messageId;
      if (message.role === "user" && into && ids.has(into)) notes.set(into, [...(notes.get(into) ?? []), message]);
      else top.push(message);
    }
    // Tasks' "… is done" notices in a row read as one compact list, not a message each.
    const rows: Row[] = [];
    for (const message of top) {
      const last = rows.at(-1);
      if (!isTaskEndingMessage(message)) rows.push(message);
      else if (Array.isArray(last)) last.push(message);
      else rows.push([message]);
    }
    // The same notes and notices stay the same arrays across updates (streaming), so their rows don't re-render.
    const previous = arrays.current;
    const kept = new Map<string, Message[]>();
    for (const [reply, list] of notes) {
      const same = sameMessages(previous.get(`notes:${reply}`), list);
      notes.set(reply, same);
      kept.set(`notes:${reply}`, same);
    }
    for (const [index, row] of rows.entries()) {
      if (!Array.isArray(row)) continue;
      const same = sameMessages(previous.get(`row:${row[0]!.id}`), row);
      rows[index] = same;
      kept.set(`row:${row[0]!.id}`, same);
    }
    arrays.current = kept;
    return { shown: rows, notesByReply: notes };
  }, [messages]);

  // The first row on screen: the newest batch's at first, earlier ones as older batches come in. Kept by its
  // key, not its index, so rows arriving at either end don't shift it.
  const [firstKey, setFirstKey] = useState<string | null>(null);
  let start = 0;
  if (shown.length > 0) {
    if (firstKey === null) {
      start = batchStart(shown, shown.length);
      setFirstKey(rowKey(shown[start]!));
    } else {
      start = Math.max(0, shown.findIndex((row) => rowKey(row) === firstKey));
    }
  }
  const ready = markdownReady && shown.length > 0;
  const olderLeft = ready && start > 0;

  const shownRef = useRef(shown);
  useLayoutEffect(() => {
    shownRef.current = shown;
  });
  /** Render the next older batch (or all of them). */
  const revealOlder = useCallback((all = false) => {
    setFirstKey((key) => {
      const rows = shownRef.current;
      const at = rows.findIndex((row) => rowKey(row) === key);
      return at > 0 ? rowKey(rows[all ? 0 : batchStart(rows, at)]!) : key;
    });
  }, []);

  // Older batches render one after another while the browser is idle (paused while the chat is hidden).
  useEffect(() => {
    if (!olderLeft) return;
    return whenIdle(() => startTransition(() => revealOlder()));
  }, [olderLeft, start, revealOlder]);

  // …and right away when the user scrolls up near them (re-armed after each batch, which moves the sentinel).
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!olderLeft || !sentinel || !root) return;
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && revealOlder(), {
      root,
      rootMargin: "1200px 0px 0px 0px",
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [olderLeft, start, revealOlder, scrollRef]);

  // Find in page (⌘F / Ctrl+F) searches the whole chat: render the rest now.
  useEffect(() => {
    if (!olderLeft) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f") revealOlder(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [olderLeft, revealOlder]);

  // Without scroll anchoring, keep what's on screen in place when older rows come in above it (unless pinned to the bottom).
  const firstRowRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ row: HTMLElement; top: number } | null>(null);
  useLayoutEffect(() => {
    if (anchoring) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const offset = (row: HTMLElement) => row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const previous = anchor.current;
    if (previous?.row.isConnected && !stuck.current) {
      const moved = offset(previous.row) - previous.top;
      if (moved) scroller.scrollTop += moved;
    }
    const row = firstRowRef.current;
    anchor.current = row ? { row, top: offset(row) } : null;
  }, [start, ready, scrollRef, stuck]);

  // Between "sent" and the run's first event there is no assistant message yet.
  const awaitingReply = run ? !run.messageId : sending;
  const lastAssistantId = messages.findLast((m) => m.role === "assistant")?.id;
  // A long chat folds its older turns' work, so their answers read one after another; the latest turn stays open
  // (a reply, not a notice TOT posted after it).
  const { foldOlder, latestReplyId } = useMemo(() => {
    const replies = messages.filter((m) => m.role === "assistant" && m.parts.some((part) => part.type !== "notice"));
    return { foldOlder: replies.length >= FOLD_FROM, latestReplyId: replies.at(-1)?.id };
  }, [messages]);
  const loading = messages.length === 0 ? loadState === "loading" : !markdownReady;

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="h-full overflow-y-auto overscroll-contain">
        <div ref={contentRef} className={`mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 pb-10 sm:px-6 ${topPadding}`}>
          {loading && (
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

          {ready && <ForkedFrom conversationId={conversationId} />}

          {messages.length === 0 && loadState === "ready" && task && !awaitingReply && <TaskEmptyState task={task} />}

          {olderLeft && <div ref={sentinelRef} aria-hidden="true" className="h-px [overflow-anchor:none]" />}

          {ready &&
            shown.slice(start).map((row, index) => (
              <div
                key={rowKey(row)}
                ref={index === 0 ? firstRowRef : undefined}
                className={rowClass(row, start + index >= shown.length - ALWAYS_RENDERED, foldOlder && !Array.isArray(row) && row.id !== latestReplyId)}
              >
                {Array.isArray(row) ? (
                  <TaskNotices messages={row} conversationId={conversationId} />
                ) : row.role === "user" ? (
                  <UserMessage message={row} inChat={inChat} />
                ) : (
                  <AssistantMessage
                    message={row}
                    notes={notesByReply.get(row.id)}
                    live={run?.messageId === row.id}
                    justFinished={justFinished && row.id === lastAssistantId}
                    isLatest={row.id === lastAssistantId}
                    agentName={agentName}
                    models={models}
                    inChat={inChat}
                    folded={foldOlder && row.id !== latestReplyId}
                  />
                )}
              </div>
            ))}

          {awaitingReply && <ThinkingIndicator agentName={agentName} />}

        </div>
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-linear-to-t from-canvas to-transparent"
      />

      <QuoteSelection root={contentRef} scroller={scrollRef} />

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
