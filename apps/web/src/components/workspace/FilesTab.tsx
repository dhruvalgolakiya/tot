import { useCallback, useEffect, useReducer, useState } from "react";
import { FolderOpen, Search } from "lucide-react";
import type { Conversation } from "@tot/shared/types";
import type { WorkspaceFiles, WorkspaceInfo } from "@tot/shared/workspace";
import { errorMessage } from "../../lib/api";
import { useWorkspacePanel, workspaceApi } from "../../lib/workspace";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { Kbd } from "../ui/Kbd";
import { Modal, ModalFooter } from "../ui/Modal";
import { Skeleton } from "../ui/Skeleton";
import { Tip } from "../ui/Tip";
import { FileTree } from "./FileTree";
import { dropDraft, FileView, hasDraft } from "./FileView";
import { QuickOpen } from "./QuickOpen";
import { SearchView } from "./SearchView";
import { useWorkspaceRefresh } from "./useWorkspaceRefresh";

type Target = { path: string; line?: number; nonce: number };
type Loaded = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; value: WorkspaceFiles };

/** The file each chat had open, so coming back to the tab (or the chat) shows it again. */
const lastOpen = new Map<string, Target>();
let nonce = 0;

/**
 * The chat folder's files: a tree (what git ignores left out) or a search through them (⌘⇧F) on the left, the
 * open file on the right, and ⌘P to jump to any file by name. Opening another file while one has unsaved edits
 * asks first; kept edits stay as a draft, marked in the tree.
 */
export function FilesTab({ chat, info }: { chat: Conversation; info: WorkspaceInfo }) {
  const [files, setFiles] = useState<Loaded>({ status: "loading" });
  const [target, setTarget] = useState<Target | null>(() => lastOpen.get(chat.id) ?? null);
  const [mode, setMode] = useState<"tree" | "search">("tree");
  const [quickOpen, setQuickOpen] = useState(false);
  const [pending, setPending] = useState<Omit<Target, "nonce"> | null>(null);
  const [version, setVersion] = useState(0);
  const [, redraw] = useReducer((count: number) => count + 1, 0);

  const load = useCallback(async () => {
    try {
      setFiles({ status: "ready", value: await workspaceApi.files(chat.id) });
    } catch (error) {
      setFiles((current) => (current.status === "ready" ? current : { status: "error", message: errorMessage(error) }));
    }
  }, [chat.id]);

  useEffect(() => void load(), [load]);
  useWorkspaceRefresh(chat.id, () => {
    void load();
    setVersion((current) => current + 1);
  });

  const show = useCallback(
    (path: string, line?: number) => {
      const next = { path, line, nonce: ++nonce };
      lastOpen.set(chat.id, next);
      setTarget(next);
    },
    [chat.id],
  );

  const open = useCallback(
    (path: string, line?: number) => {
      setQuickOpen(false);
      if (target && target.path !== path && hasDraft(chat.id, target.path)) setPending({ path, line });
      else show(path, line);
    },
    [chat.id, target, show],
  );

  // ⌘P, ⌘⇧F, or a file to show, asked for elsewhere (askFiles).
  const intent = useWorkspacePanel((s) => (s.filesIntent?.chatId === chat.id ? s.filesIntent : null));
  useEffect(() => {
    if (!intent) return;
    if (intent.kind === "quick-open") setQuickOpen(true);
    else if (intent.kind === "search") setMode("search");
    else open(intent.path, intent.line);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- each ask once, by its nonce.
  }, [intent?.nonce]);

  const paths = files.status === "ready" ? files.value.files : [];

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex w-[40%] max-w-64 min-w-40 shrink-0 flex-col border-r border-hairline">
        <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-hairline pr-1 pl-1.5">
          <button
            type="button"
            onClick={() => setQuickOpen(true)}
            className="flex h-7 min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-1.5 text-left text-ui text-fg-subtle transition-colors hover:bg-hover hover:text-fg-muted"
          >
            <span className="truncate">Go to file…</span>
            <Kbd keys={["mod", "P"]} />
          </button>
          <Tip
            content={
              <span className="flex items-center gap-2">
                {mode === "search" ? "Show files" : "Search in files"} {mode === "tree" && <Kbd keys={["mod", "shift", "F"]} />}
              </span>
            }
          >
            <IconButton size="sm" label={mode === "search" ? "Show files" : "Search in files"} aria-pressed={mode === "search"} onClick={() => setMode(mode === "search" ? "tree" : "search")}>
              <Search />
            </IconButton>
          </Tip>
        </div>
        {mode === "search" ? (
          <SearchView chatId={chat.id} onOpen={(path, line) => open(path, line)} />
        ) : files.status === "loading" ? (
          <div className="space-y-2 p-3" aria-busy="true" aria-label="Loading files">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3.5 w-3/4" />
          </div>
        ) : files.status === "error" ? (
          <p className="p-3 text-xs text-danger">{files.message}</p>
        ) : (
          <>
            <FileTree
              label="Files"
              paths={paths}
              selected={target?.path ?? null}
              onOpen={(path) => open(path)}
              expanded={false}
              trailing={(path) => (hasDraft(chat.id, path) ? <span aria-label="Unsaved changes" className="size-1.5 shrink-0 rounded-full bg-fg-muted" /> : null)}
              className="flex-1 py-1"
            />
            {files.value.truncated && <p className="shrink-0 border-t border-hairline px-3 py-2 text-xs text-fg-subtle">The first {paths.length.toLocaleString()} files are listed.</p>}
          </>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {target ? (
          <FileView key={target.path} chatId={chat.id} path={target.path} line={target.line} canWrite={info.canWrite} version={version} onDraft={redraw} />
        ) : (
          <EmptyState
            size="sm"
            icon={<FolderOpen />}
            title="Open a file"
            description={
              <span className="inline-flex items-center gap-1">
                Pick one on the left, or press <Kbd keys={["mod", "P"]} />
              </span>
            }
          />
        )}
      </div>
      {quickOpen && <QuickOpen paths={paths} onOpen={(path) => open(path)} onClose={() => setQuickOpen(false)} />}
      <Modal
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={`Keep your changes to ${target?.path.split("/").pop() ?? "this file"}?`}
        description="They aren't saved. Keep them as a draft to come back to, or discard them."
        className="max-w-sm"
      >
        <ModalFooter divider={false}>
          <Button variant="ghost" onClick={() => setPending(null)}>
            Cancel
          </Button>
          <Button
            variant="ghost-danger"
            onClick={() => {
              if (target) dropDraft(chat.id, target.path);
              if (pending) show(pending.path, pending.line);
              setPending(null);
            }}
          >
            Discard
          </Button>
          <Button
            variant="primary"
            autoFocus
            onClick={() => {
              if (pending) show(pending.path, pending.line);
              setPending(null);
            }}
          >
            Keep draft
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
}
