import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import clsx from "clsx";
import { ArrowUp, Lightbulb, ListChecks, LoaderCircle, Plus, Square } from "lucide-react";
import type { UseAttachments } from "../hooks/useAttachments";
import { isSteerable, isTask } from "../lib/tasks";
import { selectActiveAgent, selectActiveAgentId, selectCurrentConversation, sendMessage, startTask, steerTask, stopRun, useStore } from "../store";
import { AttachmentChip } from "./AttachmentChip";
import { RepoChip } from "./tasks/RepoPicker";
import { Kbd } from "./ui/Kbd";
import { Tip } from "./ui/Tip";
import { VoiceInputButton } from "./voice";

const MAX_HEIGHT_PX = 200;
// Phones and tablets: Enter inserts a newline, the button sends.
const touchOnly = () => window.matchMedia("(pointer: coarse)").matches;

const pill =
  "flex h-9 items-center gap-1.5 rounded-full px-3 text-ui font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg aria-pressed:bg-selected aria-pressed:text-fg";

export function Composer({ attachments }: { attachments: UseAttachments }) {
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
  // "Run as task" (or ⌘↩): the message becomes a task, working in a repo when one is picked.
  const [asTask, setAsTask] = useState(false);
  const [repo, setRepo] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const taskMode = asTask && !task;
  const canSend = steering
    ? text.trim().length > 0 && attachments.items.length === 0
    : (text.trim().length > 0 || attachments.ready.length > 0) && !run && !sending && !attachments.uploading;
  const canStartTask = !task && text.trim().length > 0 && attachments.items.length === 0 && !run && !sending;
  const ready = taskMode ? canStartTask : canSend;
  const agentName = agent?.name ?? "TOT";
  const placeholder = steering
    ? "Steer this task…"
    : task?.status === "needs-input"
      ? "Answer the task…"
      : task
        ? "Reply to pick this task up again…"
        : taskMode
          ? "Describe the task…"
          : `Ask ${agentName} anything`;

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  useEffect(() => {
    if (!touchOnly()) inputRef.current?.focus();
  }, []);

  async function submit(mode: "message" | "task" = taskMode ? "task" : "message") {
    if (mode === "task") {
      await submitTask();
      return;
    }
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
    setText("");
    setInterim("");
    setThinkHarder(false); // "Think harder" applies to one message only.
    attachments.clear();
    const sent = await sendMessage(value, { thinkHarder: harder, attachments: files });
    if (!sent) {
      setText((current) => current || value);
      setThinkHarder(harder);
      attachments.restore(previousItems);
    }
  }

  async function submitTask() {
    if (!canStartTask) return;
    const value = text;
    setText("");
    setInterim("");
    if (await startTask(value, { repo })) {
      setAsTask(false);
      setRepo("");
    } else {
      setText((current) => current || value);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    // ⌘↩ / Ctrl+↩ runs it as a task.
    if ((event.metaKey || event.ctrlKey) && !task) {
      event.preventDefault();
      void submit("task");
      return;
    }
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
      className="surface-raised min-h-[60px] rounded-3xl border border-edge transition-colors focus-within:border-edge-strong"
    >
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
      {attachments.items.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pt-3.5">
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
        onChange={(event) => setText(event.target.value)}
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
        {!steering && !taskMode && (
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
        {!steering && !taskMode && (
          <Tip content="Use the strongest model with extra effort, for your next message only">
            <button type="button" aria-pressed={thinkHarder} onClick={() => setThinkHarder((value) => !value)} className={pill}>
              <Lightbulb className="size-3.5" />
              <span className="hidden sm:inline">Think harder</span>
            </button>
          </Tip>
        )}
        {!task && (
          <Tip
            content={
              <span className="flex items-center gap-2">
                Works in the background until it's done <Kbd keys={["mod", "↩"]} />
              </span>
            }
          >
            <button type="button" aria-pressed={asTask} onClick={() => setAsTask((value) => !value)} className={pill}>
              <ListChecks className="size-3.5" />
              <span className={clsx(!asTask && "hidden sm:inline")}>Run as task</span>
            </button>
          </Tip>
        )}
        {taskMode && <RepoChip agentId={agentId} value={repo} onChange={setRepo} />}

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
              disabled={!ready}
              aria-label={steering ? "Send note" : taskMode ? "Start task" : "Send"}
              className={clsx(
                "grid size-9 place-items-center rounded-full transition-colors",
                ready ? "bg-fg text-canvas hover:bg-fg/90" : "bg-fill-strong text-fg-faint",
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
