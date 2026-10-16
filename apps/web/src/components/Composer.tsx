import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import clsx from "clsx";
import { ArrowUp, Columns2, LoaderCircle, MessageSquare, Plus, Square, SquareSlash } from "lucide-react";
import type { Conversation } from "@tot/shared/types";
import type { UseAttachments } from "../hooks/useAttachments";
import { CHAT_DRAG_TYPE, chatMatches, MAX_ATTACHED_CHATS, mentionAt } from "../lib/attached-chats";
import { bestOfLabel, bestOfProviders, newRequestId, parseSlash, SLASH_COMMANDS, type SlashCommandName } from "../lib/mission";
import { skillMatches, slashWordAt, typedSkill } from "../lib/skills";
import { isSteerable, isTask } from "../lib/tasks";
import {
  clearComposerDraft,
  loadSkills,
  selectActiveAgent,
  selectActiveAgentId,
  selectCurrentConversation,
  sendMessage,
  startBestOf,
  steerTask,
  stopRun,
  useStore,
} from "../store";
import { AttachmentChip } from "./AttachmentChip";
import { ChatChip } from "./ChatChip";
import { ProjectPicker } from "./projects/ProjectPicker";
import { WorkspacePicker } from "./projects/WorkspacePicker";
import { Tip } from "./ui/Tip";
import { VoiceInputButton } from "./voice";

const MAX_HEIGHT_PX = 240;
// Phones and tablets: Enter inserts a newline, the button sends.
const touchOnly = () => window.matchMedia("(pointer: coarse)").matches;

const SLASH_ICONS: Record<SlashCommandName, typeof Columns2> = { "best-of": Columns2 };

const NO_CONVERSATIONS: Conversation[] = [];

/** A row of the "/" menu: a command (/best-of) or a skill. */
type SlashItem = { kind: "command"; name: SlashCommandName; description: string } | { kind: "skill"; name: string; description: string };

/**
 * `placeholder` replaces "Ask <agent> anything" for a new chat, e.g. "New chat in web…" on a project's page.
 * The agent (or a project's Lead) decides on its own when work needs a task; this box is just chat, plus
 * `/best-of` to run a couple of attempts and compare, and skills ("/dh-stack fix the cart") to run a message with.
 */
