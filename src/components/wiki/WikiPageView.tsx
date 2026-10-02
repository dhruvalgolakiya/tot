import { useRef, useState, type RefObject } from "react";
import clsx from "clsx";
import { DropdownMenu } from "radix-ui";
import { ArrowUp, Ellipsis, History, LoaderCircle, Pencil, Trash } from "lucide-react";
import type { WikiPage } from "@shared/types";
import { DEFAULT_ACCENT } from "../../hooks/useAgentAccent";
import { api } from "../../lib/api";
import { isLightColor } from "../../lib/color";
import { relativeTime } from "../../lib/format";
import { navigateToConversation, notifyError, selectActiveAgent, sendMessage, useStore } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { LazyMarkdown } from "../LazyMarkdown";
import { IconButton } from "../ui/IconButton";
import { WikiHistoryDialog } from "./WikiHistoryDialog";
import { WikiPageEditor } from "./WikiPageEditor";

type WikiPageViewProps = {
  page: WikiPage;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** The page changed (saved from the editor, or restored from history) — refresh it in the tree/view. */
  onChanged: (page: WikiPage) => void;
  onDeleted: () => void;
  contentRef: RefObject<HTMLDivElement | null>;
};

/** The open page: title, meta line, "…" actions, rendered content (or its inline editor), and an Ask box. */
export function WikiPageView({ page, editing, onEditingChange, onChanged, onDeleted, contentRef }: WikiPageViewProps) {
  const agent = useStore(selectActiveAgent);
  const agentName = agent?.name ?? "TOT";
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Deferred like ConversationItem's menu: a closing Radix menu re-focuses itself
  // and would otherwise steal focus from the dialog it just opened.
  const pendingAction = useRef<"history" | "delete" | null>(null);

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.deleteWikiPage(page.id);
      onDeleted();
    } catch (error) {
      notifyError(error);
      setDeleting(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8">
          {editing ? (
            <WikiPageEditor
              page={page}
              onSaved={(saved) => {
                onChanged(saved);
                onEditingChange(false);
              }}
              onCancel={() => onEditingChange(false)}
            />
          ) : (
            <>
              <div className="flex items-start justify-between gap-3">
                <h1 className="min-w-0 text-2xl font-semibold tracking-[-0.01em] text-fg-strong sm:text-display">
                  {page.title}
                </h1>
                <DropdownMenu.Root modal={false}>
                  <DropdownMenu.Trigger asChild>
                    <IconButton label={`Actions for ${page.title}`} className="mt-0.5 shrink-0">
                      <Ellipsis />
                    </IconButton>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="end"
                      sideOffset={4}
                      className="menu w-44"
                      onCloseAutoFocus={(event) => {
                        const action = pendingAction.current;
                        pendingAction.current = null;
                        if (!action) return;
                        event.preventDefault();
                        if (action === "history") setHistoryOpen(true);
                        else setConfirmingDelete(true);
                      }}
                    >
                      <DropdownMenu.Item className="menu-item" onSelect={() => onEditingChange(true)}>
                        <Pencil className="size-4 text-fg-muted" /> Edit
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        className="menu-item"
                        onSelect={() => {
                          pendingAction.current = "history";
                        }}
                      >
                        <History className="size-4 text-fg-muted" /> History
                      </DropdownMenu.Item>
                      {!page.pinned && (
                        <>
                          <DropdownMenu.Separator className="menu-separator" />
                          <DropdownMenu.Item
                            className="menu-item menu-item-danger"
                            onSelect={() => {
                              pendingAction.current = "delete";
                            }}
                          >
                            <Trash className="size-4" /> Delete
                          </DropdownMenu.Item>
                        </>
                      )}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>

              {page.summary && <p className="mt-1.5 text-sm text-fg-muted">{page.summary}</p>}
              <PageMeta page={page} agentName={agentName} />

              <div ref={contentRef} className="mt-6">
                <LazyMarkdown text={page.content || "*Nothing here yet.*"} />
              </div>
            </>
          )}
        </div>
      </div>

      {!editing && (
        <div className="shrink-0 px-3 pb-3 sm:px-4">
          <div className="mx-auto w-full max-w-3xl">
            <AskBox agentName={agentName} pageTitle={page.title} />
          </div>
        </div>
      )}

      <WikiHistoryDialog
        page={page}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onRestored={(restored) => onChanged(restored)}
      />
      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title="Delete page?"
        description={
          <>
            This deletes <span className="font-medium text-fg">{page.title}</span>. Its sub-pages move up a
            level. This can't be undone.
          </>
        }
        confirmLabel={deleting ? "Deleting…" : "Delete"}
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}

function PageMeta({ page, agentName }: { page: WikiPage; agentName: string }) {
  const when = relativeTime(page.updatedAt);
  return (
    <p className="mt-3 text-xs text-fg-subtle">
      Updated {when}{" "}
      {page.updatedBy === "user" ? (
        "by you"
      ) : page.updatedBy === "agent" ? (
        `by ${agentName}`
      ) : page.conversationId ? (
        <button
          type="button"
          onClick={() => navigateToConversation(page.conversationId!)}
          className="underline decoration-dotted underline-offset-2 transition-colors hover:text-fg-muted"
        >
          after a chat
        </button>
      ) : (
        "after a chat"
      )}
    </p>
  );
}

/** A small composer pinned under the page: asks the agent about it in a new chat. */
function AskBox({ agentName, pageTitle }: { agentName: string; pageTitle: string }) {
  const agent = useStore(selectActiveAgent);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const accent = agent?.mascot.color ?? DEFAULT_ACCENT;
  const sendForeground = isLightColor(accent) ? "#0a0a0c" : "#fdfdfd";
  const canSend = text.trim().length > 0 && !sending;

  async function submit() {
    const question = text.trim();
    if (!question || sending) return;
    setSending(true);
    const ok = await sendMessage(`About the wiki page “${pageTitle}”: ${question}`);
    setSending(false);
    if (ok) setText("");
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="surface-raised accent-focus flex items-center gap-1 rounded-full py-1.5 pr-1.5 pl-4"
    >
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={`Ask ${agentName} about this…`}
        aria-label={`Ask ${agentName} about this page`}
        className="h-8 min-w-0 flex-1 bg-transparent text-chat text-fg outline-none placeholder:text-fg-subtle"
      />
      <button
        type="submit"
        disabled={!canSend}
        aria-label="Ask"
        style={canSend ? { background: "var(--agent-accent)", color: sendForeground } : undefined}
        className={clsx("grid size-8 shrink-0 place-items-center rounded-full transition-colors", !canSend && "bg-fill-strong text-fg-subtle")}
      >
        {sending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" strokeWidth={2.25} />}
      </button>
    </form>
  );
}
