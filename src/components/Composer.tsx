import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import clsx from "clsx";
import { ArrowUp, Lightbulb, LoaderCircle, MessageSquare, Plus, Square } from "lucide-react";
import type { UseAttachments } from "../hooks/useAttachments";
import { CHAT_DRAG_TYPE, chatMatches, MAX_ATTACHED_CHATS, mentionAt } from "../lib/attached-chats";
import { isSteerable, isTask } from "../lib/tasks";
import {
  clearComposerDraft,
  selectActiveAgent,
  selectActiveAgentId,
  selectCurrentConversation,
  sendMessage,
  steerTask,
  stopRun,
  useStore,
} from "../store";
import { AttachmentChip } from "./AttachmentChip";
import { ChatChip } from "./ChatChip";
import { Tip } from "./ui/Tip";
import { VoiceInputButton } from "./voice";

const MAX_HEIGHT_PX = 200;
// Phones and tablets: Enter inserts a newline, the button sends.
const touchOnly = () => window.matchMedia("(pointer: coarse)").matches;

const pill =
  "flex h-9 items-center gap-1.5 rounded-full px-3 text-ui font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg aria-pressed:bg-selected aria-pressed:text-fg";

/** `placeholder` replaces "Ask <agent> anything" for a new chat, e.g. "New chat in web…" on a project's page. */
export function Composer({ attachments, placeholder: newChatPlaceholder }: { attachments: UseAttachments; placeholder?: string }) {
  const currentId = useStore((s) => s.currentId);
  const run = useStore((s) => (s.currentId ? s.activeRuns[s.currentId] : undefined));
  const sending = useStore((s) => s.sending);
  const agent = useStore(selectActiveAgent);
  const agentId = useStore(selectActiveAgentId);
  const conversation = useStore(selectCurrentConversation);
  const task = isTask(conversation) ? conversation.task : null;
  // In a task that's working, the composer adds notes to it ("steering") instead of starting turns.
  const steering = Boolean(task && isSteerable(task));
  const [text, setText] = useState("");
  // The in-progress (not-yet-final) speech recognition guess, shown as a quiet
  // preview under the textarea — never merged into `text` until it finalizes,
  // so it can't clobber anything the user has typed.
  const [interim, setInterim] = useState("");
  const [thinkHarder, setThinkHarder] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // A message sent from a project's page that failed once its chat had opened: put its text back here.
  const draft = useStore((s) => s.composerDraft);
  useEffect(() => {
    if (draft === null) return;
    setText((current) => current || draft);
    clearComposerDraft();
  }, [draft]);

  // Other chats attached as reference: picked by typing @, or dragged in from the sidebar.
  const conversations = useStore((s) => s.conversations);
  const [contextChats, setContextChats] = useState<string[]>([]);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [chatOver, setChatOver] = useState(false);
  useEffect(() => setContextChats([]), [currentId]);
  const canAttachChats = !task;
  const mention = canAttachChats && contextChats.length < MAX_ATTACHED_CHATS ? mentionAt(text, caret) : null;
  const matches =
    mention && mention.start !== dismissedAt
      ? chatMatches(conversations, { agentId, exclude: [...contextChats, ...(currentId ? [currentId] : [])], query: mention.query })
      : [];
  const picking = matches.length > 0;
  useEffect(() => setHighlight(0), [mention?.query]);
  const attachChat = (id: string) =>
    setContextChats((list) => (list.includes(id) || id === currentId || list.length >= MAX_ATTACHED_CHATS ? list : [...list, id]));

  /** Swaps the "@query" being typed for a chip. */
  function pickChat(id: string) {
    if (!mention) return;
    const before = text.slice(0, mention.start);
    setText(`${before}${text.slice(caret)}`);
    attachChat(id);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(before.length, before.length);
      setCaret(before.length);
    });
  }
  const canSend = steering
    ? text.trim().length > 0 && attachments.items.length === 0
    : (text.trim().length > 0 || attachments.ready.length > 0) && !run && !sending && !attachments.uploading;
  const agentName = agent?.name ?? "TOT";
  const placeholder = steering
    ? "Steer this task…"
    : task?.status === "needs-input"
      ? "Answer the task…"
      : task
        ? "Reply to pick this task up again…"
        : (newChatPlaceholder ?? `Ask ${agentName} anything`);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  useEffect(() => {
    if (!touchOnly()) inputRef.current?.focus();
  }, []);

  async function submit() {
    if (!canSend) return;
    const value = text;
    if (steering && currentId) {
      setText("");
      setInterim("");
      if (!(await steerTask(currentId, value))) setText((current) => current || value);
      return;
    }
    const harder = thinkHarder;
    const files = attachments.ready.map((it) => it.attachment);
    const previousItems = attachments.items;
    const chats = contextChats;
    setText("");
    setInterim("");
    setThinkHarder(false); // "Think harder" applies to one message only.
    setContextChats([]);
    attachments.clear();
    const sent = await sendMessage(value, { thinkHarder: harder, attachments: files, contextChats: chats });
    if (!sent) {
      setContextChats(chats);
      setText((current) => current || value);
      setThinkHarder(harder);
      attachments.restore(previousItems);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // The @ chat picker takes the arrows, Enter / Tab and Escape while it's open.
    if (picking) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((current) => (current + step + matches.length) % matches.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        event.preventDefault();
        pickChat(matches[Math.min(highlight, matches.length - 1)]!.id);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedAt(mention!.start);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (touchOnly()) return;
    event.preventDefault();
    void submit();
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    attachments.addFiles(files);
  }

  function onTranscript(chunk: string, isFinal: boolean) {
    if (!isFinal) {
      setInterim(chunk);
      return;
    }
    setInterim("");
    const clean = chunk.trim();
    if (!clean) return;
    setText((current) => (current && !/\s$/.test(current) ? `${current} ${clean}` : `${current}${clean}`));
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onDragOver={(event) => {
        if (!canAttachChats || !event.dataTransfer.types.includes(CHAT_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setChatOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setChatOver(false);
      }}
      onDrop={(event) => {
        const id = event.dataTransfer.getData(CHAT_DRAG_TYPE);
        if (!id) return;
        event.preventDefault();
        setChatOver(false);
        attachChat(id);
      }}
      className={clsx(
        "surface-raised relative min-h-[60px] rounded-3xl border transition-colors focus-within:border-edge-strong",
        chatOver ? "border-accent-edge" : "border-edge",
      )}
    >
      {picking && (
        <div role="listbox" aria-label="Attach a chat" className="menu absolute bottom-full left-0 mb-2 w-80 max-w-full">
          <p className="menu-label">Attach a chat for reference</p>
          {matches.map((chat, index) => (
            <div
              key={chat.id}
              role="option"
              aria-selected={index === highlight}
              data-highlighted={index === highlight ? "" : undefined}
              onMouseDown={(event) => {
                event.preventDefault();
                pickChat(chat.id);
              }}
              onMouseEnter={() => setHighlight(index)}
              className="menu-item"
            >
              <MessageSquare className="size-4 shrink-0 text-fg-muted" />
              <span className="min-w-0 flex-1 truncate">{chat.title}</span>
            </div>
          ))}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          attachments.addFiles(event.target.files);
          event.target.value = "";
        }}
      />
      {(attachments.items.length > 0 || contextChats.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3.5">
          {contextChats.map((id) => (
            <ChatChip key={id} conversationId={id} onRemove={() => setContextChats((list) => list.filter((other) => other !== id))} />
          ))}
          {attachments.items.map((item) => (
            <AttachmentChip key={item.localId} item={item} onRemove={attachments.removeAttachment} />
          ))}
        </div>
      )}
      <label htmlFor="composer-input" className="sr-only">
        {steering ? "Note for the task" : `Message ${agentName}`}
      </label>
      <textarea
        id="composer-input"
        ref={inputRef}
        rows={1}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setCaret(event.target.selectionStart);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={placeholder}
        className="block max-h-[200px] w-full resize-none overflow-y-auto bg-transparent px-4 pt-4 pb-1 text-chat text-fg outline-none placeholder:text-fg-subtle"
      />
      {interim.trim() && (
        <p aria-live="polite" className="truncate px-4 pb-1 text-ui text-fg-subtle italic">
          {interim}
        </p>
      )}
      <div className="flex items-center gap-1.5 px-3 pt-1 pb-3">
        {!steering && (
          <Tip content="Attach files">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach files"
              className="flex size-9 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <Plus className="size-4" />
            </button>
          </Tip>
        )}
        <VoiceInputButton onTranscript={onTranscript} />
        {!steering && (
          <Tip content="Use the strongest model with extra effort, for your next message only">
            <button type="button" aria-pressed={thinkHarder} onClick={() => setThinkHarder((value) => !value)} className={pill}>
              <Lightbulb className="size-3.5" />
              <span className="hidden sm:inline">Think harder</span>
            </button>
          </Tip>
        )}

        <div className="ml-auto">
          {run && currentId && !steering ? (
            <Tip content="Stop">
              <button
                type="button"
                onClick={() => void stopRun(currentId)}
                disabled={run.stopping}
                aria-label="Stop"
                className="grid size-9 place-items-center rounded-full bg-fg text-canvas transition-colors hover:bg-fg/90 disabled:opacity-50"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            </Tip>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              aria-label={steering ? "Send note" : "Send"}
              className={clsx(
                "grid size-9 place-items-center rounded-full transition-colors",
                canSend ? "bg-fg text-canvas hover:bg-fg/90" : "bg-fill-strong text-fg-faint",
              )}
            >
              {sending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-[18px]" strokeWidth={2.25} />}
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