export function Composer({
  attachments,
  placeholder: newChatPlaceholder,
}: {
  attachments: UseAttachments;
  placeholder?: string;
}) {
  const currentId = useStore((s) => s.currentId);
  const onProjectPage = useStore((s) => s.page === "project");
  // The project a chat not sent yet starts in: the project page's, or the one picked.
  const draftProject = useStore((s) => (s.page === "project" ? s.projectId : s.draftProjectId));
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
  // The "/" menu: /best-of and skills, while the message's first word is being typed.
  const [slashHighlight, setSlashHighlight] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  /** The last best-of start's text and request id: sending the same text again after a failure reuses the id, so it starts once. */
  const pendingRequest = useRef<{ text: string; id: string } | null>(null);
  const providers = useStore((s) => s.providers);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const slashListRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // A message sent from a project's page that failed once its chat had opened: put its text back here.
  const draft = useStore((s) => s.composerDraft);
  useEffect(() => {
    if (draft === null) return;
    setText((current) => current || draft);
    clearComposerDraft();
  }, [draft]);

  // Other chats attached as reference: picked by typing @, or dragged in from the sidebar.
  const [contextChats, setContextChats] = useState<string[]>([]);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [chatOver, setChatOver] = useState(false);
  useEffect(() => setContextChats([]), [currentId]);
  // /best-of and skills are for chats, project pages and home; a task's composer steers or replies.
  const command = task ? null : parseSlash(text);
  const slashWord = task ? null : slashWordAt(text, caret);
  const slashOpen = slashWord !== null && text !== slashDismissed;
  // Skills load the first time the menu opens.
  const skills = useStore((s) => s.skills);
  useEffect(() => {
    if (slashOpen) void loadSkills();
  }, [slashOpen]);
  const slashItems: SlashItem[] = slashOpen
    ? [
        ...SLASH_COMMANDS.filter((c) => c.name.startsWith(slashWord.query.toLowerCase())).map((c) => ({ kind: "command" as const, ...c })),
        ...skillMatches(skills ?? [], slashWord.query).map((skill) => ({ kind: "skill" as const, name: skill.name, description: skill.description })),
      ]
    : [];
  const slashing = slashItems.length > 0;
  const noSkills = slashOpen && !slashing && skills !== null;
  useEffect(() => setSlashHighlight(0), [slashWord?.query]);
  useEffect(() => {
    slashListRef.current?.querySelector("[data-highlighted]")?.scrollIntoView({ block: "nearest" });
  }, [slashHighlight]);
  const bestOf = bestOfProviders(providers);
  // This message, once sent, starts a best-of run instead of a reply.
  const sendsBestOf = !task && command !== null;
  const canAttachChats = !task && !sendsBestOf;
  const mention = canAttachChats && contextChats.length < MAX_ATTACHED_CHATS ? mentionAt(text, caret) : null;
  // The chats to pick from, read only while an @ is being typed (not a re-render on every change to the list).
  const conversations = useStore((s) => (mention ? s.conversations : NO_CONVERSATIONS));
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
  const hasText = command ? command.body.length > 0 : text.trim().length > 0;
  const canSend = steering
    ? text.trim().length > 0 && attachments.items.length === 0
    : slashing
      ? false
      : sendsBestOf
        ? hasText && attachments.items.length === 0 && !run && !sending
        : (hasText || attachments.ready.length > 0) && !run && !sending && !attachments.uploading;
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
    const value = text;
    if (steering && currentId) {
      if (!canSend) return;
      setText("");
      setInterim("");
      if (!(await steerTask(currentId, value))) setText((current) => current || value);
      return;
    }
    // Still picking a command in the slash menu.
    if (slashing) return;
    if (sendsBestOf && command) {
      const goal = command.body;
      if (!goal || run || sending || attachments.items.length > 0) return;
      const requestId = pendingRequest.current?.text === value ? pendingRequest.current.id : newRequestId();
      pendingRequest.current = { text: value, id: requestId };
      setText("");
      setInterim("");
      const started = await startBestOf(goal, requestId);
      if (started) pendingRequest.current = null;
      else setText((current) => current || value);
      return;
    }
    if (!canSend) return;
    const message = value;
    const files = attachments.ready.map((it) => it.attachment);
    const previousItems = attachments.items;
    const chats = contextChats;
    setText("");
    setInterim("");
    setContextChats([]);
    attachments.clear();
    const sent = await sendMessage(message, { attachments: files, contextChats: chats, skill: typedSkill(skills, message) });
    if (!sent) {
      setContextChats(chats);
      setText((current) => current || value);
      attachments.restore(previousItems);
    }
  }

  /** Swaps the first word being typed for the whole name and a space: "/be" → "/best-of ", "/dh fix it" → "/dh-stack fix it". */
  function pickSlash(name: string) {
    const head = `/${name} `;
    setText(head + (slashWord ? text.slice(slashWord.end).trimStart() : ""));
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(head.length, head.length);
      setCaret(head.length);
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // The slash menu takes the arrows, Enter / Tab and Escape while it's open.
    if (slashing && !event.metaKey && !event.ctrlKey) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSlashHighlight((current) => (current + step + slashItems.length) % slashItems.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        event.preventDefault();
        pickSlash(slashItems[Math.min(slashHighlight, slashItems.length - 1)]!.name);
        return;
      }
    }
    if ((slashing || noSkills) && event.key === "Escape") {
      event.preventDefault();
      setSlashDismissed(text);
      return;
    }
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
    // A best-of run starts from text only.
    if (files.length === 0 || sendsBestOf) return;
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
      {(slashing || noSkills) && (
        <div
          ref={slashListRef}
          role="listbox"
          aria-label="Commands and skills"
          className="menu absolute bottom-full left-0 mb-2 max-h-80 w-96 max-w-full overflow-y-auto"
        >
          {slashItems.map((item, index) => {
            const Icon = item.kind === "command" ? SLASH_ICONS[item.name] : SquareSlash;
            const description =
              item.kind === "command" && item.name === "best-of" && bestOf.length ? `On ${bestOfLabel(bestOf)}, then compare` : item.description;
            const firstSkill = item.kind === "skill" && slashItems[index - 1]?.kind !== "skill";
            return (
              <Fragment key={`${item.kind}:${item.name}`}>
                {firstSkill && <p className="menu-label">Skills</p>}
                <div
                  role="option"
                  aria-selected={index === slashHighlight}
                  data-highlighted={index === slashHighlight ? "" : undefined}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pickSlash(item.name);
                  }}
                  onMouseEnter={() => setSlashHighlight(index)}
                  className="menu-item"
                >
                  <Icon className="size-4 shrink-0 text-fg-muted" />
                  <span className="max-w-[60%] shrink-0 truncate font-medium">/{item.name}</span>
                  <span className="min-w-0 flex-1 truncate text-fg-subtle">{description}</span>
                </div>
              </Fragment>
            );
          })}
          {noSkills && (
            <>
              <p className="menu-label">Skills</p>
              <p className="px-2 pt-0.5 pb-2 text-fg-subtle">No skills found</p>
            </>
          )}
        </div>
      )}
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
        className="block min-h-[76px] max-h-[240px] w-full resize-none overflow-y-auto bg-transparent px-4 pt-4 pb-1 text-chat text-fg outline-none placeholder:text-fg-subtle"
      />
      {interim.trim() && (
        <p aria-live="polite" className="truncate px-4 pb-1 text-ui text-fg-subtle italic">
          {interim}
        </p>
      )}
      <div className="flex items-center gap-1.5 px-3 pt-1 pb-3">
        {!steering && !sendsBestOf && (
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
        {/* A chat not sent yet, from an agent's home: the project it starts in. */}
        {!currentId && !onProjectPage && <ProjectPicker />}
        {/* …and in a project with code, whether it works in the main checkout or a new worktree. */}
        {!currentId && <WorkspacePicker projectId={draftProject} />}

        <div className="ml-auto flex min-w-0 items-center gap-2">
          {/* What /best-of will do, e.g. "Best of 2 · Claude and ChatGPT". */}
          {command && (
            <span className="hidden truncate text-xs text-fg-subtle sm:inline">
              {`Best of ${bestOf.length || 2}${bestOf.length ? ` · ${bestOfLabel(bestOf)}` : ""}`}
            </span>
          )}
          {run && currentId && !steering ? (
            <Tip content="Stop">
              <button
                type="button"
                onClick={() => void stopRun(currentId)}
                disabled={run.stopping}
                aria-label="Stop"
                className="grid size-9 shrink-0 place-items-center rounded-full bg-fg text-canvas transition-colors hover:bg-fg/90 disabled:opacity-50"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            </Tip>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              aria-label={steering ? "Send note" : sendsBestOf ? "Start best of" : "Send"}
              className={clsx(
                "grid size-9 shrink-0 place-items-center rounded-full transition-colors",
                canSend ? "bg-fg text-canvas hover:bg-fg/90" : "bg-fill-strong text-fg-muted",
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
